import { setTimeout as delay } from "node:timers/promises";
import { capText, type BrowserInvocation, type Browsing, type ToolResult } from "@bots/protocol";
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
// A leftover logged-out window ends this long after its last call, if nothing ended it first. A run calls a tool again after one model
// call, so a live run reaches this only when a model call or a take-over lasts this long, and its next call then gets a blank page.
const LOGGED_OUT_IDLE_MS = 10 * 60 * 1000;

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

// This runs in the page. It numbers what a bot can act on, and it never reads the value of a password field. Only a logged-out page
// shows link addresses. A logged-in page's links can hold reset tokens and signed URLs, and a chat run can click a link instead.
const SNAPSHOT_SCRIPT = (showLinks: boolean) => `(() => {
  const MAX_TEXT = 120;
  const MAX_URL = 300;
  const MAX_LINK = 200;
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[role=tab],[contenteditable=true],[onclick]';
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (t) => (t ?? '').replace(/\\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const address = (e) => {
    if (!${showLinks} || !e.matches('a[href]')) return '';
    const href = String(e.href);
    if (!/^https?:/i.test(href)) return '';
    return ' to: ' + (href.length > MAX_LINK ? href.slice(0, MAX_LINK) + '...' : href);
  };
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
      lines.push('[' + ref + '] ' + kind + ' "' + label(e) + '"' + value + address(e));
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

// One browser context's pages. A call looks up and opens pages only through its home, so a logged-out call cannot reach a page of the
// bot's own, and a new page goes to the context that needs it.
type PageHome = {
  contextId: string;
  // Oldest first. The last one is the page that the bot acts on.
  pages: string[];
  newPage: { url: "about:blank"; browserContextId?: string };
};

// A context for one key, with none of the owner's logins. Chromium ends it when this socket closes, so a computerd that dies leaves
// no window behind, and nothing has to find an old context after a restart.
type LoggedOut = PageHome & { key: string; idleEnd: NodeJS.Timeout | undefined };

// Every page target on this browser belongs to this bot.
type Connection = {
  cdpPort: number;
  client: Cdp;
  own: PageHome;
  loggedOut: LoggedOut | null;
  sessions: Map<string, string>;
  heldDialogs: PageDialog[];
};

type PageDialog = { sessionId: string; accept: boolean };

type TargetInfo = { targetId: string; type: string; openerId?: string; browserContextId?: string };

function sendQuietly(client: Cdp, method: string, params: Record<string, unknown>, sessionId?: string): void {
  client.send(method, params, sessionId).catch(() => {});
}

function answerDialog(client: Cdp, dialog: PageDialog): void {
  sendQuietly(client, "Page.handleJavaScriptDialog", { accept: dialog.accept }, dialog.sessionId);
}

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

// Every CDP call through `client` ends when `ends` aborts, and none starts after it.
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
  execute: (args: { botId: string; tool: BrowserInvocation; browsing: Browsing | undefined; signal: AbortSignal }) => Promise<ToolResult>;
  // Ends a logged-out window, if this key still has one. It never rejects and never starts a desktop.
  endBrowsing: (botId: string, key: string) => Promise<void>;
};

export function createBrowser(args: {
  desktops: Pick<Desktops, "acquire">;
  connector?: CdpConnector;
  takeoverSettled?: (botId: string, signal: AbortSignal) => Promise<void>;
  personHasScreen?: (botId: string) => boolean;
  toolDeadlineMs?: number;
  frozenProbeMs?: number;
  loggedOutIdleMs?: number;
}): Browser {
  const { desktops, connector = webSocketConnector, takeoverSettled, personHasScreen, toolDeadlineMs = TOOL_DEADLINE_MS, frozenProbeMs = FROZEN_PROBE_MS, loggedOutIdleMs = LOGGED_OUT_IDLE_MS } = args;
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
    const limit = AbortSignal.any([signal, AbortSignal.timeout(CDP_CONNECT_TIMEOUT_MS)]);
    try {
      const { defaultBrowserContextId } = await untilEnd(limit, () => client.send("Target.getBrowserContexts"));
      if (typeof defaultBrowserContextId !== "string") {
        throw new Error("this browser does not name its default context");
      }
      const connection: Connection = {
        cdpPort,
        client,
        own: { contextId: defaultBrowserContextId, pages: [], newPage: { url: "about:blank" } },
        loggedOut: null,
        sessions: new Map(),
        heldDialogs: [],
      };
      client.onEvent((event) => onBrowserEvent(botId, connection, event));
      client.onClose(() => {
        clearTimeout(connection.loggedOut?.idleEnd);
        if (connections.get(botId) === connection) {
          connections.delete(botId);
        }
      });
      // Each new page, popups too, waits for this socket before its first script, so no dialog can open before Page.enable. A dialog
      // that opened with no socket here sends no event, even after Page.enable.
      await untilEnd(limit, () => client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }] }));
      connections.set(botId, connection);
      return connection;
    } catch (error) {
      client.close();
      throw error;
    }
  }

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

  async function refreshPages(client: Cdp, home: PageHome): Promise<void> {
    const { targetInfos } = (await client.send("Target.getTargets")) as { targetInfos: TargetInfo[] };
    home.pages = nextPages(home.pages, targetInfos.filter((target) => target.browserContextId === home.contextId));
    if (home.pages.length === 0) {
      const { targetId } = await client.send("Target.createTarget", home.newPage);
      home.pages.push(String(targetId));
    }
  }

  async function currentPage(connection: Connection, client: Cdp, home: PageHome): Promise<{ targetId: string; sessionId: string }> {
    await refreshPages(client, home);
    const targetId = home.pages.at(-1) as string;
    return { targetId, sessionId: await sessionFor(connection, client, targetId) };
  }

  async function startLoggedOut(connection: Connection, client: Cdp, key: string): Promise<LoggedOut> {
    // Chromium exits when its last page closes, in any context. So the bot's own page exists before this context can hold the last one.
    await refreshPages(client, connection.own);
    const { browserContextId } = (await client.send("Target.createBrowserContext", { disposeOnDetach: true })) as { browserContextId: string };
    try {
      await client.send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId });
    } catch (error) {
      sendQuietly(connection.client, "Target.disposeBrowserContext", { browserContextId });
      throw error;
    }
    return { key, contextId: browserContextId, pages: [], newPage: { url: "about:blank", browserContextId }, idleEnd: undefined };
  }

  // False when the browser did not end it in time. Closing the socket then ends it, and the next call connects again.
  async function endLoggedOut(botId: string, connection: Connection): Promise<boolean> {
    const { loggedOut } = connection;
    if (loggedOut === null) {
      return true;
    }
    clearTimeout(loggedOut.idleEnd);
    connection.loggedOut = null;
    const { client } = startPageCall(connection.client, new AbortController().signal, CLOSE_PAGE_MS);
    try {
      await refreshPages(client, connection.own);
      await client.send("Target.disposeBrowserContext", { browserContextId: loggedOut.contextId });
      return true;
    } catch (error) {
      log({ level: "warn", event: "logged-out-end-failed", botId, message: error instanceof Error ? error.message : "unknown error" });
      connections.delete(botId);
      connection.client.close();
      return false;
    }
  }

  // A call with no key means that the run that owned a leftover window is over, because a bot has one active run.
  async function homeFor(botId: string, connection: Connection, client: Cdp, browsing: Browsing | undefined): Promise<PageHome> {
    if (connection.loggedOut !== null && connection.loggedOut.key !== browsing?.key) {
      await endLoggedOut(botId, connection);
    }
    if (browsing === undefined) {
      return connection.own;
    }
    connection.loggedOut ??= await startLoggedOut(connection, client, browsing.key);
    return connection.loggedOut;
  }

  function endBrowsing(botId: string, key: string): Promise<void> {
    return inOrder(botId, async () => {
      const connection = connections.get(botId);
      if (connection?.loggedOut?.key === key) {
        await endLoggedOut(botId, connection);
      }
    });
  }

  function armIdleEnd(botId: string, { loggedOut }: Connection): void {
    if (loggedOut !== null) {
      loggedOut.idleEnd = setTimeout(() => void endBrowsing(botId, loggedOut.key), loggedOutIdleMs);
      loggedOut.idleEnd.unref();
    }
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

  async function act(connection: Connection, call: PageCall, home: PageHome, tool: BrowserInvocation): Promise<string> {
    const { client, ends } = call;
    const { sessionId } = await currentPage(connection, client, home);
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
    let after = await currentPage(connection, client, home);
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
      await settle(client, after.sessionId, ends);
      const latest = await currentPage(connection, client, home);
      if (latest.targetId === after.targetId) {
        break;
      }
      after = latest;
    }
    return String(await evaluate(client, after.sessionId, SNAPSHOT_SCRIPT(home === connection.loggedOut)));
  }

  async function closeIfFrozen(botId: string, connection: Connection, home: PageHome | null): Promise<PageFate> {
    const { client } = connection;
    const targetId = home?.pages.at(-1);
    const sessionId = targetId === undefined ? undefined : connection.sessions.get(targetId);
    if (home === null || targetId === undefined || sessionId === undefined) {
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
    // A frozen logged-out page takes its whole context with it, along with any frozen opener, and the next call makes a new context.
    if (home === connection.loggedOut) {
      return (await endLoggedOut(botId, connection)) ? "closed" : "stuck";
    }
    // The new page comes first, because Chromium exits when its last page closes.
    const limit = AbortSignal.timeout(CLOSE_PAGE_MS);
    const replaced = await untilEnd(limit, () => client.send("Target.createTarget", home.newPage)).then(
      () => true,
      () => false,
    );
    if (!replaced) {
      return "stuck";
    }
    await untilEnd(limit, () => client.send("Target.closeTarget", { targetId })).catch(() => {});
    return limit.aborted ? "stuck" : "closed";
  }

  async function run(botId: string, tool: BrowserInvocation, browsing: Browsing | undefined, signal: AbortSignal): Promise<ToolResult> {
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
      clearTimeout(connection.loggedOut?.idleEnd);
      const call = startPageCall(connection.client, signal, toolDeadlineMs);
      try {
        const home = await homeFor(botId, connection, call.client, browsing);
        const { output, truncated } = capText(`Screen ${lease.slot}\n${await act(connection, call, home, tool)}`);
        return { outcome: "ok", output, truncated };
      } catch (error) {
        if (!call.ends.aborted) {
          throw error;
        }
        const fate = await closeIfFrozen(botId, connection, browsing === undefined ? connection.own : connection.loggedOut);
        log({ level: "info", event: "browser-call-ended-early", botId, tool: tool.name, cancelled: signal.aborted, fate });
        const page = PAGE_FATE_OUTPUT[fate];
        return signal.aborted
          ? { outcome: "cancelled", output: `The browser action was cancelled. ${page}`, truncated: false }
          : { outcome: "timeout", output: `The browser action did not finish in ${toolDeadlineMs / 1000} seconds, so it stopped, and it may have partly happened. ${page}`, truncated: false };
      } finally {
        armIdleEnd(botId, connection);
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
    endBrowsing,
    execute: ({ botId, tool, browsing, signal }) =>
      inOrder(botId, async (): Promise<ToolResult> => {
        try {
          return await run(botId, tool, browsing, signal);
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
