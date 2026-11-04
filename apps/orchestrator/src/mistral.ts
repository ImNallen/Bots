import { z } from "zod";
import type { LogFields } from "./log.ts";

export type MistralContentChunk =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: { type: "text"; text: string }[] };

type MistralToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type MistralMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | MistralContentChunk[]; tool_calls?: MistralToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export type CompletedTurn = {
  text: string;
  reasoning?: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: { promptTokens: number; completionTokens: number };
  model: string;
};

export type StreamSnapshot = { text: string; reasoning?: string };

// A runEvents row is limited to 1 MiB, so one turn must stay under that whatever the model sends.
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_REASONING_BYTES = 128 * 1024;
const MAX_TOOL_CALL_BYTES = 256 * 1024;

const toolCallDelta = z.looseObject({
  id: z.string().nullish(),
  index: z.number().nullish(),
  function: z
    .looseObject({
      name: z.string().nullish(),
      arguments: z.union([z.string(), z.record(z.string(), z.unknown())]).nullish(),
    })
    .nullish(),
});

const streamChunk = z.looseObject({
  model: z.string().nullish(),
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.union([z.string(), z.array(z.unknown())]).nullish(),
            tool_calls: z.array(toolCallDelta).nullish(),
          })
          .nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
  usage: z
    .looseObject({ prompt_tokens: z.number().nullish(), completion_tokens: z.number().nullish() })
    .nullish(),
});

const textPart = z.looseObject({ type: z.literal("text"), text: z.string() });
const thinkingPart = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.union([z.string(), z.array(z.unknown())]),
});
const typedPart = z.looseObject({ type: z.string() });

type SsePayload = { kind: "data"; data: string } | { kind: "done" };

export function createSseParser(onPayload: (payload: SsePayload) => void) {
  let buffer = "";
  let dataLines: string[] = [];

  function dispatch(): void {
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join("\n");
    dataLines = [];
    onPayload(data === "[DONE]" ? { kind: "done" } : { kind: "data", data });
  }

  function handleLine(line: string): void {
    if (line === "") {
      dispatch();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }

  return {
    feed(text: string): void {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line.replace(/\r$/, ""));
      }
    },
    end(): void {
      handleLine(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    },
  };
}

function appendWithin(args: { current: string; delta: string; maxBytes: number }): string {
  const next = args.current + args.delta;
  return Buffer.byteLength(next, "utf8") > args.maxBytes ? args.current : next;
}

// Mistral repeats no id on a continuation chunk, and its SDKs default a missing id to the string "null".
function usableId(id: string | null | undefined): string | null {
  return id === undefined || id === null || id === "" || id === "null" ? null : id;
}

type PartialCall = { id: string | null; index: number | null; name: string; arguments: string };

