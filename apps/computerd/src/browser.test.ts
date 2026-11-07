import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserInvocation, Browsing } from "@bots/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createBrowser, nextPages, type CdpConnector, type CdpEvent } from "./browser.ts";
import { createCalls } from "./calls.ts";
import { createDesktops, desktopOf, IDLE_STOP_MS, type Desktops, type Slot } from "./desktops.ts";
import { openJournal } from "./journal.ts";

type Sent = { method: string; params: Record<string, unknown>; sessionId: string | undefined };

const DEFAULT_CONTEXT = "default-context";

function fakeChromium() {
  const pages = new Map<string, { openerId?: string; browserContextId?: string }>([["target-0", {}]]);
  const contexts = new Map<string, { disposeOnDetach: boolean }>();
  let nextContext = 1;
  let exited = false;
  let socketsClosed = 0;
  const disposeContext = (browserContextId: string) => {
    contexts.delete(browserContextId);
    for (const [targetId, page] of pages) {
      if (page.browserContextId === browserContextId) {
        pages.delete(targetId);
      }
    }
    exited ||= pages.size === 0;
  };
  const sent: Sent[] = [];
  const closeListeners: Array<() => void> = [];
  const eventListeners: Array<(event: CdpEvent) => void> = [];
  let nextTarget = 1;
  let locateResult: { x: number; y: number } | null = { x: 10, y: 20 };
  let sendHook: ((method: string) => void) | undefined;
  const frozen = new Set<string>();
  const stalled = new Set<string>();
  const failing = new Set<string>();
  let navigating = false;

  return {
    pages,
    contexts,
    sent,
    exited: () => exited,
    socketsClosed: () => socketsClosed,
    openPopup: (openerId: string) => {
      const targetId = `target-${nextTarget++}`;
      const browserContextId = pages.get(openerId)?.browserContextId;
      pages.set(targetId, { openerId, ...(browserContextId === undefined ? {} : { browserContextId }) });
      return targetId;
    },
    closeSocket: () => closeListeners.splice(0).forEach((listener) => listener()),
    dropSocket: () => {
      closeListeners.splice(0).forEach((listener) => listener());
      for (const [browserContextId, context] of contexts) {
        if (context.disposeOnDetach) {
          disposeContext(browserContextId);
        }
      }
    },
    emit: (method: string, params: Record<string, unknown>, sessionId?: string) => eventListeners.forEach((listener) => listener({ method, params, sessionId })),
    onSend: (hook: (method: string) => void) => {
      sendHook = hook;
    },
    setLocate: (value: { x: number; y: number } | null) => {
      locateResult = value;
    },
    freezePage: (targetId = "target-0") => {
      frozen.add(`session-${targetId}`);
    },
    thaw: () => frozen.clear(),
    failNext: (method: string) => {
      failing.add(method);
    },
    stall: (method: string) => {
      stalled.add(method);
    },
    stallNavigation: () => {
      navigating = true;
    },
    client: {
      identity: "browser",
      close: () => {
        socketsClosed += 1;
        closeListeners.splice(0).forEach((listener) => listener());
        for (const [browserContextId, context] of contexts) {
          if (context.disposeOnDetach) {
            disposeContext(browserContextId);
          }
        }
      },
      onEvent: (listener: (event: CdpEvent) => void) => {
        eventListeners.push(listener);
      },
      onClose: (listener: () => void) => {
        closeListeners.push(listener);
      },
      send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
        sent.push({ method, params, sessionId });
        sendHook?.(method);
        if (failing.delete(method)) {
          throw new Error("No target with given id found");
        }
        if (method === "Page.stopLoading") {
          navigating = false;
        }
        if ((sessionId !== undefined && frozen.has(sessionId)) || stalled.has(method) || (navigating && (method === "Page.navigate" || method === "Runtime.evaluate"))) {
          return await new Promise<Record<string, unknown>>(() => {});
        }
        switch (method) {
          case "Target.getTargets":
            return {
              targetInfos: [
                { targetId: "omnibox", type: "browser_ui" },
                ...[...pages].map(([targetId, page]) => ({ targetId, type: "page", browserContextId: DEFAULT_CONTEXT, ...page })),
              ],
            };
          case "Target.getBrowserContexts":
            return { browserContextIds: [...contexts.keys()], defaultBrowserContextId: DEFAULT_CONTEXT };
          case "Target.createBrowserContext": {
            const browserContextId = `context-${nextContext++}`;
            contexts.set(browserContextId, { disposeOnDetach: params.disposeOnDetach === true });
            return { browserContextId };
          }
          case "Target.disposeBrowserContext":
            if (!contexts.has(String(params.browserContextId))) {
              throw new Error("Failed to find context");
            }
            disposeContext(String(params.browserContextId));
            return {};
          case "Target.createTarget": {
            if (params.browserContextId !== undefined && !contexts.has(String(params.browserContextId))) {
              throw new Error("Failed to find browser context");
            }
            const targetId = `target-${nextTarget++}`;
            pages.set(targetId, params.browserContextId === undefined ? {} : { browserContextId: String(params.browserContextId) });
            return { targetId };
          }
          case "Target.closeTarget":
            pages.delete(String(params.targetId));
            return { success: true };
          case "Target.attachToTarget":
            return { sessionId: `session-${String(params.targetId)}` };
          case "Runtime.evaluate": {
            const expression = String(params.expression);
            if (expression === "document.readyState") {
              return { result: { value: "complete" } };
            }
            if (expression.includes("scrollIntoView")) {
              return { result: { value: locateResult } };
            }
            return { result: { value: `Title: page of ${String(sessionId)}` } };
          }
          default:
            return {};
        }
      },
    },
  };
}

