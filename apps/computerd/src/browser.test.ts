import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserInvocation } from "@bots/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createBrowser, nextPages, type CdpConnector, type CdpEvent } from "./browser.ts";
import { createCalls } from "./calls.ts";
import { createDesktops, desktopOf, IDLE_STOP_MS, type Desktops, type Slot } from "./desktops.ts";
import { openJournal } from "./journal.ts";

type Sent = { method: string; params: Record<string, unknown>; sessionId: string | undefined };

function fakeChromium() {
  const pages = new Map<string, { openerId?: string }>([["target-0", {}]]);
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
    sent,
    openPopup: (openerId: string) => {
      const targetId = `target-${nextTarget++}`;
      pages.set(targetId, { openerId });
      return targetId;
    },
    closeSocket: () => closeListeners.splice(0).forEach((listener) => listener()),
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
      close: () => {},
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
                ...[...pages].map(([targetId, page]) => ({ targetId, type: "page", ...page })),
              ],
            };
          case "Target.createTarget": {
            const targetId = `target-${nextTarget++}`;
            pages.set(targetId, {});
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

const look = (browser: ReturnType<typeof browserOf>, botId: string) => browser.execute({ botId, tool: snapshot, signal });
const lastEvaluated = (target: FakeChromium) =>
  target.sent.filter((entry) => entry.method === "Runtime.evaluate").at(-1)?.sessionId;

describe("browser", () => {
  it("sends each bot's commands only to that bot's browser", async () => {
    const browser = browserOf();
    await Promise.all([
      browser.execute({ botId: "a", tool: { name: "browser_navigate", args: { url: "https://a.example/" } }, signal }),
      browser.execute({ botId: "b", tool: { name: "browser_navigate", args: { url: "https://b.example/" } }, signal }),
    ]);
    const navigated = (target: FakeChromium) =>
      target.sent.filter((entry) => entry.method === "Page.navigate").map((entry) => entry.params.url);
    expect(navigated(machine.chromiumOfBot("a"))).toEqual(["https://a.example/"]);
    expect(navigated(machine.chromiumOfBot("b"))).toEqual(["https://b.example/"]);
  });

  it("acts on the blank page a browser starts with, and opens no other", async () => {
    const browser = browserOf();
    await browser.execute({ botId: "a", tool: navigate, signal });
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
    await browser.execute({ botId: "a", tool: { name: "browser_click", args: { ref: 9 } }, signal });
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
      browser.execute({ botId: "a", tool: { name: "browser_type", args: { ref: 1, text: "for a", submit: false } }, signal }),
      browser.execute({ botId: "b", tool: { name: "browser_type", args: { ref: 1, text: "for b", submit: false } }, signal }),
    ]);
    const typed = (target: FakeChromium) => target.sent.filter((entry) => entry.method === "Input.insertText").map((entry) => entry.params.text);
    expect(typed(machine.chromiumOfBot("a"))).toEqual(["for a"]);
    expect(typed(machine.chromiumOfBot("b"))).toEqual(["for b"]);
  });

  it("reports a stale ref as an error that tells the bot what to do", async () => {
    chromium.setLocate(null);
    const result = await browserOf().execute({ botId: "a", tool: { name: "browser_click", args: { ref: 9 } }, signal });
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
    const result = await browser.execute({ botId: "a", tool: { name: "browser_click", args: { ref: 3 } }, signal });
    expect(result.outcome).toBe("error");
    expect(result.output).toContain("take a new snapshot");
    expect(chromium.sent.some((entry) => entry.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("reports a computer with no browser as an error", async () => {
    machine.failAcquire(new Error("this computer has no running browser"));
    const result = await browserOf().execute({ botId: "a", tool: navigate, signal });
    expect(result).toMatchObject({ outcome: "error", truncated: false });
    expect(result.output).toContain("no running browser");
  });

  it("reports a desktop whose browser does not answer as an error, and closes the lease", async () => {
    machine.failConnect(new Error("this computer has no running browser"));
    const result = await browserOf().execute({ botId: "a", tool: navigate, signal });
    expect(result.output).toContain("no running browser");
    expect(machine.openLeases()).toBe(0);
  });

  it("reports every screen in use in words a bot can act on", async () => {
    machine.failAcquire(new Error("every screen on this computer is in use, so try again in a few minutes"));
    const result = await browserOf().execute({ botId: "a", tool: navigate, signal });
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
      const result = await browserOf().execute({ botId: "a", tool, signal: cancelled() });
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
      const result = await browser.execute({ botId: "a", tool: { name: "browser_click", args: { ref: 1 } }, signal: abort.signal });
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
      const result = await browser.execute({ botId: "a", tool: navigate, signal: abort.signal });
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
      const running = browser.execute({ botId: "a", tool: navigate, signal });
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
      const earlier = browser.execute({ botId: "a", tool: snapshot, signal });
      const queued = browser.execute({
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
      expect(chromium.sent[0]).toMatchObject({
        method: "Target.setAutoAttach",
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
      const running = browser.execute({ botId: "a", tool: snapshot, signal: abort.signal });
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
      const running = browser.execute({ botId: "a", tool: navigate, signal: abort.signal });
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
      const result = await browser.execute({ botId: "a", tool: navigate, signal });
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
      const running = browser.execute({ botId: "a", tool: navigate, signal: abort.signal });
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
      const browser = quick({ personHasScreen: () => chromium.sent.some((entry) => entry.method === "Page.stopLoading") });
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
      await browser.execute({ botId: "a", tool: { name: "browser_type", args: { ref: 1, text: "x", submit: true } }, signal });
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
        execute: ({ botId, tool, signal: callSignal }) => browser.execute({ botId, tool: tool as BrowserInvocation, signal: callSignal }),
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
      await browser.execute({ botId: "a", tool: snapshot, signal });
      const port = desktopOf(1).cdpPort;
      const onPort = machine.chromiumOn(port);
      onPort.freezePage();
      const release = desktops.hold("a");
      const running = browser.execute({ botId: "a", tool: snapshot, signal }).finally(release);
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

  it("keeps one bot's steps in order, and another bot does not wait", async () => {
    const browser = browserOf();
    await look(browser, "a");
    const order: string[] = [];
    const first = browser.execute({ botId: "a", tool: navigate, signal }).then(() => order.push("a first"));
    const second = browser.execute({ botId: "a", tool: snapshot, signal }).then(() => order.push("a second"));
    const other = browser.execute({ botId: "b", tool: snapshot, signal }).then(() => order.push("b"));
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
    const result = await browser.execute({ botId: "a", tool: { name: "browser_click", args: { ref: 1 } }, signal });
    expect(result.outcome).toBe("ok");
    expect(popup).toMatch(/^target-/);
    expect(result.output).toContain(`session-${popup}`);
  });

  it("returns a snapshot that names the screen", async () => {
    const result = await browserOf().execute({ botId: "b", tool: navigate, signal });
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
