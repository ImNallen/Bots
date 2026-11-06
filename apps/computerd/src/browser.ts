import { capText, type BrowserInvocation, type ToolResult } from "@bots/protocol";
import { WebSocket } from "ws";
import type { Desktops } from "./desktops.ts";

const CDP_CONNECT_TIMEOUT_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SETTLE_MS = 400;
const MAX_SETTLE_ROUNDS = 4;

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
  onClose: (listener: () => void) => void;
};

export type CdpConnector = (cdpPort: number) => Promise<Cdp>;

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

// Every page target on this browser belongs to this bot.
type Connection = {
  cdpPort: number;
  client: Cdp;
  // Oldest first. The last one is the page that the bot acts on.
  pages: string[];
  sessions: Map<string, string>;
};

type TargetInfo = { targetId: string; type: string; openerId?: string };

// A closed page leaves the list, so the bot falls back to the page under it. A new page goes on the end, so a popup becomes the
// current page. Pages seen for the first time together, as after a computerd restart, put the ones with an opener last, so a
// popup that was open before the restart stays current.
export function nextPages(known: readonly string[], targets: readonly TargetInfo[]): string[] {
  const pages = targets.filter((target) => target.type === "page");
  const alive = new Set(pages.map((page) => page.targetId));
  const fresh = pages.filter((page) => !known.includes(page.targetId));
  return [
    ...known.filter((page) => alive.has(page)),
    ...fresh.filter((page) => page.openerId === undefined).map((page) => page.targetId),
    ...fresh.filter((page) => page.openerId !== undefined).map((page) => page.targetId),
  ];
}

export type Browser = {
  execute: (args: { botId: string; tool: BrowserInvocation; signal: AbortSignal }) => Promise<ToolResult>;
};

export function createBrowser(args: { desktops: Pick<Desktops, "acquire">; connector?: CdpConnector }): Browser {
  const { desktops, connector = webSocketConnector } = args;
  // Only one bot's queue touches its entry, so this needs no promise to share.
  const connections = new Map<string, Connection>();
  // One bot's steps must not interleave, because a click belongs to the snapshot before it. Different bots do not wait on each other.
  const queues = new Map<string, Promise<unknown>>();

  async function connectionFor(botId: string, cdpPort: number): Promise<Connection> {
    const known = connections.get(botId);
    if (known?.cdpPort === cdpPort) {
      return known;
    }
    const client = await connector(cdpPort);
    const connection: Connection = { cdpPort, client, pages: [], sessions: new Map() };
    connections.set(botId, connection);
    client.onClose(() => {
      if (connections.get(botId) === connection) {
        connections.delete(botId);
      }
    });
    return connection;
  }

  async function sessionFor(connection: Connection, targetId: string): Promise<string> {
    const { client, sessions } = connection;
    const existing = sessions.get(targetId);
    if (existing !== undefined) {
      return existing;
    }
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    const id = String(sessionId);
    sessions.set(targetId, id);
    await client.send("Page.enable", {}, id);
    await client.send("Runtime.enable", {}, id);
    // A bot's input through CDP needs the page to believe it has focus, and only one window can have X focus.
    await client.send("Emulation.setFocusEmulationEnabled", { enabled: true }, id);
    return id;
  }

  // Asking on every look means nothing has to watch for events, and nothing is lost across a restart.
  async function currentPage(connection: Connection): Promise<{ client: Cdp; targetId: string; sessionId: string }> {
    const { client } = connection;
    const { targetInfos } = (await client.send("Target.getTargets")) as { targetInfos: TargetInfo[] };
    connection.pages = nextPages(connection.pages, targetInfos);
    if (connection.pages.length === 0) {
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
      connection.pages.push(String(targetId));
    }
    const targetId = connection.pages.at(-1) as string;
    return { client, targetId, sessionId: await sessionFor(connection, targetId) };
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
    const lease = await desktops.acquire(botId);
    try {
      // A cancel during a slow start still sends nothing.
      signal.throwIfAborted();
      const connection = await connectionFor(botId, lease.cdpPort);
      const { client, sessionId } = await currentPage(connection);
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
      let after = await currentPage(connection);
      for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
        await settle(after.client, after.sessionId, signal);
        const latest = await currentPage(connection);
        if (latest.targetId === after.targetId) {
          break;
        }
        after = latest;
      }
      const snapshot = String(await evaluate(after.client, after.sessionId, SNAPSHOT_SCRIPT));
      return `Screen ${lease.slot}\n${snapshot}`;
    } finally {
      lease.release();
    }
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

async function webSocketConnector(cdpPort: number): Promise<Cdp> {
  let debuggerUrl: string;
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(CDP_CONNECT_TIMEOUT_MS) });
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
  socket.on("message", (raw: Buffer) => {
    const message = JSON.parse(raw.toString("utf8")) as {
      id?: number;
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
    }
  });
  socket.on("close", () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error("the browser closed the connection"));
    }
    pending.clear();
  });
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
      }),
    // A socket can close before anyone listens, and a stale connection would then fail every later call.
    onClose: (listener) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.once("close", listener);
      } else {
        listener();
      }
    },
  };
}
