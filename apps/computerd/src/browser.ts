import { setTimeout as delay } from "node:timers/promises";
import { capText, type BrowserInvocation, type ToolResult } from "@bots/protocol";
import { WebSocket } from "ws";
import type { Desktops } from "./desktops.ts";
import { log } from "./log.ts";

const CDP_CONNECT_TIMEOUT_MS = 5000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SETTLE_MS = 400;
const MAX_SETTLE_ROUNDS = 4;
// The orchestrator's link gives a browser tool this long plus a 60 second margin. That margin holds a take-over's wait and a desktop's
// start, so the tool answers for itself, and the link's 120 seconds never turn a slow page into an unknown outcome.
const TOOL_DEADLINE_MS = 60_000;
// A page that gives no answer for this long, after a call ended early, counts as frozen. With CLOSE_PAGE_MS it fits inside the 10
// seconds that the link waits after a cancel.
const FROZEN_PROBE_MS = 5000;
const CLOSE_PAGE_MS = 3000;

// What a call that ended early left behind. A page that is gone counts as answering, because nothing is left to free.
type PageFate = "answers" | "closed" | "keptForOwner" | "stuck";

const PAGE_FATE_OUTPUT: Record<PageFate, string> = {
  answers: "Any navigation in progress was stopped. Take a new snapshot to see where the page got to.",
  closed: "The page froze and was closed. The next browser tool starts on a new blank page.",
  keptForOwner: "The page is not answering. It stayed open because the owner has the screen.",
  stuck: "The page froze, and the browser did not close it.",
};

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

export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId: string | undefined };

export type Cdp = {
  // The browser's GUID, which changes at each start.
  identity: string;
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;
  onEvent: (listener: (event: CdpEvent) => void) => void;
  onClose: (listener: () => void) => void;
  close: () => void;
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
  // Dialogs that opened while a person had the screen. A dialog stays with the person, and anything left over goes at the next call.
  heldDialogs: PageDialog[];
};

type PageDialog = { sessionId: string; accept: boolean };

type TargetInfo = { targetId: string; type: string; openerId?: string };

function sendQuietly(client: Cdp, method: string, params: Record<string, unknown>, sessionId: string): void {
  client.send(method, params, sessionId).catch(() => {});
}

function answerDialog(client: Cdp, dialog: PageDialog): void {
  sendQuietly(client, "Page.handleJavaScriptDialog", { accept: dialog.accept }, dialog.sessionId);
}

// Settles with the work, or rejects when `ends` aborts, whichever comes first. A page that never answers leaves its reply waiting
// in the connection, which is a small cost for each frozen call.
function untilEnd<T>(ends: AbortSignal, start: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (ends.aborted) {
      reject(ends.reason as Error);
      return;
    }
    const stop = () => reject(ends.reason as Error);
    ends.addEventListener("abort", stop, { once: true });
    start()
      .then(resolve, reject)
      .finally(() => ends.removeEventListener("abort", stop));
  });
}

// One tool call's time on a page. Every CDP call through `client` ends when `ends` aborts, and none starts after it. So a tool needs
// no abort checks of its own, and it cannot wait on a page that does not answer.
type PageCall = { client: Cdp; ends: AbortSignal };

function startPageCall(client: Cdp, signal: AbortSignal, deadlineMs: number): PageCall {
  const ends = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
  return {
    ends,
    client: { ...client, send: (method, params, sessionId) => untilEnd(ends, () => client.send(method, params, sessionId)) },
  };
}

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

