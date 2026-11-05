import type { BrowserInvocation } from "@bots/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createBrowser, nextPages, type CdpConnector } from "./browser.ts";
import { desktopOf, type Desktops, type Slot } from "./desktops.ts";

type Sent = { method: string; params: Record<string, unknown>; sessionId: string | undefined };

// One bot's Chromium, as a real one looks: it starts with a blank page and has targets that are not pages.
function fakeChromium() {
  const pages = new Map<string, { openerId?: string }>([["target-0", {}]]);
  const bounds = new Map<string, Record<string, unknown>>();
  const sent: Sent[] = [];
  const closeListeners: Array<() => void> = [];
  let nextTarget = 1;
  let locateResult: { x: number; y: number } | null = { x: 10, y: 20 };
  let sendHook: ((method: string) => void) | undefined;

  return {
    pages,
    bounds,
    sent,
    openPopup: (openerId: string) => {
      const targetId = `target-${nextTarget++}`;
      pages.set(targetId, { openerId });
      return targetId;
    },
    closeSocket: () => closeListeners.splice(0).forEach((listener) => listener()),
    onSend: (hook: (method: string) => void) => {
      sendHook = hook;
    },
    setLocate: (value: { x: number; y: number } | null) => {
      locateResult = value;
    },
    client: {
      onClose: (listener: () => void) => {
        closeListeners.push(listener);
      },
      send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
        sent.push({ method, params, sessionId });
        sendHook?.(method);
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
          case "Target.attachToTarget":
            return { sessionId: `session-${String(params.targetId)}` };
          case "Browser.getWindowForTarget":
            return { windowId: 1, bounds: bounds.get(String(params.targetId)) ?? { left: 0, top: 27 } };
          case "Runtime.evaluate": {
            const expression = String(params.expression);
            if (expression === "document.readyState") {
              return { result: { value: "complete" } };
            }
            if (expression === "outerHeight - innerHeight") {
              return { result: { value: 85 } };
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

// Each bot has a fixed slot here. The real policy is in desktops.test.ts.
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

  describe("a person's input", () => {
    const mouseEvents = () => chromium.sent.filter((entry) => entry.method === "Input.dispatchMouseEvent");

    it("reaches only the bot's own page", async () => {
      const browser = browserOf();
      await look(browser, "a");
      await look(browser, "b");
      const other = machine.chromiumOfBot("b");
      other.sent.length = 0;
      chromium.sent.length = 0;
      await browser.input("b", { kind: "text", text: "secret" });
      await browser.input("b", { kind: "pointer", x: 5, y: 200, action: "down" });
      await browser.input("b", { kind: "key", key: "Enter" });
      const input = other.sent.filter((entry) => entry.method.startsWith("Input."));
      expect(input.length).toBeGreaterThan(2);
      expect(new Set(input.map((entry) => entry.sessionId))).toEqual(new Set(["session-target-0"]));
      expect(chromium.sent.filter((entry) => entry.method.startsWith("Input."))).toEqual([]);
    });

    it("takes no lease per event, so a pointer move runs no sudo", async () => {
      const browser = browserOf();
      await look(browser, "a");
      const before = machine.acquires();
      for (let move = 0; move < 20; move += 1) {
        await browser.input("a", { kind: "pointer", x: move, y: 200, action: "move" });
      }
      expect(machine.acquires()).toBe(before);
    });

    it("starts the desktop once when there is no connection yet", async () => {
      const browser = browserOf();
      await browser.input("a", { kind: "text", text: "first" });
      await browser.input("a", { kind: "text", text: "second" });
      expect(machine.acquires()).toBe(1);
      expect(machine.openLeases()).toBe(0);
      expect(chromium.sent.filter((entry) => entry.method === "Input.insertText")).toHaveLength(2);
    });

    it("maps a point on the stream to a point in the page, below the panel and the window's bars", async () => {
      const browser = browserOf();
      await look(browser, "a");
      chromium.sent.length = 0;
      await browser.input("a", { kind: "pointer", x: 640, y: 400, action: "down" });
      expect(mouseEvents()[0]?.params).toMatchObject({ type: "mousePressed", x: 640, y: 288, button: "left", buttons: 1 });
    });

    it("ignores a click on the panel or the window's bars, which CDP input cannot reach", async () => {
      const browser = browserOf();
      await look(browser, "a");
      chromium.sent.length = 0;
      await browser.input("a", { kind: "pointer", x: 640, y: 40, action: "down" });
      expect(mouseEvents()).toEqual([]);
    });

    it("maps a point inside a popup from that window's own bounds", async () => {
      const browser = browserOf();
      await look(browser, "a");
      const popup = chromium.openPopup("target-0");
      chromium.bounds.set(popup, { left: 60, top: 60 });
      chromium.sent.length = 0;
      await browser.input("a", { kind: "pointer", x: 300, y: 300, action: "down" });
      expect(mouseEvents()[0]?.params).toMatchObject({ x: 240, y: 155 });
    });

    it("scrolls the page at that point", async () => {
      const browser = browserOf();
      await look(browser, "a");
      chromium.sent.length = 0;
      await browser.input("a", { kind: "scroll", x: 640, y: 400, dx: 0, dy: 120 });
      expect(mouseEvents()[0]?.params).toMatchObject({ type: "mouseWheel", x: 640, y: 288, deltaY: 120 });
    });
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
