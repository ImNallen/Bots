import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { MAX_SCREEN_IMAGE_BYTES, fitToLink, screenImage, type Box, type DesktopInvocation, type ToolResult } from "@bots/protocol";
import type { Desktops, Slot } from "./desktops.ts";
import { log } from "./log.ts";
import { INTERACTIVE_ROLES, capture, selectMarks, type Capture } from "./marks.ts";

export const HAND_PATH = "/opt/bots-computerd/current/apps/computerd/desktop/hand.py";

// The sudoers file names exactly this command, and desktop-files.test.ts pins the two together.
export function handArgv(slot: Slot): string[] {
  return ["-n", "-u", "browser", "--", "/usr/bin/python3", "-I", HAND_PATH, String(slot)];
}

const DEADLINE_MS = 30_000;
const CAPTURE = { roles: INTERACTIVE_ROLES, maxNodes: 4000, appDeadlineMs: 1500, walkDeadlineMs: 8000 } as const;

// The helper's side of the line protocol. One JSON object per line each way, answered in order.
export type Hand = {
  // Walks the accessibility tree, then grabs the screen, and keeps that frame for render.
  capture: () => Promise<unknown>;
  // Draws each box and its number on the last frame, and encodes it within maxBytes, or answers null.
  render: (request: { boxes: readonly { mark: number; box: Box }[]; maxBytes: number }) => Promise<unknown>;
  close: () => void;
};

export function openHand(slot: Slot): Hand {
  const child = spawn("sudo", handArgv(slot), { stdio: ["pipe", "pipe", "ignore"] });
  const waiting: { resolve: (reply: unknown) => void; reject: (error: Error) => void }[] = [];
  let ended: Error | null = null;
  const end = (error: Error) => {
    ended ??= error;
    for (const waiter of waiting.splice(0)) {
      waiter.reject(ended);
    }
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      reply = { ok: false, error: "the helper printed a line that is not JSON" };
    }
    waiting.shift()?.resolve(reply);
  });
  child.on("error", (error) => end(error));
  child.on("exit", (code, signal) => end(new Error(`the desktop helper exited (${signal ?? code})`)));
  child.stdin.on("error", () => {});
  const ask = (request: object): Promise<unknown> => {
    if (ended !== null) {
      return Promise.reject(ended);
    }
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    waiting.push({ resolve, reject });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return promise.then((reply) => {
      const answer = reply as { ok?: unknown; error?: unknown };
      if (answer.ok !== true) {
        throw new Error(`the desktop helper failed: ${String(answer.error).slice(0, 300)}`);
      }
      return reply;
    });
  };
  return {
    capture: () => ask({ verb: "capture", ...CAPTURE }).then((reply) => (reply as { capture: unknown }).capture),
    render: (request) => ask({ verb: "render", ...request }).then((reply) => (reply as { image: unknown }).image),
    // The helper exits at the end of its input. A kill reaches it through sudo, which passes the signal on.
    close: () => {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

export type Desktop = {
  execute: (args: { botId: string; tool: DesktopInvocation; signal: AbortSignal }) => Promise<ToolResult>;
};

export function createDesktop(args: {
  desktops: Pick<Desktops, "acquire">;
  open?: (slot: Slot) => Hand;
  takeoverSettled?: (botId: string, signal: AbortSignal) => Promise<void>;
  deadlineMs?: number;
}): Desktop {
  const { desktops, open = openHand, takeoverSettled, deadlineMs = DEADLINE_MS } = args;
  const queues = new Map<string, Promise<unknown>>();

  async function look(hand: Hand, output: string): Promise<ToolResult> {
    const parsed = capture.safeParse(await hand.capture());
    if (!parsed.success) {
      throw new Error("the desktop helper's capture does not parse");
    }
    const captured: Capture = parsed.data;
    const { view } = selectMarks(captured);
    const image = screenImage.safeParse(await hand.render({ boxes: view.marks.map(({ mark, box }) => ({ mark, box })), maxBytes: MAX_SCREEN_IMAGE_BYTES }));
    return { outcome: "ok", output, truncated: false, screen: image.success ? { ...view, image: image.data } : view };
  }

  async function run(botId: string, tool: DesktopInvocation, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    await takeoverSettled?.(botId, signal);
    signal.throwIfAborted();
    const lease = await desktops.acquire(botId);
    const hand = open(lease.slot);
    const ends = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
    const stopped = new Promise<never>((_, reject) => {
      const stop = () => reject(ends.reason instanceof Error ? ends.reason : new Error("stopped"));
      if (ends.aborted) {
        stop();
      }
      ends.addEventListener("abort", stop, { once: true });
    });
    try {
      switch (tool.name) {
        case "desktop_look":
          return await Promise.race([look(hand, "Looked at the screen."), stopped]);
      }
    } catch (error) {
      if (signal.aborted) {
        return { outcome: "cancelled", output: "The look at the screen was cancelled.", truncated: false };
      }
      if (ends.aborted) {
        return { outcome: "timeout", output: `The look at the screen did not finish in ${deadlineMs / 1000} seconds, so it stopped.`, truncated: false };
      }
      throw error;
    } finally {
      hand.close();
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
          return fitToLink(await run(botId, tool, signal));
        } catch (error) {
          if (signal.aborted) {
            return { outcome: "cancelled", output: "The desktop action was cancelled.", truncated: false };
          }
          const message = error instanceof Error ? error.message : "unknown error";
          log({ level: "warn", event: "desktop-call-failed", botId, tool: tool.name, message });
          return { outcome: "error", output: `The desktop action failed: ${message}`, truncated: false };
        }
      }),
  };
}