export function createTurnAccumulator(args: { fallbackModel: string }) {
  let text = "";
  let reasoning = "";
  let model = args.fallbackModel;
  let finished = false;
  let usage = { promptTokens: 0, completionTokens: 0 };
  let toolCallBytes = 0;
  const calls: PartialCall[] = [];
  const ignoredChunkTypes = new Set<string>();

  function addContentPart(part: unknown): void {
    const asText = textPart.safeParse(part);
    if (asText.success) {
      text = appendWithin({ current: text, delta: asText.data.text, maxBytes: MAX_TEXT_BYTES });
      return;
    }
    const asThinking = thinkingPart.safeParse(part);
    if (asThinking.success) {
      const { thinking } = asThinking.data;
      for (const inner of typeof thinking === "string" ? [{ type: "text", text: thinking }] : thinking) {
        const innerText = textPart.safeParse(inner);
        if (innerText.success) {
          reasoning = appendWithin({
            current: reasoning,
            delta: innerText.data.text,
            maxBytes: MAX_REASONING_BYTES,
          });
        }
      }
      return;
    }
    const typed = typedPart.safeParse(part);
    ignoredChunkTypes.add(typed.success ? typed.data.type : "untyped");
  }

  function targetCall(delta: z.infer<typeof toolCallDelta>): PartialCall {
    const id = usableId(delta.id);
    const index = delta.index ?? null;
    // Mistral may send several whole calls with the same index, so an unseen id always starts a new call.
    const existing =
      id !== null
        ? calls.find((call) => call.id === id)
        : index !== null
          ? calls.findLast((call) => call.index === index)
          : calls.at(-1);
    if (existing !== undefined) {
      return existing;
    }
    const created: PartialCall = { id, index, name: "", arguments: "" };
    calls.push(created);
    return created;
  }

  function addToolCallDelta(delta: z.infer<typeof toolCallDelta>): void {
    const call = targetCall(delta);
    const rawArguments = delta.function?.arguments;
    const name = delta.function?.name ?? "";
    const added =
      rawArguments === null || rawArguments === undefined
        ? ""
        : typeof rawArguments === "string"
          ? rawArguments
          : JSON.stringify(rawArguments);
    // Dropping bytes past the limit leaves arguments that fail to parse, and the model then hears "invalid".
    const size = Buffer.byteLength(name + added, "utf8");
    if (toolCallBytes + size > MAX_TOOL_CALL_BYTES) {
      return;
    }
    toolCallBytes += size;
    call.name += name;
    call.arguments += added;
  }

  return {
    add(raw: unknown): void {
      const chunk = streamChunk.parse(raw);
      model = chunk.model ?? model;
      if (chunk.usage !== undefined && chunk.usage !== null) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? usage.promptTokens,
          completionTokens: chunk.usage.completion_tokens ?? usage.completionTokens,
        };
      }
      for (const choice of chunk.choices ?? []) {
        finished ||= choice.finish_reason !== undefined && choice.finish_reason !== null;
        const content = choice.delta?.content;
        if (typeof content === "string") {
          addContentPart({ type: "text", text: content });
        } else if (Array.isArray(content)) {
          content.forEach(addContentPart);
        }
        (choice.delta?.tool_calls ?? []).forEach(addToolCallDelta);
      }
    },
    snapshot(): StreamSnapshot {
      return reasoning === "" ? { text } : { text, reasoning };
    },
    isFinished: () => finished,
    ignoredChunkTypes: () => [...ignoredChunkTypes],
    finish(): CompletedTurn {
      return {
        ...(reasoning === "" ? { text } : { text, reasoning }),
        toolCalls: calls.map((call) => ({
          id: call.id ?? "",
          name: call.name,
          arguments: call.arguments,
        })),
        usage,
        model,
      };
    },
  };
}

