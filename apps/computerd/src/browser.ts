import { readFile, rename, writeFile } from "node:fs/promises";
import { capText, type BrowserInvocation, type ToolResult } from "@bots/protocol";
import { WebSocket } from "ws";

const REGION_WIDTH = 1280;
const REGION_HEIGHT = 800;
const SCREEN_COUNT = 8;
const CDP_CONNECT_TIMEOUT_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SETTLE_MS = 400;
const MAX_SETTLE_ROUNDS = 4;
const POPUP_OFFSET = 60;

const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
};

type Cdp = {
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;
  onEvent: (listener: (method: string, params: Record<string, unknown>) => void) => void;
};

export type CdpConnector = () => Promise<Cdp>;

// This runs in the page. It numbers what a bot can act on, and it never reads the value of a password field.
const SNAPSHOT_SCRIPT = `(() => {
  const MAX_TEXT = 120;
  const MAX_URL = 300;
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[role=tab],[contenteditable=true],[onclick]';
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (t) => (t ?? '').replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const label = (e) => clean(e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('alt') || e.innerText || e.getAttribute('name') || '');
  document.querySelectorAll('[data-bots-ref]').forEach((e) => e.removeAttribute('data-bots-ref'));
  let next = 1;
  const lines = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = clean(node.textContent);
      if (t !== '' && node.parentElement && visible(node.parentElement)) lines.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(e.tagName.toUpperCase())) return;
    if (e.matches(INTERACTIVE) && visible(e)) {
      const ref = next++;
      e.setAttribute('data-bots-ref', String(ref));
      const kind = e.getAttribute('role') || (e.tagName === 'INPUT' ? (e.getAttribute('type') || 'text') : e.tagName.toLowerCase());
      let value = '';
      if (e.tagName === 'SELECT') value = ' selected: ' + clean(e.options[e.selectedIndex]?.text);
      else if (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && !['password', 'checkbox', 'radio', 'submit', 'button', 'file'].includes((e.getAttribute('type') || 'text').toLowerCase()))) value = e.value ? ' value: ' + clean(e.value) : '';
      else if (e.tagName === 'INPUT' && (e.getAttribute('type') || '').toLowerCase() === 'password' && e.value) value = ' value: hidden';
      else if (e.checked !== undefined && ['checkbox', 'radio'].includes((e.getAttribute('type') || '').toLowerCase())) value = e.checked ? ' checked' : ' not checked';
      lines.push('[' + ref + '] ' + kind + ' "' + label(e) + '"' + value);
      if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.tagName)) return;
      if (e.matches('a[href]')) return;
    }
    for (const child of e.childNodes) walk(child);
  };
  walk(document.body ?? document.documentElement);
  const deduped = lines.filter((l, i) => l !== lines[i - 1]);
  return 'Title: ' + document.title + '\\nURL: ' + location.href.slice(0, MAX_URL) + '\\n\\n' + deduped.join('\\n');
})()`;

const LOCATE_SCRIPT = (ref: number) => `(() => {
  const e = document.querySelector('[data-bots-ref="${ref}"]');
  if (e === null) return null;
  e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`;

const CLEAR_SCRIPT = (ref: number) => `(() => {
  const e = document.querySelector('[data-bots-ref="${ref}"]');
  if (e === null) return;
  e.focus();
  if (e.select) e.select();
  else document.execCommand('selectAll');
})()`;

type Screen = { region: number; pages: string[]; lastUsed: number };

export type BrowserInputEvent =
  | { kind: "pointer"; x: number; y: number; action: "move" | "down" | "up" }
  | { kind: "text"; text: string }
  | { kind: "key"; key: string }
  | { kind: "navigate"; url: string };

export type Browser = {
  execute: (args: { botId: string; tool: BrowserInvocation; signal: AbortSignal }) => Promise<ToolResult>;
  regionFor: (botId: string) => Promise<number>;
  input: (botId: string, event: BrowserInputEvent) => Promise<void>;
};