type FakeChromium = ReturnType<typeof fakeChromium>;

function world() {
  const slots = new Map<string, Slot>([
    ["a", 1],
    ["b", 2],
  ]);
  const chromiums = new Map<number, FakeChromium>();
  let openLeases = 0;
  let acquires = 0;
  let acquireError: Error | null = null;
  let connects = 0;
  let connectError: Error | null = null;

  const chromiumOn = (port: number): FakeChromium => {
    let chromium = chromiums.get(port);
    if (chromium === undefined) {
      chromium = fakeChromium();
      chromiums.set(port, chromium);
    }
    return chromium;
  };
  const desktops: Pick<Desktops, "acquire" | "hold"> = {
    hold: () => () => {},
    acquire: async (botId) => {
      acquires += 1;
      if (acquireError !== null) {
        throw acquireError;
      }
      openLeases += 1;
      return {
        ...desktopOf(slots.get(botId) as Slot),
        release: () => {
          openLeases -= 1;
        },
      };
    },
  };
  const connector: CdpConnector = async (port) => {
    connects += 1;
    if (connectError !== null) {
      throw connectError;
    }
    return chromiumOn(port).client;
  };
  return {
    desktops,
    connector,
    slots,
    chromiumOn,
    chromiumOfBot: (botId: string) => chromiumOn(desktopOf(slots.get(botId) as Slot).cdpPort),
    openLeases: () => openLeases,
    acquires: () => acquires,
    connects: () => connects,
    failAcquire: (error: Error | null) => {
      acquireError = error;
    },
    failConnect: (error: Error | null) => {
      connectError = error;
    },
  };
}

const signal = new AbortController().signal;
const navigate: BrowserInvocation = { name: "browser_navigate", args: { url: "https://example.com/" } };
const snapshot: BrowserInvocation = { name: "browser_snapshot", args: {} };

let machine: ReturnType<typeof world>;
let chromium: FakeChromium;

beforeEach(() => {
  machine = world();
  chromium = machine.chromiumOfBot("a");
});

function browserOf() {
  return createBrowser({ desktops: machine.desktops, connector: machine.connector });
}

const look = (browser: ReturnType<typeof browserOf>, botId: string) => browser.execute({ browsing: undefined, botId, tool: snapshot, signal });
const lastEvaluated = (target: FakeChromium) =>
  target.sent.filter((entry) => entry.method === "Runtime.evaluate").at(-1)?.sessionId;