export function parseRetryAfterMs(args: { value: string | null; now: number }): number | null {
  if (args.value === null) {
    return null;
  }
  const seconds = Number(args.value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(args.value);
  return Number.isNaN(date) ? null : Math.max(date - args.now, 0);
}

const MAX_ATTEMPTS = 5;
const FIRST_BACKOFF_MS = 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const STREAM_IDLE_MS = 120_000;
const KEY_CHECK_TIMEOUT_MS = 10_000;

export const REJECTED_KEY_REASON =
  "Mistral rejected the API key. Replace it in the Mistral key section on the home page.";

type Attempt =
  | { kind: "ok"; turn: CompletedTurn }
  | { kind: "retry"; detail: string; retryAfterMs: number | null }
  | { kind: "failed"; reason: string };

export type CompletionResult = { kind: "ok"; turn: CompletedTurn } | { kind: "failed"; reason: string };

type CompletionArgs = {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: MistralMessage[];
  tools: readonly unknown[];
  signal: AbortSignal;
  onAttempt: () => void;
  onProgress: (snapshot: StreamSnapshot) => void;
  log: (fields: LogFields) => void;
};

async function readStream(args: { response: Response; completion: CompletionArgs }): Promise<Attempt> {
  const { response, completion } = args;
  const accumulator = createTurnAccumulator({ fallbackModel: completion.model });
  let sawDone = false;
  const parser = createSseParser((payload) => {
    if (payload.kind === "done") {
      sawDone = true;
      return;
    }
    accumulator.add(JSON.parse(payload.data));
    completion.onProgress(accumulator.snapshot());
  });
  if (response.body === null) {
    return { kind: "retry", detail: "an empty response", retryAfterMs: null };
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    parser.feed(value);
  }
  parser.end();
  if (!sawDone && !accumulator.isFinished()) {
    return { kind: "retry", detail: "a stream that ended early", retryAfterMs: null };
  }
  const ignored = accumulator.ignoredChunkTypes();
  if (ignored.length > 0) {
    completion.log({ level: "info", event: "mistral-ignored-chunks", types: ignored });
  }
  return { kind: "ok", turn: accumulator.finish() };
}

// Redact before the cut, because a key that crosses the cut no longer matches.
async function errorDetail(args: { response: Response; apiKey: string }): Promise<string> {
  const body = await args.response.text().catch(() => "");
  return body.replaceAll(args.apiKey, "[key]").slice(0, 300).replace(/\s+/g, " ").trim();
}

async function attemptCompletion(completion: CompletionArgs): Promise<Attempt> {
  const idle = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_MS);
  };
  touch();
  const signal = AbortSignal.any([completion.signal, idle.signal]);
  try {
    const response = await fetch(`${completion.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${completion.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: completion.model,
        messages: completion.messages,
        tools: completion.tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        stream: true,
      }),
      signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { kind: "failed", reason: REJECTED_KEY_REASON };
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        kind: "retry",
        detail: `status ${response.status}`,
        retryAfterMs: parseRetryAfterMs({ value: response.headers.get("retry-after"), now: Date.now() }),
      };
    }
    if (!response.ok) {
      const detail = await errorDetail({ response, apiKey: completion.apiKey });
      return { kind: "failed", reason: `Mistral refused the request with status ${response.status}: ${detail}` };
    }
    const tracked = response.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          touch();
          controller.enqueue(chunk);
        },
      }),
    );
    return await readStream({ response: new Response(tracked), completion });
  } catch (error) {
    if (completion.signal.aborted) {
      throw error;
    }
    const detail = idle.signal.aborted ? "a stream that stalled" : "a network or stream error";
    return { kind: "retry", detail, retryAfterMs: null };
  } finally {
    clearTimeout(idleTimer);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Throws only when the signal aborts. Every other way a call can go wrong is a result.
export async function completeWithRetry(completion: CompletionArgs): Promise<CompletionResult> {
  let lastDetail = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    completion.onAttempt();
    const result = await attemptCompletion(completion);
    if (result.kind !== "retry") {
      return result;
    }
    lastDetail = result.detail;
    if (attempt === MAX_ATTEMPTS) {
      break;
    }
    const backoffMs = FIRST_BACKOFF_MS * 2 ** (attempt - 1);
    const delayMs = Math.min(Math.max(backoffMs, result.retryAfterMs ?? 0), MAX_DELAY_MS);
    completion.log({ level: "warn", event: "mistral-retry", attempt, detail: result.detail, delayMs });
    await abortableDelay(delayMs, completion.signal);
  }
  return { kind: "failed", reason: `Mistral failed after ${MAX_ATTEMPTS} attempts. The last attempt got ${lastDetail}.` };
}

export type KeyCheck = "accepted" | "rejected" | "unreachable";

export async function checkMistralKey(args: { baseUrl: string; apiKey: string }): Promise<KeyCheck> {
  try {
    const response = await fetch(`${args.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${args.apiKey}` },
      signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.ok) {
      return "accepted";
    }
    return response.status === 401 || response.status === 403 ? "rejected" : "unreachable";
  } catch {
    return "unreachable";
  }
}
