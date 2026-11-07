import type { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import type { FunctionReturnType } from "convex/server";

export type ActiveRun = FunctionReturnType<typeof api.threads.activeRun>;

export type HeldSend = { runId: Id<"runs"> } | null;

export type ComposerView = {
  fieldDisabled: boolean;
  placeholder: string;
  note: string | null;
  stop: "none" | "offered" | "stopping";
  sendOffered: boolean;
};

export function composerView(args: { activeRun: ActiveRun; held: HeldSend; botName: string }): ComposerView {
  const { activeRun, held, botName } = args;
  const messageHint = `Message ${botName}`;
  if (held !== null) {
    return { fieldDisabled: false, placeholder: messageHint, note: "Stopping the routine. Your message goes next.", stop: "stopping", sendOffered: false };
  }
  if (activeRun === null) {
    return { fieldDisabled: false, placeholder: messageHint, note: null, stop: "none", sendOffered: true };
  }
  const stop = activeRun.cancelRequested ? "stopping" : "offered";
  return activeRun.routine
    ? { fieldDisabled: false, placeholder: messageHint, note: `${botName} is running a routine. Sending a message stops it.`, stop, sendOffered: true }
    : { fieldDisabled: true, placeholder: `${botName} is working`, note: null, stop, sendOffered: false };
}

export function heldRunEnded(held: HeldSend, activeRunId: Id<"runs"> | null): boolean {
  return held !== null && activeRunId !== held.runId;
}