export function createBrowser(args: { cdpBaseUrl?: string; stateFile: string; connector?: CdpConnector }): Browser {
  const connector = args.connector ?? webSocketConnector(args.cdpBaseUrl ?? "");
  let screens: Promise<Map<string, Screen>> | null = null;
  let saving: Promise<unknown> = Promise.resolve();
  let connection: Promise<Cdp> | null = null;
  const sessions = new Map<string, string>();
  // One bot's steps must not interleave, because a click belongs to the snapshot before it. Different bots do not wait on each other.
  const queues = new Map<string, Promise<unknown>>();

  // Callers share one promise, so two bots that start together cannot each read their own copy of the map.
  function loadScreens(): Promise<Map<string, Screen>> {
    screens ??= readFile(args.stateFile, "utf8").then(
      (raw) => new Map(Object.entries(JSON.parse(raw) as Record<string, Screen>)),
      () => new Map<string, Screen>(),
    );
    return screens;
  }

  // Saves share one temp file, so they run one at a time. Each writes the map as it is when its turn comes.
  function saveScreens(): Promise<void> {
    const save = async () => {
      const map = await loadScreens();
      const temporary = `${args.stateFile}.tmp`;
      await writeFile(temporary, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
      await rename(temporary, args.stateFile);
    };
    const next = saving.then(save, save);
    saving = next.catch(() => {});
    return next;
  }

  function screenOwning(map: Map<string, Screen>, targetId: string): Screen | undefined {
    for (const screen of map.values()) {
      if (screen.pages.includes(targetId)) {
        return screen;
      }
    }
    return undefined;
  }

  function cdp(): Promise<Cdp> {
    connection ??= connector()
      .then(async (client) => {
        client.onEvent((method, params) => {
          void handleEvent(client, method, params).catch(() => {});
        });
        await client.send("Target.setDiscoverTargets", { discover: true });
        return client;
      })
      .catch((error: unknown) => {
        connection = null;
        sessions.clear();
        throw error;
      });
    return connection;
  }

  // A popup opens wherever Chromium chooses, so this moves it to the screen of the bot that opened it.
  async function handleEvent(client: Cdp, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === "cdp.disconnected") {
      connection = null;
      sessions.clear();
      return;
    }
    const map = await loadScreens();
    if (method === "Target.targetDestroyed") {
      const targetId = String(params.targetId);
      sessions.delete(targetId);
      const screen = screenOwning(map, targetId);
      if (screen !== undefined) {
        screen.pages = screen.pages.filter((page) => page !== targetId);
        await saveScreens();
      }
      return;
    }
    if (method !== "Target.targetCreated") {
      return;
    }
    const info = params.targetInfo as { targetId: string; type: string; openerId?: string };
    if (info.type !== "page" || info.openerId === undefined) {
      return;
    }
    const screen = screenOwning(map, info.openerId);
    if (screen === undefined || screen.pages.includes(info.targetId)) {
      return;
    }
    screen.pages.push(info.targetId);
    await saveScreens();
    await placeWindow(client, info.targetId, screen.region, POPUP_OFFSET);
  }

  async function placeWindow(client: Cdp, targetId: string, region: number, inset: number): Promise<void> {
    const { windowId } = await client.send("Browser.getWindowForTarget", { targetId });
    await client.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await client.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: region * REGION_WIDTH + inset,
        top: inset,
        width: REGION_WIDTH - inset * 2,
        height: REGION_HEIGHT - inset * 2,
      },
    });
  }

  async function sessionFor(client: Cdp, targetId: string): Promise<string> {
    const existing = sessions.get(targetId);
    if (existing !== undefined) {
      return existing;
    }
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const id = String(sessionId);
    sessions.set(targetId, id);
    await client.send("Page.enable", {}, id);
    await client.send("Runtime.enable", {}, id);
    // Input through CDP needs the page to believe it has focus, and only one window can have X focus.
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true }, id);
    return id;
  }

  // This has no await, so two bots that start together cannot take the same region.
  function claimScreen(map: Map<string, Screen>, botId: string): { screen: Screen; evicted: string[] } {
    const taken = new Set([...map.values()].map((screen) => screen.region));
    for (let region = 0; region < SCREEN_COUNT; region += 1) {
      if (!taken.has(region)) {
        const screen = { region, pages: [], lastUsed: Date.now() };
        map.set(botId, screen);
        return { screen, evicted: [] };
      }
    }
    // Every screen is taken, so the bot that acted longest ago gives up its screen. Its logins stay in the shared profile.
    const [oldestBot, oldest] = [...map.entries()].sort(([, a], [, b]) => a.lastUsed - b.lastUsed)[0] as [string, Screen];
    map.delete(oldestBot);
    const screen = { region: oldest.region, pages: [], lastUsed: Date.now() };
    map.set(botId, screen);
    return { screen, evicted: oldest.pages };
  }

  // The newest page is the one on top of this bot's screen, so a popup takes over until it closes.
  async function currentPage(botId: string): Promise<{ client: Cdp; screen: Screen; targetId: string; sessionId: string }> {
    const client = await cdp();
    const map = await loadScreens();
    const { targetInfos } = (await client.send("Target.getTargets")) as { targetInfos: Array<{ targetId: string; type: string }> };
    const alive = new Set(targetInfos.filter((target) => target.type === "page").map((target) => target.targetId));
    let screen = map.get(botId);
    if (screen !== undefined) {
      screen.pages = screen.pages.filter((page) => alive.has(page));
    } else {
      const claimed = claimScreen(map, botId);
      screen = claimed.screen;
      for (const page of claimed.evicted) {
        await client.send("Target.closeTarget", { targetId: page }).catch(() => {});
      }
    }
    if (screen.pages.length === 0) {
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank", newWindow: true });
      screen.pages.push(String(targetId));
      await placeWindow(client, String(targetId), screen.region, 0);
    }
    screen.lastUsed = Date.now();
    await saveScreens();
    const targetId = screen.pages.at(-1) as string;
    return { client, screen, targetId, sessionId: await sessionFor(client, targetId) };
  }

  async function evaluate(client: Cdp, sessionId: string, expression: string): Promise<unknown> {
    const reply = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (reply.exceptionDetails !== undefined) {
      throw new Error("the page rejected the script");
    }
    return (reply.result as { value?: unknown }).value;
  }

  async function settle(client: Cdp, sessionId: string, signal: AbortSignal): Promise<void> {
    await sleep(SETTLE_MS, signal);
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const state = await evaluate(client, sessionId, "document.readyState").catch(() => "loading");
      if (state === "complete") {
        return;
      }
      await sleep(SETTLE_MS, signal);
    }
  }

  async function click(client: Cdp, sessionId: string, point: { x: number; y: number }): Promise<void> {
    const base = { x: point.x, y: point.y };
    await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base }, sessionId);
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, button: "left", buttons: 1, clickCount: 1 }, sessionId);
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, button: "left", buttons: 0, clickCount: 1 }, sessionId);
  }

  async function press(client: Cdp, sessionId: string, key: string): Promise<void> {
    const code = KEY_CODES[key];
    if (code === undefined) {
      throw new Error(`there is no key named ${key}`);
    }
    const event = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event }, sessionId);
    if (key === "Enter") {
      await client.send("Input.dispatchKeyEvent", { type: "char", ...event, text: "\r" }, sessionId);
    }
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...event }, sessionId);
  }

  async function locate(client: Cdp, sessionId: string, ref: number): Promise<{ x: number; y: number }> {
    const point = (await evaluate(client, sessionId, LOCATE_SCRIPT(ref))) as { x: number; y: number } | null;
    if (point === null) {
      throw new StaleRefError(ref);
    }
    return point;
  }

  async function run(botId: string, tool: BrowserInvocation, signal: AbortSignal): Promise<string> {
    // A cancelled call can wait in the queue, and a stopped run must not click or submit anything after that.
    signal.throwIfAborted();
    const { client, screen, sessionId } = await currentPage(botId);
    signal.throwIfAborted();
    switch (tool.name) {
      case "browser_navigate": {
        const reply = await client.send("Page.navigate", { url: tool.args.url }, sessionId);
        if (typeof reply.errorText === "string") {
          throw new Error(`the page did not load: ${reply.errorText}`);
        }
        break;
      }
      case "browser_snapshot":
        break;
      case "browser_click": {
        const point = await locate(client, sessionId, tool.args.ref);
        signal.throwIfAborted();
        await click(client, sessionId, point);
        break;
      }
      case "browser_type": {
        await click(client, sessionId, await locate(client, sessionId, tool.args.ref));
        await evaluate(client, sessionId, CLEAR_SCRIPT(tool.args.ref));
        signal.throwIfAborted();
        await client.send("Input.insertText", { text: tool.args.text }, sessionId);
        if (tool.args.submit) {
          signal.throwIfAborted();
          await press(client, sessionId, "Enter");
        }
        break;
      }
      case "browser_press":
        await press(client, sessionId, tool.args.key);
        break;
    }
    // An action can open a popup at any time during the wait, and the next action goes to the newest page.
    // So the snapshot must come from the page that is still newest after the wait, or its refs would point at the wrong page.
    let after = await currentPage(botId);
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
      await settle(after.client, after.sessionId, signal);
      const latest = await currentPage(botId);
      if (latest.targetId === after.targetId) {
        break;
      }
      after = latest;
    }
    const snapshot = String(await evaluate(after.client, after.sessionId, SNAPSHOT_SCRIPT));
    return `Screen ${screen.region + 1}\n${snapshot}`;
  }

  function inOrder<T>(botId: string, step: () => Promise<T>): Promise<T> {
    const previous = queues.get(botId) ?? Promise.resolve();
    const next = previous.then(step, step);
    queues.set(botId, next.catch(() => {}));
    return next;
  }

  return {
    execute: ({ botId, tool, signal }) =>
      inOrder(botId, async (): Promise<ToolResult> => {
        try {
          const { output, truncated } = capText(await run(botId, tool, signal));
          return { outcome: "ok", output, truncated };
        } catch (error) {
          if (signal.aborted) {
            return { outcome: "cancelled", output: "The browser action was cancelled.", truncated: false };
          }
          const message = error instanceof Error ? error.message : "unknown error";
          return { outcome: "error", output: `The browser action failed: ${message}`, truncated: false };
        }
      }),
    regionFor: (botId) => inOrder(botId, async () => (await currentPage(botId)).screen.region),
    input: (botId, event) =>
      inOrder(botId, async () => {
        const { client, sessionId } = await currentPage(botId);
        switch (event.kind) {
          case "pointer": {
            const type = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" }[event.action];
            const held = event.action === "down" ? 1 : 0;
            const button = event.action === "move" ? "none" : "left";
            await client.send(
              "Input.dispatchMouseEvent",
              { type, x: event.x, y: event.y, button, buttons: held, clickCount: event.action === "move" ? 0 : 1 },
              sessionId,
            );
            return;
          }
          case "text":
            await client.send("Input.insertText", { text: event.text }, sessionId);
            return;
          case "key":
            await press(client, sessionId, event.key);
            return;
          case "navigate":
            await client.send("Page.navigate", { url: event.url }, sessionId);
            return;
        }
      }),
  };
}

