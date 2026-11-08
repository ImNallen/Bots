import { readFileSync } from "node:fs";
import type { ToolResult } from "@bots/protocol";
import { describe, expect, it } from "vitest";
import { createDesktop, type Hand } from "./desktop.ts";
import type { DesktopLease, Slot } from "./desktops.ts";

const captured: unknown = JSON.parse(readFileSync(new URL("fixtures/desktop/chromium-over-others.json", import.meta.url), "utf8"));
const look = { name: "desktop_look" as const, args: {} };

function fakeHand(overrides: Partial<Hand> = {}) {
  const calls: string[] = [];
  const hand: Hand = {
    capture: async () => {
      calls.push("capture");
      return captured;
    },
    render: async ({ boxes }) => {
      calls.push(`render ${boxes.length}`);
      return { mediaType: "image/png", base64: "iVBORw0KGgo=" };
    },
    close: () => calls.push("close"),
    ...overrides,
  };
  return { hand, calls };
}

function desktopWith(hand: Hand, deadlineMs?: number) {
  const leases: string[] = [];
  const desktop = createDesktop({
    desktops: {
      acquire: async (botId): Promise<DesktopLease> => {
        leases.push(`acquire ${botId}`);
        return { slot: 3 as Slot, cdpPort: 9303, release: () => leases.push("release") };
      },
    },
    open: () => hand,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  return { desktop, leases };
}

const signal = () => new AbortController().signal;

describe("desktop_look", () => {
  it("answers with the marks from the capture and the numbered picture, and lets the helper and the desktop go", async () => {
    const { hand, calls } = fakeHand();
    const { desktop, leases } = desktopWith(hand);
    const result: ToolResult = await desktop.execute({ botId: "bot", tool: look, signal: signal() });
    expect(result).toMatchObject({ outcome: "ok", output: "Looked at the screen.", truncated: false });
    expect(result.screen?.image).toEqual({ mediaType: "image/png", base64: "iVBORw0KGgo=" });
    expect(result.screen?.marks.some((mark) => mark.name === "Sign in")).toBe(true);
    expect(calls).toEqual(["capture", `render ${result.screen?.marks.length}`, "close"]);
    expect(leases).toEqual(["acquire bot", "release"]);
  });

  it("keeps the marks when the picture did not fit", async () => {
    const { hand } = fakeHand({ render: async () => null });
    const result = await desktopWith(hand).desktop.execute({ botId: "bot", tool: look, signal: signal() });
    expect(result.outcome).toBe("ok");
    expect(result.screen?.image).toBeUndefined();
    expect(result.screen?.marks.length).toBeGreaterThan(0);
  });

  it("answers an error when the helper's capture does not parse", async () => {
    const { hand, calls } = fakeHand({ capture: async () => ({ width: 1, nodes: "no" }) });
    const result = await desktopWith(hand).desktop.execute({ botId: "bot", tool: look, signal: signal() });
    expect(result).toMatchObject({ outcome: "error" });
    expect(result.screen).toBeUndefined();
    expect(calls).toEqual(["close"]);
  });

  it("answers cancelled, and closes the helper, when the run stops during a look", async () => {
    const stop = new AbortController();
    const { hand, calls } = fakeHand({ capture: () => new Promise(() => {}) });
    const pending = desktopWith(hand).desktop.execute({ botId: "bot", tool: look, signal: stop.signal });
    setTimeout(() => stop.abort(), 5);
    expect(await pending).toMatchObject({ outcome: "cancelled" });
    expect(calls).toEqual(["close"]);
  });

  it("answers timeout at its deadline, and closes the helper", async () => {
    const { hand, calls } = fakeHand({ capture: () => new Promise(() => {}) });
    expect(await desktopWith(hand, 20).desktop.execute({ botId: "bot", tool: look, signal: signal() })).toMatchObject({ outcome: "timeout" });
    expect(calls).toEqual(["close"]);
  });

  it("runs one bot's calls one at a time", async () => {
    const order: string[] = [];
    let first = true;
    const { hand } = fakeHand({
      capture: async () => {
        const mine = first;
        first = false;
        order.push(mine ? "first starts" : "second starts");
        await new Promise((done) => setTimeout(done, mine ? 20 : 0));
        order.push(mine ? "first ends" : "second ends");
        return captured;
      },
    });
    const { desktop } = desktopWith(hand);
    await Promise.all([desktop.execute({ botId: "bot", tool: look, signal: signal() }), desktop.execute({ botId: "bot", tool: look, signal: signal() })]);
    expect(order).toEqual(["first starts", "first ends", "second starts", "second ends"]);
  });
});