export function createBrowser(args: {
  desktops: Pick<Desktops, "acquire">;
  connector?: CdpConnector;
  takeoverSettled?: (botId: string, signal: AbortSignal) => Promise<void>;
  // A person who is typing on the screen answers for the page, so nothing closes it under them.
  personHasScreen?: (botId: string) => boolean;
  toolDeadlineMs?: number;
  frozenProbeMs?: number;
}): Browser {
  const { desktops, connector = webSocketConnector, takeoverSettled, personHasScreen, toolDeadlineMs = TOOL_DEADLINE_MS, frozenProbeMs = FROZEN_PROBE_MS } = args;
  // Only one bot's queue touches its entry, so this needs no promise to share.
  const connections = new Map<string, Connection>();
  // One bot's steps must not interleave, because a click belongs to the snapshot before it. Different bots do not wait on each other.
  const queues = new Map<string, Promise<unknown>>();

  async function connectionFor(botId: string, cdpPort: number, signal: AbortSignal): Promise<Connection> {
    const known = connections.get(botId);
    if (known?.cdpPort === cdpPort) {
      return known;
    }
    const client = await connector(cdpPort);
    const connection: Connection = { cdpPort, client, pages: [], sessions: new Map(), heldDialogs: [] };
    client.onEvent((event) => onBrowserEvent(botId, connection, event));
    client.onClose(() => {
      if (connections.get(botId) === connection) {
        connections.delete(botId);
      }
    });
    // Each new page, popups too, waits for this socket before its first script, so no dialog can open before Page.enable. A dialog
    // that opened with no socket here sends no event, even after Page.enable, so that page goes the way of any frozen page.
    const limit = AbortSignal.any([signal, AbortSignal.timeout(CDP_CONNECT_TIMEOUT_MS)]);
    try {
      await untilEnd(limit, () => client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }] }));
    } catch (error) {
      client.close();
      throw error;
    }
    connections.set(botId, connection);
    return connection;
  }

  // Nothing here waits for an answer, because a frozen page never gives one, and the tool's next step finds that out for itself.
  // CDP keeps the order on one session, so Page.enable comes before the page runs.
  function adoptSession(connection: Connection, targetId: string, sessionId: string): void {
    if (connection.sessions.has(targetId)) {
      return;
    }
    connection.sessions.set(targetId, sessionId);
    sendQuietly(connection.client, "Page.enable", {}, sessionId);
    sendQuietly(connection.client, "Runtime.enable", {}, sessionId);
    // A bot's input through CDP needs the page to believe it has focus, and only one window can have X focus.
    sendQuietly(connection.client, "Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  }

  function onBrowserEvent(botId: string, connection: Connection, event: CdpEvent): void {
    if (event.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = event.params as { sessionId: string; targetInfo: TargetInfo; waitingForDebugger: boolean };
      adoptSession(connection, targetInfo.targetId, sessionId);
      if (waitingForDebugger) {
        sendQuietly(connection.client, "Runtime.runIfWaitingForDebugger", {}, sessionId);
      }
    }
    if (event.method === "Page.javascriptDialogOpening" && event.sessionId !== undefined) {
      // Leaving is what a bot asked for when it navigates, and refusing is the safe answer to anything a page asks.
      const dialog = { sessionId: event.sessionId, accept: event.params.type === "beforeunload" };
      if (personHasScreen?.(botId) === true) {
        connection.heldDialogs.push(dialog);
      } else {
        answerDialog(connection.client, dialog);
      }
    }
  }

  async function sessionFor(connection: Connection, client: Cdp, targetId: string): Promise<string> {
    const known = connection.sessions.get(targetId);
    if (known !== undefined) {
      return known;
    }
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    adoptSession(connection, targetId, String(sessionId));
    return connection.sessions.get(targetId) as string;
  }

  // Asking on every look means that which page is current needs no events, and nothing is lost across a restart.
  async function currentPage(connection: Connection, client: Cdp): Promise<{ targetId: string; sessionId: string }> {
    const { targetInfos } = (await client.send("Target.getTargets")) as { targetInfos: TargetInfo[] };
    connection.pages = nextPages(connection.pages, targetInfos);
    if (connection.pages.length === 0) {
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
      connection.pages.push(String(targetId));
    }
    const targetId = connection.pages.at(-1) as string;
    return { targetId, sessionId: await sessionFor(connection, client, targetId) };
  }

  async function evaluate(client: Cdp, sessionId: string, expression: string): Promise<unknown> {
    const reply = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (reply.exceptionDetails !== undefined) {
      throw new Error("the page rejected the script");
    }
    return (reply.result as { value?: unknown }).value;
  }

  async function settle(client: Cdp, sessionId: string, signal: AbortSignal): Promise<void> {
    await delay(SETTLE_MS, undefined, { signal });
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await evaluate(client, sessionId, "document.readyState").catch(() => "loading");
      if (state === "complete") {
        return;
      }
      await delay(SETTLE_MS, undefined, { signal });
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

  async function act(connection: Connection, call: PageCall, tool: BrowserInvocation): Promise<string> {
    const { client, ends } = call;
    const { sessionId } = await currentPage(connection, client);
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
      case "browser_click":
        await click(client, sessionId, await locate(client, sessionId, tool.args.ref));
        break;
      case "browser_type":
        await click(client, sessionId, await locate(client, sessionId, tool.args.ref));
        await evaluate(client, sessionId, CLEAR_SCRIPT(tool.args.ref));
        await client.send("Input.insertText", { text: tool.args.text }, sessionId);
        if (tool.args.submit) {
          await press(client, sessionId, "Enter");
        }
        break;
      case "browser_press":
        await press(client, sessionId, tool.args.key);
        break;
    }
    // An action can open a popup at any time during the wait, and the next action goes to the newest page.
    // So the snapshot must come from the page that is still newest after the wait, or its refs would point at the wrong page.
    let after = await currentPage(connection, client);
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
      await settle(client, after.sessionId, ends);
      const latest = await currentPage(connection, client);
      if (latest.targetId === after.targetId) {
        break;
      }
      after = latest;
    }
    return String(await evaluate(client, after.sessionId, SNAPSHOT_SCRIPT));
  }

  // A new blank page goes on top, so the next call works at once even if a same-site opener shares the frozen process. Its refs are
  // gone, so an old click gets the stale ref error. The browser holds all of this, so a restart of computerd finds the same pages.
  async function settlePage(botId: string, connection: Connection): Promise<PageFate> {
    const { client } = connection;
    const targetId = connection.pages.at(-1);
    const sessionId = targetId === undefined ? undefined : connection.sessions.get(targetId);
    if (targetId === undefined || sessionId === undefined) {
      return "answers";
    }
    const personIsThere = personHasScreen?.(botId) === true;
    // Chromium holds a session's page calls during a navigation, so a server that never answers would look like a frozen page.
    if (!personIsThere) {
      sendQuietly(client, "Page.stopLoading", {}, sessionId);
    }
    const probe = AbortSignal.timeout(frozenProbeMs);
    await untilEnd(probe, () => client.send("Runtime.evaluate", { expression: "1" }, sessionId)).catch(() => {});
    if (!probe.aborted) {
      return "answers";
    }
    if (personIsThere) {
      return "keptForOwner";
    }
    // The new page comes first, because Chromium exits when its last page closes.
    const limit = AbortSignal.timeout(CLOSE_PAGE_MS);
    const replaced = await untilEnd(limit, () => client.send("Target.createTarget", { url: "about:blank" })).then(
      () => true,
      () => false,
    );
    if (!replaced) {
      return "stuck";
    }
    await untilEnd(limit, () => client.send("Target.closeTarget", { targetId })).catch(() => {});
    return limit.aborted ? "stuck" : "closed";
  }

  async function run(botId: string, tool: BrowserInvocation, signal: AbortSignal): Promise<ToolResult> {
    // A cancelled call can wait in the queue, and a stopped run must not click or submit anything after that.
    signal.throwIfAborted();
    await takeoverSettled?.(botId, signal);
    signal.throwIfAborted();
    const lease = await desktops.acquire(botId);
    try {
      // A cancel during a slow start still sends nothing.
      signal.throwIfAborted();
      const connection = await connectionFor(botId, lease.cdpPort, signal);
      if (personHasScreen?.(botId) !== true) {
        connection.heldDialogs.splice(0).forEach((dialog) => answerDialog(connection.client, dialog));
      }
      const call = startPageCall(connection.client, signal, toolDeadlineMs);
      try {
        const { output, truncated } = capText(`Screen ${lease.slot}\n${await act(connection, call, tool)}`);
        return { outcome: "ok", output, truncated };
      } catch (error) {
        if (!call.ends.aborted) {
          throw error;
        }
        const fate = await settlePage(botId, connection);
        log({ level: "info", event: "browser-call-ended-early", botId, tool: tool.name, cancelled: signal.aborted, fate });
        const page = PAGE_FATE_OUTPUT[fate];
        return signal.aborted
          ? { outcome: "cancelled", output: `The browser action was cancelled. ${page}`, truncated: false }
          : { outcome: "timeout", output: `The browser action did not finish in ${toolDeadlineMs / 1000} seconds, so it stopped, and it may have partly happened. ${page}`, truncated: false };
      }
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
          return await run(botId, tool, signal);
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

export async function webSocketConnector(cdpPort: number): Promise<Cdp> {
  let debuggerUrl: string;
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, { signal: AbortSignal.timeout(CDP_CONNECT_TIMEOUT_MS) });
    debuggerUrl = ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  } catch {
    throw new Error("this computer has no running browser");
  }
  const socket = new WebSocket(debuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024, handshakeTimeout: CDP_CONNECT_TIMEOUT_MS });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const eventListeners: ((event: CdpEvent) => void)[] = [];
  socket.on("message", (raw: Buffer) => {
    const message = JSON.parse(raw.toString("utf8")) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (message.method !== undefined) {
      const event = { method: message.method, params: message.params ?? {}, sessionId: message.sessionId };
      eventListeners.forEach((listener) => listener(event));
    }
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
    identity: debuggerUrl.split("/").at(-1) as string,
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        // ws drops a send on a closed socket with no error, and the close has already ended every waiter, so this would never settle.
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error("the browser closed the connection"));
          return;
        }
        const id = nextId;
        nextId += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
      }),
    onEvent: (listener) => {
      eventListeners.push(listener);
    },
    // A socket can close before anyone listens, and a stale connection would then fail every later call.
    onClose: (listener) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.once("close", listener);
      } else {
        listener();
      }
    },
    close: () => socket.terminate(),
  };
}