describe("browser", () => {
  it("sends each bot's commands only to that bot's browser", async () => {
    const browser = browserOf();
    await Promise.all([
      browser.execute({ browsing: undefined, botId: "a", tool: { name: "browser_navigate", args: { url: "https://a.example/" } }, signal }),
      browser.execute({ browsing: undefined, botId: "b", tool: { name: "browser_navigate", args: { url: "https://b.example/" } }, signal }),
    ]);
    const navigated = (target: FakeChromium) =>
      target.sent.filter((entry) => entry.method === "Page.navigate").map((entry) => entry.params.url);
    expect(navigated(machine.chromiumOfBot("a"))).toEqual(["https://a.example/"]);
    expect(navigated(machine.chromiumOfBot("b"))).toEqual(["https://b.example/"]);
  });

  it("acts on the blank page a browser starts with, and opens no other", async () => {
    const browser = browserOf();
    await browser.execute({ browsing: undefined, botId: "a", tool: navigate, signal });
    await look(browser, "a");
    expect([...chromium.pages.keys()]).toEqual(["target-0"]);
    expect(lastEvaluated(chromium)).toBe("session-target-0");
  });

  it("keeps a connection across calls", async () => {
    const browser = browserOf();
    await look(browser, "a");
    await look(browser, "a");
    expect(machine.connects()).toBe(1);
  });

  it("closes its lease after each call, and after an error", async () => {
    const browser = browserOf();
    await look(browser, "a");
    expect(machine.openLeases()).toBe(0);
    chromium.setLocate(null);
    await browser.execute({ browsing: undefined, botId: "a", tool: { name: "browser_click", args: { ref: 9 } }, signal });
    expect(machine.openLeases()).toBe(0);
  });

  it("finds the same page after computerd restarts", async () => {
    await look(browserOf(), "a");
    const after = browserOf();
    await look(after, "a");
    expect(lastEvaluated(chromium)).toBe("session-target-0");
    expect(chromium.pages.size).toBe(1);
  });

  it("opens a page when the browser has none", async () => {
    chromium.pages.clear();
    const result = await look(browserOf(), "a");
    expect(result.outcome).toBe("ok");
    expect(chromium.pages.size).toBe(1);
  });

  it("acts on a popup until it closes", async () => {
    const browser = browserOf();
    await look(browser, "a");
    const popup = chromium.openPopup("target-0");
    await look(browser, "a");
    expect(lastEvaluated(chromium)).toBe(`session-${popup}`);

    chromium.pages.delete(popup);
    await look(browser, "a");
    expect(lastEvaluated(chromium)).toBe("session-target-0");
  });

  it("stays on a popup that was open before computerd restarted", async () => {
    await look(browserOf(), "a");
    const popup = chromium.openPopup("target-0");
    await look(browserOf(), "a");
    expect(lastEvaluated(chromium)).toBe(`session-${popup}`);
  });

  it("sends a bot's typing only to that bot's page", async () => {
    const browser = browserOf();
    await Promise.all([
      browser.execute({ browsing: undefined, botId: "a", tool: { name: "browser_type", args: { ref: 1, text: "for a", submit: false } }, signal }),
      browser.execute({ browsing: undefined, botId: "b", tool: { name: "browser_type", args: { ref: 1, text: "for b", submit: false } }, signal }),
    ]);
    const typed = (target: FakeChromium) => target.sent.filter((entry) => entry.method === "Input.insertText").map((entry) => entry.params.text);
    expect(typed(machine.chromiumOfBot("a"))).toEqual(["for a"]);
    expect(typed(machine.chromiumOfBot("b"))).toEqual(["for b"]);
  });

  it("reports a stale ref as an error that tells the bot what to do", async () => {
    chromium.setLocate(null);
    const result = await browserOf().execute({ browsing: undefined, botId: "a", tool: { name: "browser_click", args: { ref: 9 } }, signal });
    expect(result.outcome).toBe("error");
    expect(result.output).toContain("take a new snapshot");
  });

  it("reports a stale ref after a browser restart lost the page, so a bot never clicks the wrong thing", async () => {
    const browser = browserOf();
    await look(browser, "a");
    chromium.closeSocket();
    chromium.pages.clear();
    chromium.pages.set("target-new", {});
    chromium.setLocate(null);
    const result = await browser.execute({ browsing: undefined, botId: "a", tool: { name: "browser_click", args: { ref: 3 } }, signal });
    expect(result.outcome).toBe("error");
    expect(result.output).toContain("take a new snapshot");
    expect(chromium.sent.some((entry) => entry.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("reports a computer with no browser as an error", async () => {
    machine.failAcquire(new Error("this computer has no running browser"));
    const result = await browserOf().execute({ browsing: undefined, botId: "a", tool: navigate, signal });
    expect(result).toMatchObject({ outcome: "error", truncated: false });
    expect(result.output).toContain("no running browser");
  });

  it("reports a desktop whose browser does not answer as an error, and closes the lease", async () => {
    machine.failConnect(new Error("this computer has no running browser"));
    const result = await browserOf().execute({ browsing: undefined, botId: "a", tool: navigate, signal });
    expect(result.output).toContain("no running browser");
    expect(machine.openLeases()).toBe(0);
  });

  it("reports every screen in use in words a bot can act on", async () => {
    machine.failAcquire(new Error("every screen on this computer is in use, so try again in a few minutes"));
    const result = await browserOf().execute({ browsing: undefined, botId: "a", tool: navigate, signal });
    expect(result.output).toContain("try again in a few minutes");
  });

  it("connects again after the browser restarts", async () => {
    const browser = browserOf();
    await look(browser, "a");
    chromium.closeSocket();
    const result = await look(browser, "a");
    expect(result.outcome).toBe("ok");
    expect(machine.connects()).toBe(2);
  });

  it("connects to the new port when a bot comes back on another slot", async () => {
    const browser = browserOf();
    await look(browser, "a");
    machine.slots.set("a", 5);
    const result = await look(browser, "a");
    expect(result.output).toMatch(/^Screen 5\n/);
    expect(machine.chromiumOfBot("a").sent.some((entry) => entry.method === "Target.getTargets")).toBe(true);
  });

  describe("a cancelled call", () => {
    const cancelled = () => {
      const abort = new AbortController();
      abort.abort(new Error("stopped"));
      return abort.signal;
    };
    const inputSent = () => chromium.sent.filter((entry) => entry.method.startsWith("Input."));

    it.each<BrowserInvocation>([
      { name: "browser_click", args: { ref: 1 } },
      { name: "browser_type", args: { ref: 1, text: "x", submit: true } },
      { name: "browser_press", args: { key: "Enter" } },
      { name: "browser_navigate", args: { url: "https://example.com/" } },
    ])("sends nothing to the page for $name", async (tool) => {
      const result = await browserOf().execute({ browsing: undefined, botId: "a", tool, signal: cancelled() });
      expect(result.outcome).toBe("cancelled");
      expect(inputSent()).toEqual([]);
      expect(chromium.sent.filter((entry) => entry.method === "Page.navigate")).toEqual([]);
    });

    it("sends nothing when the cancel arrives during a slow start, and closes the lease", async () => {
      const abort = new AbortController();
      const browser = createBrowser({
        connector: machine.connector,
        desktops: {
          ...machine.desktops,
          acquire: async (botId) => {
            const lease = await machine.desktops.acquire(botId);
            abort.abort(new Error("stopped"));
            return lease;
          },
        },
      });
      const result = await browser.execute({ browsing: undefined, botId: "a", tool: { name: "browser_click", args: { ref: 1 } }, signal: abort.signal });
      expect(result.outcome).toBe("cancelled");
      expect(inputSent()).toEqual([]);
      expect(machine.openLeases()).toBe(0);
    });

    it("sends nothing when the cancel arrives while a take-over's cookies are read", async () => {
      const abort = new AbortController();
      const browser = createBrowser({
        connector: machine.connector,
        desktops: machine.desktops,
        takeoverSettled: async () => abort.abort(new Error("stopped")),
      });
      const result = await browser.execute({ browsing: undefined, botId: "a", tool: navigate, signal: abort.signal });
      expect(result.outcome).toBe("cancelled");
      expect(machine.acquires()).toBe(0);
    });

    it("starts no browser step until a take-over's cookies are read", async () => {
      let read = () => {};
      const browser = createBrowser({
        connector: machine.connector,
        desktops: machine.desktops,
        takeoverSettled: () => new Promise((resolve) => (read = resolve)),
      });
      const running = browser.execute({ browsing: undefined, botId: "a", tool: navigate, signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(machine.acquires()).toBe(0);
      read();
      expect((await running).outcome).toBe("ok");
    });

    it("sends nothing when the cancel arrives while the call waits in the queue", async () => {
      const browser = browserOf();
      await look(browser, "a");
      chromium.sent.length = 0;
      const abort = new AbortController();
      const earlier = browser.execute({ browsing: undefined, botId: "a", tool: snapshot, signal });
      const queued = browser.execute({
        browsing: undefined,
        botId: "a",
        tool: { name: "browser_type", args: { ref: 1, text: "x", submit: true } },
        signal: abort.signal,
      });
      abort.abort(new Error("stopped"));
      await earlier;
      expect((await queued).outcome).toBe("cancelled");
      expect(inputSent()).toEqual([]);
    });

    it("does not press Enter when the cancel arrives after the text", async () => {
      const browser = browserOf();
      await look(browser, "a");
      const abort = new AbortController();
      chromium.onSend((method) => {
        if (method === "Input.insertText") {
          abort.abort(new Error("stopped"));
        }
      });
      const result = await browser.execute({
        browsing: undefined,
        botId: "a",
        tool: { name: "browser_type", args: { ref: 1, text: "x", submit: true } },
        signal: abort.signal,
      });
      expect(result.outcome).toBe("cancelled");
      expect(inputSent().some((entry) => entry.method === "Input.dispatchKeyEvent")).toBe(false);
    });
  });

  describe("a page's dialogs", () => {
    const SESSION = "session-target-0";
    const opens = (type: string, sessionId = SESSION) => chromium.emit("Page.javascriptDialogOpening", { type, message: "hi" }, sessionId);
    const answers = () => chromium.sent.filter((entry) => entry.method === "Page.handleJavaScriptDialog");

    it("watches every page from the moment the connection opens", async () => {
      await look(browserOf(), "a");
      expect(chromium.sent.find((entry) => entry.method === "Target.setAutoAttach")).toMatchObject({
        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "page" }] },
      });
    });

    it.each(["alert", "confirm", "prompt"])("refuses %s, with no call running", async (type) => {
      await look(browserOf(), "a");
      opens(type);
      expect(answers()).toEqual([{ method: "Page.handleJavaScriptDialog", params: { accept: false }, sessionId: SESSION }]);
    });

    it("lets a page go at beforeunload, so a page cannot refuse a navigation", async () => {
      await look(browserOf(), "a");
      opens("beforeunload");
      expect(answers()).toEqual([{ method: "Page.handleJavaScriptDialog", params: { accept: true }, sessionId: SESSION }]);
    });

    it("enables Page on a new popup before the popup runs, and answers its dialog", async () => {
      await look(browserOf(), "a");
      chromium.sent.length = 0;
      chromium.emit("Target.attachedToTarget", { sessionId: "popup", targetInfo: { targetId: "target-9", type: "page" }, waitingForDebugger: true });
      const methods = chromium.sent.map((entry) => entry.method);
      expect(methods.indexOf("Page.enable")).toBeGreaterThanOrEqual(0);
      expect(methods.indexOf("Page.enable")).toBeLessThan(methods.indexOf("Runtime.runIfWaitingForDebugger"));
      opens("alert", "popup");
      expect(answers()[0]?.sessionId).toBe("popup");
    });

    it("uses the session it was given, and opens no second one for that page", async () => {
      const browser = browserOf();
      await look(browser, "a");
      chromium.pages.set("target-9", {});
      chromium.emit("Target.attachedToTarget", { sessionId: "auto", targetInfo: { targetId: "target-9", type: "page" }, waitingForDebugger: false });
      await look(browser, "a");
      expect(lastEvaluated(chromium)).toBe("auto");
      expect(chromium.sent.filter((entry) => entry.method === "Target.attachToTarget" && entry.params.targetId === "target-9")).toEqual([]);
    });

    it("leaves a dialog to a person who has the screen, and clears what is left at the next call", async () => {
      let person = true;
      const browser = createBrowser({ desktops: machine.desktops, connector: machine.connector, personHasScreen: () => person });
      await look(browser, "a");
      opens("confirm");
      expect(answers()).toEqual([]);
      await look(browser, "a");
      expect(answers()).toEqual([]);
      person = false;
      await look(browser, "a");
      expect(answers()).toEqual([{ method: "Page.handleJavaScriptDialog", params: { accept: false }, sessionId: SESSION }]);
    });

    it("closes the lease when a cancel arrives while the browser has not taken the watch", async () => {
      const browser = createBrowser({ desktops: machine.desktops, connector: machine.connector });
      chromium.stall("Target.setAutoAttach");
      const abort = new AbortController();
      const running = browser.execute({ browsing: undefined, botId: "a", tool: snapshot, signal: abort.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      abort.abort(new Error("stopped"));
      expect((await running).outcome).toBe("cancelled");
      expect(machine.openLeases()).toBe(0);
    });
  });

  describe("a page that does not answer", () => {
    const QUICK = { toolDeadlineMs: 600, frozenProbeMs: 30 };
    const quick = (extra = {}) => createBrowser({ desktops: machine.desktops, connector: machine.connector, ...QUICK, ...extra });
    const closed = () => chromium.sent.filter((entry) => entry.method === "Target.closeTarget").map((entry) => entry.params.targetId);

    it("ends the call at its deadline, closes the page and the lease, and tells the model", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.freezePage();
      const result = await look(browser, "a");
      expect(result.outcome).toBe("timeout");
      expect(result.output).toContain("did not finish in 0.6 seconds");
      expect(result.output).toContain("froze and was closed");
      expect(closed()).toEqual(["target-0"]);
      expect(machine.openLeases()).toBe(0);
    });

    it("gives the next call a new page", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.freezePage();
      await look(browser, "a");
      const next = await look(browser, "a");
      expect(next.outcome).toBe("ok");
      expect([...chromium.pages.keys()]).toEqual(["target-1"]);
      expect(lastEvaluated(chromium)).toBe("session-target-1");
    });

    it("opens the new page before it closes the frozen one, because a browser exits with its last page", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.freezePage();
      await look(browser, "a");
      const methods = chromium.sent.map((entry) => entry.method);
      expect(methods.lastIndexOf("Target.createTarget")).toBeLessThan(methods.lastIndexOf("Target.closeTarget"));
      expect(methods.lastIndexOf("Target.createTarget")).toBeGreaterThanOrEqual(0);
    });

    it("closes only the frozen page, and leaves the bot's other pages", async () => {
      const browser = quick();
      await look(browser, "a");
      const popup = chromium.openPopup("target-0");
      await look(browser, "a");
      chromium.freezePage(popup);
      await look(browser, "a");
      expect(closed()).toEqual([popup]);
      expect(chromium.pages.has("target-0")).toBe(true);
    });

    it("ends the call at once when its signal aborts, says cancelled, and still closes the frozen page", async () => {
      const browser = quick({ toolDeadlineMs: 60_000 });
      await look(browser, "a");
      chromium.freezePage();
      const abort = new AbortController();
      const started = Date.now();
      const running = browser.execute({ browsing: undefined, botId: "a", tool: navigate, signal: abort.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      abort.abort(new Error("stopped"));
      const result = await running;
      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.outcome).toBe("cancelled");
      expect(result.output).toContain("cancelled");
      expect(result.output).toContain("froze and was closed");
      expect(machine.openLeases()).toBe(0);
    });

    it("takes a server that never answers for a slow call, stops the navigation, and leaves the page", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.stallNavigation();
      const result = await browser.execute({ browsing: undefined, botId: "a", tool: navigate, signal });
      expect(result.outcome).toBe("timeout");
      expect(result.output).not.toContain("froze");
      expect(chromium.sent.some((entry) => entry.method === "Page.stopLoading")).toBe(true);
      expect(closed()).toEqual([]);
      expect((await look(browser, "a")).outcome).toBe("ok");
    });

    it("says cancelled without blaming a page that answers", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.stallNavigation();
      const abort = new AbortController();
      const running = browser.execute({ browsing: undefined, botId: "a", tool: navigate, signal: abort.signal });
      await new Promise((resolve) => setTimeout(resolve, 10));
      abort.abort(new Error("stopped"));
      const result = await running;
      expect(result.outcome).toBe("cancelled");
      expect(result.output).not.toContain("froze");
      expect(closed()).toEqual([]);
    });

    it("does not close a page under a person who has the screen", async () => {
      const browser = quick({ personHasScreen: () => true });
      await look(browser, "a");
      chromium.freezePage();
      const result = await look(browser, "a");
      expect(result.outcome).toBe("timeout");
      expect(result.output).toContain("owner has the screen");
      expect(closed()).toEqual([]);
      expect(chromium.sent.some((entry) => entry.method === "Page.stopLoading")).toBe(false);
    });

    it("does not close a page under a person who takes the screen during the probe", async () => {
      let asked = 0;
      const browser = quick({ personHasScreen: () => (asked += 1) > 1 });
      await look(browser, "a");
      chromium.freezePage();
      const result = await look(browser, "a");
      expect(result.output).toContain("owner has the screen");
      expect(closed()).toEqual([]);
      expect(chromium.sent.some((entry) => entry.method === "Page.stopLoading")).toBe(true);
    });

    it("counts a page that is already gone as closed", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.freezePage();
      chromium.failNext("Target.closeTarget");
      const result = await look(browser, "a");
      expect(result.output).toContain("froze and was closed");
    });

    it("keeps the frozen page when no new page opens, so the browser does not exit with its last page", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.freezePage();
      chromium.failNext("Target.createTarget");
      const result = await look(browser, "a");
      expect(result.output).toContain("did not close it");
      expect(closed()).toEqual([]);
    });

    it("says so when the browser does not close the page", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.freezePage();
      chromium.stall("Target.closeTarget");
      const result = await look(browser, "a");
      expect(result.outcome).toBe("timeout");
      expect(result.output).toContain("did not close it");
      expect(machine.openLeases()).toBe(0);
    });

    it("lets the bot's queue move on, and another bot never waits", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.freezePage();
      const first = look(browser, "a");
      const queued = look(browser, "a");
      const other = await look(browser, "b");
      expect(other.outcome).toBe("ok");
      expect((await first).outcome).toBe("timeout");
      expect((await queued).outcome).toBe("ok");
    });

    it("finds a page that froze before computerd restarted, and closes it", async () => {
      await look(quick(), "a");
      chromium.freezePage();
      const after = quick();
      expect((await look(after, "a")).output).toContain("froze and was closed");
      expect((await look(after, "a")).outcome).toBe("ok");
    });

    it("sends nothing after the deadline", async () => {
      const browser = quick();
      await look(browser, "a");
      chromium.freezePage();
      await browser.execute({ browsing: undefined, botId: "a", tool: { name: "browser_type", args: { ref: 1, text: "x", submit: true } }, signal });
      chromium.thaw();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(chromium.sent.some((entry) => entry.method === "Input.insertText")).toBe(false);
    });

    it("keeps the journal's rule, so a repeat of a frozen call replays its result and touches nothing", async () => {
      const dir = await mkdtemp(join(tmpdir(), "journal-"));
      const browser = quick();
      await look(browser, "a");
      chromium.freezePage();
      const calls = createCalls({
        journal: await openJournal({ dir }),
        execute: ({ botId, tool, signal: callSignal }) => browser.execute({ browsing: undefined, botId, tool: tool as BrowserInvocation, signal: callSignal }),
      });
      const request = { callId: "run:call", botId: "a", tool: snapshot };
      const first = await calls.call(request);
      const sentBefore = chromium.sent.length;
      expect(await calls.call(request)).toEqual(first);
      expect(chromium.sent.length).toBe(sentBefore);
      await rm(dir, { recursive: true, force: true });
    });

    it("lets the idle stop run and frees the slot, on the real desktops code", async () => {
      let clock = 0;
      const stops: Slot[] = [];
      const runtimeDir = await mkdtemp(join(tmpdir(), "runtime-"));
      const desktops = createDesktops({
        systemd: {
          start: async () => {},
          stop: async (slot) => {
            stops.push(slot);
          },
          restartInput: async () => {},
          liveSlots: async () => [],
        },
        runtimeDir,
        now: () => clock,
      });
      const browser = createBrowser({ desktops, connector: machine.connector, ...QUICK });
      await browser.execute({ browsing: undefined, botId: "a", tool: snapshot, signal });
      const port = desktopOf(1).cdpPort;
      const onPort = machine.chromiumOn(port);
      onPort.freezePage();
      const release = desktops.hold("a");
      const running = browser.execute({ browsing: undefined, botId: "a", tool: snapshot, signal }).finally(release);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stopsWhileRunning = stops.length;
      clock += IDLE_STOP_MS * 2;
      await desktops.sweep();
      expect(stops.length).toBe(stopsWhileRunning);
      expect((await running).output).toContain("froze and was closed");
      clock += IDLE_STOP_MS * 2;
      await desktops.sweep();
      expect(stops.length).toBe(stopsWhileRunning + 1);
      await rm(runtimeDir, { recursive: true, force: true });
    });
  });

  describe("a logged-out call", () => {
    const loggedOut: Browsing = { kind: "loggedOut", key: "run-1" };
    const QUICK = { toolDeadlineMs: 600, frozenProbeMs: 30 };
    const quick = (extra = {}) => createBrowser({ desktops: machine.desktops, connector: machine.connector, ...QUICK, ...extra });
    const contextOf = (targetId: string) => chromium.pages.get(targetId)?.browserContextId;
    const sentOn = (method: string) => chromium.sent.filter((entry) => entry.method === method);
    const navigatedOn = () => sentOn("Page.navigate").map((entry) => entry.sessionId);
    const browse = (browser: ReturnType<typeof createBrowser>, browsing: Browsing | undefined, tool: BrowserInvocation = snapshot, botId = "a") => browser.execute({ botId, tool, browsing, signal });

    it("opens its page in a new context with downloads denied, and leaves the bot's own page alone", async () => {
      const browser = browserOf();
      const result = await browse(browser, loggedOut, navigate);
      expect(result.outcome).toBe("ok");
      expect(sentOn("Target.createBrowserContext")[0]?.params).toEqual({ disposeOnDetach: true });
      const [context] = chromium.contexts.keys();
      expect(sentOn("Browser.setDownloadBehavior")[0]?.params).toEqual({ behavior: "deny", browserContextId: context });
      const page = [...chromium.pages.keys()].find((targetId) => contextOf(targetId) === context);
      expect(navigatedOn()).toEqual([`session-${page}`]);
      expect(chromium.sent.some((entry) => entry.sessionId === "session-target-0")).toBe(false);
    });

    it("denies downloads before it opens a page", async () => {
      await browse(browserOf(), loggedOut);
      const methods = chromium.sent.map((entry) => entry.method);
      expect(methods.indexOf("Browser.setDownloadBehavior")).toBeLessThan(methods.indexOf("Target.createTarget"));
    });

    it("keeps its context and page for the same key", async () => {
      const browser = browserOf();
      await browse(browser, loggedOut, navigate);
      const session = lastEvaluated(chromium);
      await browse(browser, loggedOut);
      expect(lastEvaluated(chromium)).toBe(session);
      expect(sentOn("Target.createBrowserContext")).toHaveLength(1);
    });

    it("follows a popup that a logged-out page opens, and never one of the bot's own", async () => {
      const browser = browserOf();
      await browse(browser, loggedOut);
      const [page] = [...chromium.pages.keys()].filter((targetId) => contextOf(targetId) !== undefined);
      const popup = chromium.openPopup(page as string);
      chromium.openPopup("target-0");
      await browse(browser, loggedOut);
      expect(contextOf(popup)).toBe(contextOf(page as string));
      expect(lastEvaluated(chromium)).toBe(`session-${popup}`);
    });

    it("leaves a chat call on the bot's own page, and ends the window that a finished run left", async () => {
      const browser = browserOf();
      await browse(browser, loggedOut, navigate);
      await browse(browser, undefined);
      expect(lastEvaluated(chromium)).toBe("session-target-0");
      expect(chromium.contexts.size).toBe(0);
      expect([...chromium.pages.keys()]).toEqual(["target-0"]);
    });

    it("does not take another context's page for the bot's own after computerd restarts", async () => {
      chromium.contexts.set("context-old", { disposeOnDetach: false });
      chromium.pages.set("target-old", { browserContextId: "context-old" });
      await browse(browserOf(), undefined);
      expect(lastEvaluated(chromium)).toBe("session-target-0");
    });

    it("ends the first context when a call for another key arrives", async () => {
      const browser = browserOf();
      await browse(browser, loggedOut);
      const [first] = chromium.contexts.keys();
      await browse(browser, { kind: "loggedOut", key: "run-2" });
      expect(chromium.contexts.has(first as string)).toBe(false);
      expect(chromium.contexts.size).toBe(1);
    });

    it("ends only the window of the key that endBrowsing names", async () => {
      const browser = browserOf();
      await browse(browser, loggedOut);
      await browser.endBrowsing("a", "run-other");
      expect(chromium.contexts.size).toBe(1);
      await browser.endBrowsing("a", "run-1");
      expect(chromium.contexts.size).toBe(0);
      expect(chromium.exited()).toBe(false);
    });

    it("starts no desktop to end a window that is not there, and ending twice is safe", async () => {
      const browser = browserOf();
      await browser.endBrowsing("a", "run-1");
      expect(machine.acquires()).toBe(0);
      await browse(browser, loggedOut);
      await browser.endBrowsing("a", "run-1");
      await browser.endBrowsing("a", "run-1");
      expect(sentOn("Target.disposeBrowserContext")).toHaveLength(1);
    });

    it("waits its turn behind a running call before it ends the window", async () => {
      const browser = browserOf();
      const running = browse(browser, loggedOut, navigate);
      await browser.endBrowsing("a", "run-1");
      expect((await running).outcome).toBe("ok");
      expect(chromium.contexts.size).toBe(0);
    });

    it("opens a page of the bot's own first, because a browser exits with its last page", async () => {
      const browser = browserOf();
      await browse(browser, loggedOut);
      chromium.pages.delete("target-0");
      await browser.endBrowsing("a", "run-1");
      expect(chromium.exited()).toBe(false);
      expect([...chromium.pages.values()].some((page) => page.browserContextId === undefined)).toBe(true);
    });

    it.each(["Target.createBrowserContext", "Browser.setDownloadBehavior", "Target.createTarget"])("fails closed when %s fails, and never browses in the default context", async (method) => {
      const browser = browserOf();
      await browse(browser, undefined);
      chromium.sent.length = 0;
      chromium.failNext(method);
      const result = await browse(browser, loggedOut, navigate);
      expect(result.outcome).toBe("error");
      expect(navigatedOn()).toEqual([]);
      expect(chromium.sent.some((entry) => entry.sessionId === "session-target-0")).toBe(false);
    });

    it("does not keep a context whose downloads it could not deny", async () => {
      const browser = browserOf();
      chromium.failNext("Browser.setDownloadBehavior");
      await browse(browser, loggedOut);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(chromium.contexts.size).toBe(0);
    });

    it("refuses a browser that does not name its default context", async () => {
      const original = chromium.client.send;
      chromium.client.send = async (method, params, sessionId) => (method === "Target.getBrowserContexts" ? { browserContextIds: [] } : original(method, params, sessionId));
      const result = await browse(browserOf(), loggedOut, navigate);
      expect(result.outcome).toBe("error");
      expect(result.output).toContain("default context");
      expect(navigatedOn()).toEqual([]);
    });

    describe("a page that freezes", () => {
      const frozenPage = async (browser: ReturnType<typeof quick>) => {
        await browse(browser, loggedOut);
        const page = [...chromium.pages.keys()].find((targetId) => contextOf(targetId) !== undefined) as string;
        chromium.freezePage(page);
        chromium.sent.length = 0;
        return page;
      };

      it("ends the whole context, tells the model, and opens nothing in the default context", async () => {
        const browser = quick();
        const page = await frozenPage(browser);
        const result = await browse(browser, loggedOut);
        expect(result.outcome).toBe("timeout");
        expect(result.output).toContain("froze and was closed");
        expect(chromium.pages.has(page)).toBe(false);
        expect(chromium.contexts.size).toBe(0);
        expect([...chromium.pages.keys()]).toEqual(["target-0"]);
        expect(sentOn("Target.createTarget")).toEqual([]);
        expect(machine.openLeases()).toBe(0);
      });

      it("gives the next call a blank page in a new context, never the bot's own page", async () => {
        const browser = quick();
        await frozenPage(browser);
        await browse(browser, loggedOut);
        chromium.sent.length = 0;
        expect((await browse(browser, loggedOut, navigate)).outcome).toBe("ok");
        const [context] = chromium.contexts.keys();
        expect(sentOn("Target.createTarget")[0]?.params).toEqual({ url: "about:blank", browserContextId: context });
        expect(chromium.sent.some((entry) => entry.sessionId === "session-target-0")).toBe(false);
      });

      it("stays open while a person has the screen", async () => {
        const browser = quick({ personHasScreen: () => true });
        await frozenPage(browser);
        const result = await browse(browser, loggedOut);
        expect(result.output).toContain("owner has the screen");
        expect(chromium.contexts.size).toBe(1);
      });

      it("drops the socket when the browser does not end the context, and the next call connects again", async () => {
        const browser = quick();
        await frozenPage(browser);
        chromium.failNext("Target.disposeBrowserContext");
        const result = await browse(browser, loggedOut);
        expect(result.output).toContain("did not close it");
        expect(chromium.socketsClosed()).toBe(1);
        expect(chromium.contexts.size).toBe(0);
        const connects = machine.connects();
        expect((await browse(browser, loggedOut)).outcome).toBe("ok");
        expect(machine.connects()).toBe(connects + 1);
      });
    });

    it("ends a window that no call used for the idle limit", async () => {
      const browser = createBrowser({ desktops: machine.desktops, connector: machine.connector, loggedOutIdleMs: 20 });
      await browse(browser, loggedOut);
      expect(chromium.contexts.size).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(chromium.contexts.size).toBe(0);
      expect(machine.openLeases()).toBe(0);
    });

    it("counts the idle limit from the last call", async () => {
      const browser = createBrowser({ desktops: machine.desktops, connector: machine.connector, loggedOutIdleMs: 60 });
      await browse(browser, loggedOut);
      for (let round = 0; round < 3; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await browse(browser, loggedOut);
      }
      expect(sentOn("Target.createBrowserContext")).toHaveLength(1);
      expect(chromium.contexts.size).toBe(1);
    });

    it("makes a new context for the same key after computerd restarts, because the old one ended with its socket", async () => {
      await browse(browserOf(), loggedOut, navigate);
      chromium.dropSocket();
      expect(chromium.contexts.size).toBe(0);
      const result = await browse(browserOf(), loggedOut);
      expect(result.outcome).toBe("ok");
      expect(chromium.contexts.size).toBe(1);
      expect(sentOn("Target.createBrowserContext")).toHaveLength(2);
    });

    it("makes a new context when the browser restarted under the same key", async () => {
      const browser = browserOf();
      await browse(browser, loggedOut);
      chromium.dropSocket();
      chromium.pages.clear();
      chromium.pages.set("target-new", {});
      expect((await browse(browser, loggedOut)).outcome).toBe("ok");
      expect(machine.connects()).toBe(2);
      expect(chromium.contexts.size).toBe(1);
    });

    it("keeps the journal's rule, so a repeat replays its result and makes no context", async () => {
      const dir = await mkdtemp(join(tmpdir(), "journal-"));
      const browser = browserOf();
      const calls = createCalls({
        journal: await openJournal({ dir }),
        execute: ({ botId, tool, browsing, signal: callSignal }) => browser.execute({ botId, tool: tool as BrowserInvocation, browsing, signal: callSignal }),
      });
      const request = { callId: "run-1:call", botId: "a", tool: navigate, browsing: loggedOut };
      const first = await calls.call(request);
      await browser.endBrowsing("a", "run-1");
      chromium.sent.length = 0;
      expect(await calls.call(request)).toEqual(first);
      expect(chromium.sent).toEqual([]);
      expect(chromium.contexts.size).toBe(0);
      await rm(dir, { recursive: true, force: true });
    });
  });

  it("keeps one bot's steps in order, and another bot does not wait", async () => {
    const browser = browserOf();
    await look(browser, "a");
    const order: string[] = [];
    const first = browser.execute({ browsing: undefined, botId: "a", tool: navigate, signal }).then(() => order.push("a first"));
    const second = browser.execute({ browsing: undefined, botId: "a", tool: snapshot, signal }).then(() => order.push("a second"));
    const other = browser.execute({ browsing: undefined, botId: "b", tool: snapshot, signal }).then(() => order.push("b"));
    await Promise.all([first, second, other]);
    expect(order.indexOf("a first")).toBeLessThan(order.indexOf("a second"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a second"));
  });

  it("reads the popup when an action opens one during the wait, so the next action matches the snapshot", async () => {
    const browser = browserOf();
    await look(browser, "a");
    let popup = "";
    chromium.onSend((method) => {
      if (method === "Input.dispatchMouseEvent" && popup === "") {
        popup = "pending";
        setTimeout(() => {
          popup = chromium.openPopup("target-0");
        }, 50);
      }
    });
    const result = await browser.execute({ browsing: undefined, botId: "a", tool: { name: "browser_click", args: { ref: 1 } }, signal });
    expect(result.outcome).toBe("ok");
    expect(popup).toMatch(/^target-/);
    expect(result.output).toContain(`session-${popup}`);
  });

  it("returns a snapshot that names the screen", async () => {
    const result = await browserOf().execute({ browsing: undefined, botId: "b", tool: navigate, signal });
    expect(result.outcome).toBe("ok");
    expect(result.output).toMatch(/^Screen 2\n/);
  });
});

describe("nextPages", () => {
  const page = (targetId: string, openerId?: string) => ({ targetId, type: "page", ...(openerId === undefined ? {} : { openerId }) });

  it("ignores targets that are not pages", () => {
    expect(nextPages([], [{ targetId: "omnibox", type: "browser_ui" }, page("p")])).toEqual(["p"]);
  });

  it("keeps known pages in order and puts a new page last, wherever Chromium lists it", () => {
    expect(nextPages(["old"], [page("new"), page("old")])).toEqual(["old", "new"]);
  });

  it("drops a closed page, so the one under it is current", () => {
    expect(nextPages(["old", "popup"], [page("old")])).toEqual(["old"]);
  });

  it("puts a page with an opener last when it first sees them together", () => {
    expect(nextPages([], [page("popup", "opener"), page("opener")])).toEqual(["opener", "popup"]);
  });
});
