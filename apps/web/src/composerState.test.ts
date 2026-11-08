import type { Id } from "@bots/convex/dataModel";
import { describe, expect, it } from "vitest";
import { composerView, heldRunEnded, type ActiveRun } from "./composerState.ts";

const runId = (value: string) => value as Id<"runs">;
const routine: ActiveRun = { _id: runId("r1"), routine: true, cancelRequested: false };
const chat: ActiveRun = { _id: runId("c1"), routine: false, cancelRequested: false };
const view = (activeRun: ActiveRun, held: { runId: Id<"runs"> } | null = null) => composerView({ activeRun, held, botName: "Ada" });

describe("composerView", () => {
  it("is an open box with Send when no run is active", () => {
    expect(view(null)).toEqual({ fieldDisabled: false, placeholder: "Message Ada…", note: null, stop: "none", sendOffered: true });
  });

  it("keeps a follow-up draft editable during a chat run, with Stop and no Send", () => {
    expect(view(chat)).toEqual({ fieldDisabled: false, placeholder: "Message Ada…", note: null, stop: "offered", sendOffered: false });
  });

  it("stays open during a routine, says that sending stops it, and has Stop and Send", () => {
    expect(view(routine)).toEqual({ fieldDisabled: false, placeholder: "Message Ada…", note: "Ada is running a routine. Sending a message stops it.", stop: "offered", sendOffered: true });
  });

  it("shows Stopping once a stop was asked for, and a routine still takes a message", () => {
    expect(view({ _id: runId("c1"), routine: false, cancelRequested: true })).toMatchObject({ stop: "stopping", sendOffered: false });
    expect(view({ _id: runId("r1"), routine: true, cancelRequested: true })).toMatchObject({ stop: "stopping", sendOffered: true, fieldDisabled: false });
  });

  it("shows that a held message goes next, and offers no second Send", () => {
    expect(view(routine, { runId: runId("r1") })).toEqual({
      fieldDisabled: false,
      placeholder: "Message Ada…",
      note: "Stopping the routine. Your message goes next.",
      stop: "stopping",
      sendOffered: false,
    });
  });
});

describe("heldRunEnded", () => {
  const held = { runId: runId("r1") };

  it("waits while the held run is the active run", () => {
    expect(heldRunEnded(held, runId("r1"))).toBe(false);
  });

  it("sends when no run is active", () => {
    expect(heldRunEnded(held, null)).toBe(true);
  });

  it("tries when another run won the race, so that send's refusal reaches the person", () => {
    expect(heldRunEnded(held, runId("r2"))).toBe(true);
  });

  it("does nothing with nothing held", () => {
    expect(heldRunEnded(null, null)).toBe(false);
    expect(heldRunEnded(null, runId("r1"))).toBe(false);
  });
});
