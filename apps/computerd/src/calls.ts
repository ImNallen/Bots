import { withoutScreenImage, type Browsing, type ToolInvocation, type ToolResult } from "@bots/protocol";
import type { Journal } from "./journal.ts";

export type ExecuteTool = (args: {
  botId: string;
  tool: ToolInvocation;
  browsing: Browsing | undefined;
  signal: AbortSignal;
}) => Promise<ToolResult>;

export type CallRequest = { callId: string; botId: string; tool: ToolInvocation; browsing?: Browsing | undefined };

type InFlight = { abort: AbortController; result: Promise<ToolResult> };

export const INTERRUPTED_OUTPUT =
  "computerd has no result for this call, because it restarted during the call or the result expired. The outcome is unknown, and the command may have partly run. It was not run again.";
const CANCELLED_BEFORE_START_OUTPUT = "The call was cancelled before it started.";

export type Calls = {
  call: (request: CallRequest) => Promise<ToolResult>;
  cancel: (callId: string) => Promise<ToolResult>;
};

// At-most-once lives here. A call is in this map from its first lookup until its result is durable,
// so a repeat attaches to the running execution, and the journal answers every repeat after that.
export function createCalls(args: { journal: Journal; execute: ExecuteTool }): Calls {
  const { journal, execute } = args;
  const inFlight = new Map<string, InFlight>();

  async function settle(callId: string, result: ToolResult): Promise<ToolResult> {
    await journal.finish({ callId, result: withoutScreenImage(result) });
    return result;
  }

  async function resolve(request: CallRequest, signal: AbortSignal): Promise<ToolResult> {
    const { callId, botId, tool, browsing } = request;
    const entry = await journal.read(callId);
    switch (entry.kind) {
      case "finished":
        return entry.result;
      case "started":
        return await settle(callId, { outcome: "interrupted", output: INTERRUPTED_OUTPUT, truncated: false });
      case "absent":
        await journal.markStarted({ callId, botId, toolName: tool.name });
        // A cancel can land while the journal is written, and an execute handed an aborted signal may never see the abort.
        if (signal.aborted) {
          return await settle(callId, { outcome: "cancelled", output: CANCELLED_BEFORE_START_OUTPUT, truncated: false });
        }
        return await settle(callId, await execute({ botId, tool, browsing, signal }));
    }
  }

  async function resolveCancel(callId: string): Promise<ToolResult> {
    const entry = await journal.read(callId);
    switch (entry.kind) {
      case "finished":
        return entry.result;
      case "started":
        return await settle(callId, { outcome: "interrupted", output: INTERRUPTED_OUTPUT, truncated: false });
      case "absent":
        return await settle(callId, {
          outcome: "cancelled",
          output: CANCELLED_BEFORE_START_OUTPUT,
          truncated: false,
        });
    }
  }

  function track(callId: string, abort: AbortController, result: Promise<ToolResult>): Promise<ToolResult> {
    inFlight.set(callId, { abort, result });
    const untrack = () => inFlight.delete(callId);
    result.then(untrack, untrack);
    return result;
  }

  return {
    call(request) {
      const existing = inFlight.get(request.callId);
      if (existing !== undefined) {
        return existing.result;
      }
      const abort = new AbortController();
      return track(request.callId, abort, resolve(request, abort.signal));
    },
    cancel(callId) {
      const existing = inFlight.get(callId);
      if (existing !== undefined) {
        existing.abort.abort();
        return existing.result;
      }
      return track(callId, new AbortController(), resolveCancel(callId));
    },
  };
}
