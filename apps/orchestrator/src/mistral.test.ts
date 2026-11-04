import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { completeWithRetry, createSseParser, createTurnAccumulator, parseRetryAfterMs } from "./mistral.ts";

function parseAll(chunks: string[]): string[] {
  const payloads: string[] = [];
  const parser = createSseParser((payload) => payloads.push(payload.kind === "done" ? "[DONE]" : payload.data));
  chunks.forEach(parser.feed);
  parser.end();
  return payloads;
}

function accumulate(chunks: unknown[]) {
  const accumulator = createTurnAccumulator({ fallbackModel: "fallback" });
  chunks.forEach(accumulator.add);
  return accumulator;
}

function delta(fields: Record<string, unknown>, finishReason: string | null = null) {
  return { choices: [{ index: 0, delta: fields, finish_reason: finishReason }] };
}

describe("createSseParser", () => {
  it("reassembles events split across reads, at any byte", () => {
    const stream = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    expect(parseAll([stream])).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
    for (let split = 1; split < stream.length; split += 1) {
      expect(parseAll([stream.slice(0, split), stream.slice(split)])).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
    }
  });

  it("handles CRLF, comments, other fields, and no space after the colon", () => {
    expect(parseAll([": ping\r\nevent: x\r\ndata:{\"a\":1}\r\n\r\n"])).toEqual(['{"a":1}']);
  });

  it("delivers a final event with no blank line", () => {
    expect(parseAll(['data: {"a":1}'])).toEqual(['{"a":1}']);
  });

  it("joins multi-line data", () => {
    expect(parseAll(["data: a\ndata: b\n\n"])).toEqual(["a\nb"]);
  });
});

describe("createTurnAccumulator", () => {
  it("accumulates string content, model, usage, and finish", () => {
    const accumulator = accumulate([
      { model: "real-model", ...delta({ role: "assistant", content: "Hel" }) },
      delta({ content: "lo" }),
      { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, ...delta({ content: "" }, "stop") },
    ]);
    expect(accumulator.isFinished()).toBe(true);
    expect(accumulator.finish()).toEqual({
      text: "Hello",
      toolCalls: [],
      usage: { promptTokens: 3, completionTokens: 2 },
      model: "real-model",
    });
  });

  it("follows the documented reasoning shape, from thinking chunks to a plain string", () => {
    const accumulator = accumulate([
      delta({ content: [{ type: "thinking", thinking: [{ type: "text", text: "Let me " }] }] }),
      delta({
        content: [
          { type: "thinking", thinking: [{ type: "text", text: "think." }], closed: true },
          { type: "text", text: "An" },
        ],
      }),
      delta({ content: "swer" }, "stop"),
    ]);
    expect(accumulator.finish()).toMatchObject({ text: "Answer", reasoning: "Let me think." });
    expect(accumulator.snapshot()).toEqual({ text: "Answer", reasoning: "Let me think." });
  });

  it("ignores unknown chunk types and reports them", () => {
    const accumulator = accumulate([
      delta({ content: [{ type: "reference", reference_ids: [1] }, "bare", { type: "text", text: "ok" }] }, "stop"),
    ]);
    expect(accumulator.finish().text).toBe("ok");
    expect(accumulator.ignoredChunkTypes().sort()).toEqual(["reference", "untyped"]);
  });

  it("tolerates unknown fields", () => {
    expect(accumulate([{ surprise: 1, ...delta({ content: "x", extra: true }) }]).finish().text).toBe("x");
  });

  it("takes whole tool calls that arrive in one chunk, even with one index", () => {
    const accumulator = accumulate([
      delta({
        tool_calls: [
          { id: "aaa", index: 0, function: { name: "shell", arguments: '{"command":"a"}' } },
          { id: "bbb", index: 0, function: { name: "read_file", arguments: { path: "b" } } },
        ],
      }),
    ]);
    expect(accumulator.finish().toolCalls).toEqual([
      { id: "aaa", name: "shell", arguments: '{"command":"a"}' },
      { id: "bbb", name: "read_file", arguments: '{"path":"b"}' },
    ]);
  });

  it("joins a tool call that arrives in pieces, by index and with the placeholder id", () => {
    const accumulator = accumulate([
      delta({ tool_calls: [{ id: "aaa", index: 0, function: { name: "shell", arguments: "" } }] }),
      delta({ tool_calls: [{ id: "null", index: 0, function: { arguments: '{"com' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'mand":"a"}' } }] }),
      delta({ tool_calls: [{ id: "bbb", index: 1, function: { name: "read_file", arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ id: "aaa", index: 0, function: { arguments: "" } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: 'th":"b"}' } }] }, "tool_calls"),
    ]);
    expect(accumulator.finish().toolCalls).toEqual([
      { id: "aaa", name: "shell", arguments: '{"command":"a"}' },
      { id: "bbb", name: "read_file", arguments: '{"path":"b"}' },
    ]);
  });

  it("appends to the latest call when a piece has no id and no index", () => {
    const accumulator = accumulate([
      delta({ tool_calls: [{ id: "aaa", function: { name: "shell", arguments: "{" } }] }),
      delta({ tool_calls: [{ function: { arguments: "}" } }] }),
    ]);
    expect(accumulator.finish().toolCalls).toEqual([{ id: "aaa", name: "shell", arguments: "{}" }]);
  });

  it("keeps a turn under the row limit, and oversized arguments stop parsing", () => {
    const huge = "x".repeat(1024 * 1024);
    const accumulator = accumulate([
      delta({ content: huge }),
      delta({ content: "kept" }),
      delta({ tool_calls: [{ id: "aaa", function: { name: "write_file", arguments: '{"path":"a","content":"' } }] }),
      delta({ tool_calls: [{ id: "aaa", function: { arguments: huge } }] }),
      delta({ tool_calls: [{ id: "aaa", function: { arguments: '"}' } }] }),
    ]);
    const turn = accumulator.finish();
    expect(turn.text).toBe("kept");
    expect(JSON.stringify(turn).length).toBeLessThan(1024 * 1024);
    expect(turn.toolCalls[0]?.arguments.length).toBeLessThan(1024);
  });
});

describe("completeWithRetry", () => {
  const API_KEY = "sk-secret-abcdefghijklmnopqrstuvwxyz012345";

  async function failureFor(body: string): Promise<string> {
    const server = createServer((_, response) => {
      response.writeHead(400).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const result = await completeWithRetry({
        baseUrl: `http://127.0.0.1:${port}`,
        model: "m",
        apiKey: API_KEY,
        messages: [],
        tools: [],
        signal: new AbortController().signal,
        onAttempt: () => {},
        onProgress: () => {},
        log: () => {},
      });
      return result.kind === "failed" ? result.reason : "";
    } finally {
      server.close();
    }
  }

  it.each([10, 260, 290, 296, 299])("keeps no part of a key echoed at offset %i out of the failure reason", async (offset) => {
    const reason = await failureFor(`${"x".repeat(offset)}${API_KEY}${"x".repeat(100)}`);
    expect(reason).toMatch(/status 400/);
    expect(reason).not.toContain(API_KEY.slice(0, 4));
  });
});

describe("parseRetryAfterMs", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfterMs({ value: "2", now: 0 })).toBe(2000);
    expect(parseRetryAfterMs({ value: "Thu, 01 Jan 1970 00:00:10 GMT", now: 4000 })).toBe(6000);
    expect(parseRetryAfterMs({ value: null, now: 0 })).toBeNull();
    expect(parseRetryAfterMs({ value: "soon", now: 0 })).toBeNull();
  });
});