class StaleRefError extends Error {
  constructor(ref: number) {
    super(`there is no element ${ref} on the page now, so take a new snapshot`);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

function webSocketConnector(baseUrl: string): CdpConnector {
  return async () => {
    let debuggerUrl: string;
    try {
      const response = await fetch(`${baseUrl}/json/version`, { signal: AbortSignal.timeout(CDP_CONNECT_TIMEOUT_MS) });
      debuggerUrl = ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    } catch {
      throw new Error("this computer has no running browser");
    }
    const socket = new WebSocket(debuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
    socket.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString("utf8")) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error !== undefined) {
          waiter?.reject(new Error(message.error.message));
        } else {
          waiter?.resolve(message.result ?? {});
        }
      } else if (message.method !== undefined) {
        for (const listener of listeners) {
          listener(message.method, message.params ?? {});
        }
      }
    });
    socket.on("close", () => {
      for (const waiter of pending.values()) {
        waiter.reject(new Error("the browser closed the connection"));
      }
      pending.clear();
      for (const listener of listeners) {
        listener("cdp.disconnected", {});
      }
    });
    return {
      send: (method, params = {}, sessionId) =>
        new Promise((resolve, reject) => {
          const id = nextId;
          nextId += 1;
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
        }),
      onEvent: (listener) => {
        listeners.push(listener);
      },
    };
  };
}
