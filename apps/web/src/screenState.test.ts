import { describe, expect, it } from "vitest";
import {
  holdsScreen,
  INITIAL_SCREEN_STATE,
  screenReducer,
  streamFor,
  type ScreenEvent,
  type ScreenState,
  type Stream,
} from "./screenState.ts";

const stream: Stream = { sendKey: () => {} };
const connected: ScreenEvent = { type: "connected", stream };
const run = (...events: ScreenEvent[]) => events.reduce(screenReducer, INITIAL_SCREEN_STATE);

const WATCHING: ScreenEvent[] = [connected];
const REQUESTING: ScreenEvent[] = [...WATCHING, { type: "takeControl" }];
const JOINING: ScreenEvent[] = [...REQUESTING, { type: "granted" }];
const CONTROLLING: ScreenEvent[] = [...JOINING, connected];
const LOST: ScreenEvent[] = [...CONTROLLING, { type: "disconnected" }];

describe("screenReducer", () => {
  it("starts by connecting to the watch stream, then watches", () => {
    expect(INITIAL_SCREEN_STATE).toEqual({ kind: "connecting", notice: null });
    expect(streamFor(INITIAL_SCREEN_STATE)).toBe("watch");
    expect(run(...WATCHING)).toEqual({ kind: "watching", notice: null });
  });

  it("offers a new attempt when the watch stream ends, and that attempt opens a stream again", () => {
    for (const before of [[], WATCHING, REQUESTING]) {
      const ended = run(...before, { type: "disconnected" });
      expect(ended).toEqual({ kind: "ended" });
      expect(streamFor(ended)).toBeNull();
      expect(holdsScreen(ended)).toBe(false);
      const retried = screenReducer(ended, { type: "retry" });
      expect(retried).toEqual({ kind: "connecting", notice: null });
      expect(streamFor(retried)).toBe("watch");
    }
  });

  it("keeps showing the watch stream until the take-over is granted, and only then opens the input stream", () => {
    expect(streamFor(run(...REQUESTING))).toBe("watch");
    expect(streamFor(run(...JOINING))).toBe("control");
    expect(run(...CONTROLLING)).toEqual({ kind: "controlling", stream });
  });

  it("goes back to watching with a notice when a take-over is refused", () => {
    const refused = run(...REQUESTING, { type: "refused" });
    expect(refused).toEqual({ kind: "watching", notice: "takeoverRefused" });
    expect(holdsScreen(refused)).toBe(false);
    expect(streamFor(refused)).toBe("watch");
  });

  it("gives back from a live or a connecting input stream with no notice", () => {
    for (const before of [JOINING, CONTROLLING]) {
      const given = run(...before, { type: "giveBack" });
      expect(given).toEqual({ kind: "connecting", notice: null });
      expect(holdsScreen(given)).toBe(false);
      expect(streamFor(given)).toBe("watch");
    }
  });

  it("holds the screen with no stream while it checks who ended the input stream", () => {
    for (const before of [JOINING, CONTROLLING]) {
      const lost = run(...before, { type: "disconnected" });
      expect(lost).toEqual({ kind: "lost" });
      expect(holdsScreen(lost)).toBe(true);
      expect(streamFor(lost)).toBeNull();
    }
  });

  it("tells the owner a take-over ended, through the reconnect, until the next take-over", () => {
    const settled = run(...LOST, { type: "settled" });
    expect(settled).toEqual({ kind: "connecting", notice: "takeoverEnded" });
    expect(holdsScreen(settled)).toBe(false);
    const watching = screenReducer(settled, connected);
    expect(watching).toEqual({ kind: "watching", notice: "takeoverEnded" });
    const again = screenReducer(watching, { type: "takeControl" });
    expect(screenReducer(screenReducer(again, { type: "granted" }), { type: "giveBack" })).toEqual({ kind: "connecting", notice: null });
  });

  it("holds the screen from the request until the give-back, and at no other time", () => {
    const held: [ScreenEvent[], boolean][] = [
      [[], false],
      [WATCHING, false],
      [REQUESTING, true],
      [JOINING, true],
      [CONTROLLING, true],
      [LOST, true],
    ];
    for (const [events, holds] of held) {
      expect(holdsScreen(run(...events))).toBe(holds);
    }
  });

  it("ignores an event that does not belong to the state", () => {
    const events: ScreenEvent[] = [
      connected,
      { type: "disconnected" },
      { type: "takeControl" },
      { type: "granted" },
      { type: "refused" },
      { type: "giveBack" },
      { type: "settled" },
      { type: "retry" },
    ];
    const allowed: Record<ScreenState["kind"], ScreenEvent["type"][]> = {
      connecting: ["connected", "disconnected"],
      watching: ["takeControl", "disconnected"],
      ended: ["retry"],
      requesting: ["granted", "refused", "disconnected"],
      joining: ["connected", "giveBack", "disconnected"],
      controlling: ["giveBack", "disconnected"],
      lost: ["settled"],
    };
    const states = [[], WATCHING, REQUESTING, JOINING, CONTROLLING, LOST, [{ type: "disconnected" } as const]].map((before) =>
      run(...before),
    );
    for (const state of states) {
      for (const event of events) {
        if (!allowed[state.kind].includes(event.type)) {
          expect(screenReducer(state, event)).toBe(state);
        }
      }
    }
  });
});
