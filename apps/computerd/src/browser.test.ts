import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserInvocation } from "@bots/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createBrowser, type CdpConnector } from "./browser.ts";

type Sent = { method: string; params: Record<string, unknown>; sessionId: string | undefined };

function fakeChromium() {
  const pages = new Set<string>();
  const windows = new Map<string, Record<string, unknown>>();
  const sent: Sent[] = [];
  const listeners: Array<(method: string, params: Record<string, unknown>) => void> = [];
  let nextTarget = 1;
  let failing = false;
  let locateResult: { x: number; y: number } | null = { x: 10, y: 20 };

  const emit = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) {
      listener(method, params);
    }
  };
  const openPopup = async (openerId: string) => {
    const targetId = `target-${nextTarget++}`;
    pages.add(targetId);
    emit("Target.targetCreated", { targetInfo: { targetId, type: "page", openerId } });
    await new Promise((done) => setTimeout(done, 20));
    return targetId;
  };

  const connector: CdpConnector = async () => {
    if (failing) {
      throw new Error("this computer has no running browser");
    }
    return {
      onEvent: (listener) => listeners.push(listener),
      send: async (method, params = {}, sessionId) => {
        sent.push({ method, params, sessionId });
        switch (method) {
          case "Target.getTargets":
            return { targetInfos: [...pages].map((targetId) => ({ targetId, type: "page" })) };
          case "Target.createTarget": {
            const targetId = `target-${nextTarget++}`;
            pages.add(targetId);
            return { targetId };
          }
          case "Target.closeTarget":
            pages.delete(String(params.targetId));
            return {};
          case "Target.attachToTarget":
            return { sessionId: `session-${String(params.targetId)}` };
          case "Browser.getWindowForTarget":
            return { windowId: params.targetId };
          case "Browser.setWindowBounds": {
            const bounds = params.bounds as Record<string, unknown>;
            if (bounds.left !== undefined) {
              windows.set(String(params.windowId), bounds);
            }
            return {};
          }
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
    };
  };
  return {
    connector,
    pages,
    windows,
    sent,
    emit,
    openPopup,
    setFailing: (value: boolean) => {
      failing = value;
    },
    setLocate: (value: { x: number; y: number } | null) => {
      locateResult = value;
    },
  };
}

const signal = new AbortController().signal;
const navigate: BrowserInvocation = { name: "browser_navigate", args: { url: "https://example.com/" } };
const snapshot: BrowserInvocation = { name: "browser_snapshot", args: {} };

let stateFile: string;
let chromium: ReturnType<typeof fakeChromium>;

beforeEach(async () => {
  stateFile = join(await mkdtemp(join(tmpdir(), "browser-test-")), "screens.json");
  chromium = fakeChromium();
});

function browserOf() {
  return createBrowser({ stateFile, connector: chromium.connector });
}

describe("browser", () => {
  it("gives two bots that start together different screens", async () => {
    const browser = browserOf();
    const regions = await Promise.all(["a", "b", "c"].map((bot) => browser.regionFor(bot)));
    expect(new Set(regions).size).toBe(3);
  });

  it("places each bot's window in its own region", async () => {
    const browser = browserOf();
    await browser.execute({ botId: "a", tool: navigate, signal });
    await browser.execute({ botId: "b", tool: navigate, signal });
    const lefts = [...chromium.windows.values()].map((bounds) => bounds.left);
    expect(lefts).toEqual([0, 1280]);
    expect(chromium.pages.size).toBe(2);
  });

  it("keeps a bot on its screen and page across calls", async () => {
    const browser = browserOf();
    const first = await browser.regionFor("a");
    await browser.execute({ botId: "a", tool: navigate, signal });
    await browser.execute({ botId: "a", tool: snapshot, signal });
    expect(await browser.regionFor("a")).toBe(first);
    expect(chromium.pages.size).toBe(1);
  });

  it("finds the same screen after computerd restarts", async () => {
    const before = browserOf();
    await before.regionFor("a");
    const region = await before.regionFor("b");
    const after = browserOf();
    expect(await after.regionFor("b")).toBe(region);
    expect(chromium.pages.size).toBe(2);
  });

  it("opens a new window on the same screen when Chromium restarted and lost the page", async () => {
    const browser = browserOf();
    const region = await browser.regionFor("a");
    chromium.pages.clear();
    expect(await browser.regionFor("a")).toBe(region);
    expect(chromium.pages.size).toBe(1);
  });

  it("takes the screen of the bot that acted longest ago when every screen is taken", async () => {
    const browser = browserOf();
    const regions: number[] = [];
    for (let bot = 0; bot < 8; bot += 1) {
      regions.push(await browser.regionFor(`bot-${bot}`));
      await new Promise((done) => setTimeout(done, 2));
    }
    expect(new Set(regions).size).toBe(8);
    await browser.regionFor("bot-0");
    const taken = await browser.regionFor("bot-8");
    expect(taken).toBe(regions[1]);
    expect(chromium.pages.size).toBe(8);
    expect(await browser.regionFor("bot-0")).toBe(regions[0]);
  });

  it("moves a popup to its opener's screen, and acts on it until it closes", async () => {
    const browser = browserOf();
    await browser.regionFor("a");
    const region = await browser.regionFor("b");
    const opener = [...chromium.pages][1] as string;
    const popup = await chromium.openPopup(opener);
    expect(chromium.windows.get(popup)?.left).toBe(region * 1280 + 60);
    chromium.sent.length = 0;
    await browser.execute({ botId: "b", tool: snapshot, signal });
    const evaluated = chromium.sent.filter((entry) => entry.method === "Runtime.evaluate");
    expect(evaluated.at(-1)?.sessionId).toBe(`session-${popup}`);

    chromium.pages.delete(popup);
    chromium.emit("Target.targetDestroyed", { targetId: popup });
    await new Promise((done) => setTimeout(done, 20));
    chromium.sent.length = 0;
    await browser.execute({ botId: "b", tool: snapshot, signal });
    expect(chromium.sent.filter((entry) => entry.method === "Runtime.evaluate").at(-1)?.sessionId).toBe(`session-${opener}`);
  });

  it("does not move a popup from a window that belongs to no bot", async () => {
    const browser = browserOf();
    await browser.regionFor("a");
    await chromium.openPopup("the-blank-window");
    expect(chromium.windows.size).toBe(1);
  });

  it("sends a bot's typing only to that bot's page", async () => {
    const browser = browserOf();
    await browser.regionFor("a");
    await browser.regionFor("b");
    const [pageA, pageB] = [...chromium.pages];
    chromium.sent.length = 0;
    await Promise.all([
      browser.execute({ botId: "a", tool: { name: "browser_type", args: { ref: 1, text: "for a", submit: false } }, signal }),
      browser.execute({ botId: "b", tool: { name: "browser_type", args: { ref: 1, text: "for b", submit: false } }, signal }),
    ]);
    const typed = chromium.sent.filter((entry) => entry.method === "Input.insertText");
    expect(typed.find((entry) => entry.params.text === "for a")?.sessionId).toBe(`session-${pageA}`);
    expect(typed.find((entry) => entry.params.text === "for b")?.sessionId).toBe(`session-${pageB}`);
  });

  it("sends a person's input only to the bot's own page", async () => {
    const browser = browserOf();
    await browser.regionFor("a");
    await browser.regionFor("b");
    const pageB = [...chromium.pages][1];
    chromium.sent.length = 0;
    await browser.input("b", { kind: "text", text: "secret" });
    await browser.input("b", { kind: "pointer", x: 5, y: 6, action: "down" });
    await browser.input("b", { kind: "key", key: "Enter" });
    const input = chromium.sent.filter((entry) => entry.method.startsWith("Input."));
    expect(input.length).toBeGreaterThan(2);
    expect(new Set(input.map((entry) => entry.sessionId))).toEqual(new Set([`session-${pageB}`]));
  });

  it("reports a stale ref as an error that tells the bot what to do", async () => {
    const browser = browserOf();
    chromium.setLocate(null);
    const result = await browser.execute({ botId: "a", tool: { name: "browser_click", args: { ref: 9 } }, signal });
    expect(result.outcome).toBe("error");
    expect(result.output).toContain("take a new snapshot");
  });

  it("reports a computer with no browser as an error", async () => {
    chromium.setFailing(true);
    const result = await browserOf().execute({ botId: "a", tool: navigate, signal });
    expect(result).toMatchObject({ outcome: "error", truncated: false });
    expect(result.output).toContain("no running browser");
  });

  it("connects again after the browser restarts", async () => {
    const browser = browserOf();
    await browser.regionFor("a");
    chromium.emit("cdp.disconnected", {});
    await new Promise((done) => setTimeout(done, 20));
    const result = await browser.execute({ botId: "a", tool: snapshot, signal });
    expect(result.outcome).toBe("ok");
  });

  it("returns a snapshot that names the screen", async () => {
    const result = await browserOf().execute({ botId: "a", tool: navigate, signal });
    expect(result.outcome).toBe("ok");
    expect(result.output).toMatch(/^Screen 1\n/);
  });
});
