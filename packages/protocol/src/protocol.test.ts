import { describe, expect, it } from "vitest";
import {
  OUTPUT_CAP_BYTES,
  callIdToFileStem,
  capText,
  computerMessage,
  createOutputCollector,
  orchestratorMessage,
  parseJsonMessage,
  isBrowserInvocation,
  parseToolCall,
  toolDefinitions,
} from "./index.ts";

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("screenOpen", () => {
  const parse = (fields: object) =>
    parseJsonMessage({ raw: JSON.stringify({ kind: "screenOpen", streamId: "s", botId: "b", ...fields }), schema: orchestratorMessage });

  it("reads a stream with no mode, and one with control", () => {
    expect(parse({})).toEqual({ kind: "screenOpen", streamId: "s", botId: "b" });
    expect(parse({ mode: "control" })).toEqual({ kind: "screenOpen", streamId: "s", botId: "b", mode: "control" });
  });

  it("refuses any other mode, so no second spelling of watch can reach a computerd", () => {
    expect(parse({ mode: "watch" })).toBeNull();
  });
});

describe("output cap", () => {
  it("leaves output under the cap untouched", () => {
    expect(capText("hello")).toEqual({ output: "hello", truncated: false });
    const collector = createOutputCollector();
    collector.add(Buffer.from("hel"));
    collector.add(Buffer.from("lo"));
    expect(collector.finish()).toEqual({ output: "hello", truncated: false });
  });

  it("keeps exactly the cap without truncating", () => {
    const text = "a".repeat(OUTPUT_CAP_BYTES);
    const collector = createOutputCollector();
    collector.add(Buffer.from(text));
    expect(collector.finish()).toEqual({ output: text, truncated: false });
    expect(capText(text).truncated).toBe(false);
  });

  it("keeps the head and the tail with a marker", () => {
    const collector = createOutputCollector();
    collector.add(Buffer.from("HEAD"));
    for (let index = 0; index < 100; index += 1) {
      collector.add(Buffer.alloc(4096, "x"));
    }
    collector.add(Buffer.from("TAIL"));
    const { output, truncated } = collector.finish();
    expect(truncated).toBe(true);
    expect(output.startsWith("HEAD")).toBe(true);
    expect(output.endsWith("TAIL")).toBe(true);
    expect(output).toMatch(/\[\.\.\. \d+ bytes omitted \.\.\.\]/);
    expect(bytes(output)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
  });

  it("stays within the cap for binary input, whose replacement characters are larger than its bytes", () => {
    const collector = createOutputCollector();
    collector.add(Buffer.alloc(OUTPUT_CAP_BYTES * 4, 0xff));
    const { output, truncated } = collector.finish();
    expect(truncated).toBe(true);
    expect(bytes(output)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    expect(capText(output).truncated).toBe(false);
  });

  it("does not grow when capped twice", () => {
    const once = capText("é".repeat(OUTPUT_CAP_BYTES));
    expect(once.truncated).toBe(true);
    expect(bytes(once.output)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    expect(capText(once.output)).toEqual({ output: once.output, truncated: false });
  });

  it("repairs a lone surrogate", () => {
    expect(capText("a\ud800b").output).toBe("a�b");
  });

  it("retains a bounded number of bytes across a long stream", () => {
    const collector = createOutputCollector();
    for (let index = 0; index < 2000; index += 1) {
      collector.add(Buffer.alloc(64 * 1024, "y"));
    }
    expect(bytes(collector.finish().output)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
  });
});

describe("browser tools", () => {
  const parse = (name: string, args: unknown) => parseToolCall({ name, arguments: JSON.stringify(args) });

  it.each(["https://example.com/", "http://example.com/a?b=c"])("accepts the URL %s", (url) => {
    expect(parse("browser_navigate", { url }).kind).toBe("ok");
  });

  it.each(["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "about:blank", "example.com"])(
    "rejects the URL %s",
    (url) => {
      expect(parse("browser_navigate", { url }).kind).toBe("invalid");
    },
  );

  it("takes only the keys that the browser knows", () => {
    expect(parse("browser_press", { key: "ArrowDown" }).kind).toBe("ok");
    expect(parse("browser_press", { key: "F12" }).kind).toBe("invalid");
  });

  it("rejects a ref that is not a positive whole number", () => {
    expect(parse("browser_click", { ref: 0 }).kind).toBe("invalid");
    expect(parse("browser_click", { ref: 1.5 }).kind).toBe("invalid");
  });

  it("defaults submit to false", () => {
    expect(parse("browser_type", { ref: 1, text: "x" })).toEqual({
      kind: "ok",
      invocation: { name: "browser_type", args: { ref: 1, text: "x", submit: false } },
    });
  });

  it("marks only browser tools as browser invocations", () => {
    expect(isBrowserInvocation({ name: "browser_snapshot", args: {} })).toBe(true);
    expect(isBrowserInvocation({ name: "read_file", args: { path: "a" } })).toBe(false);
  });
});

describe("parseToolCall", () => {
  it("applies the shell default timeout", () => {
    expect(parseToolCall({ name: "shell", arguments: '{"command":"ls"}' })).toEqual({
      kind: "ok",
      invocation: { name: "shell", args: { command: "ls", timeoutSeconds: 120 } },
    });
  });

  it.each([
    ["an unknown tool", "browse", "{}", /no tool named "browse"/],
    ["an inherited property name", "constructor", "{}", /no tool named/],
    ["bad JSON", "shell", "{nope", /not valid JSON/],
    ["a missing field", "shell", "{}", /do not match/],
    ["an unknown field", "read_file", '{"path":"a","mode":1}', /do not match/],
    ["a timeout over the maximum", "shell", '{"command":"ls","timeoutSeconds":601}', /do not match/],
    ["a NUL in a path", "read_file", '{"path":"a\\u0000b"}', /do not match/],
  ])("rejects %s", (_label, name, raw, reason) => {
    const parsed = parseToolCall({ name, arguments: raw });
    expect(parsed.kind).toBe("invalid");
    expect(parsed).toMatchObject({ reason: expect.stringMatching(reason) });
  });

  it("publishes a JSON schema for each tool without the $schema key", () => {
    expect(toolDefinitions.map((tool) => tool.function.name)).toEqual([
      "shell",
      "read_file",
      "write_file",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
    ]);
    for (const tool of toolDefinitions) {
      expect(tool.function.parameters).toMatchObject({ type: "object" });
      expect(tool.function.parameters).not.toHaveProperty("$schema");
    }
    const shell = toolDefinitions[0]?.function.parameters;
    expect(shell).toMatchObject({ required: ["command"] });
  });
});

describe("link messages", () => {
  const tool = { name: "read_file", args: { path: "a" } };

  it.each(["../../etc:passwd", "a/b:c", "a:b:c", ":b", "a:", "a", `${"a".repeat(65)}:b`, "a:b\n"])(
    "rejects the callId %j",
    (callId) => {
      const raw = JSON.stringify({ kind: "toolCall", callId, botId: "bot", tool });
      expect(parseJsonMessage({ raw, schema: orchestratorMessage })).toBeNull();
      expect(() => callIdToFileStem(callId)).toThrow();
    },
  );

  it("encodes a callId into a stem with no path characters, short enough for a file name", () => {
    const stem = callIdToFileStem(`${"a".repeat(64)}:${"b".repeat(64)}`);
    expect(stem).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(stem.length).toBeLessThan(200);
    expect(callIdToFileStem("a:b")).not.toBe(callIdToFileStem("a_:b"));
  });

  it("rejects a botId that could escape the workspace", () => {
    const raw = JSON.stringify({ kind: "toolCall", callId: "a:b", botId: "../root", tool });
    expect(parseJsonMessage({ raw, schema: orchestratorMessage })).toBeNull();
  });

  it("rejects an outcome only the orchestrator may record", () => {
    const raw = JSON.stringify({
      kind: "toolResult",
      callId: "a:b",
      result: { outcome: "unavailable", output: "", truncated: false },
    });
    expect(parseJsonMessage({ raw, schema: computerMessage })).toBeNull();
  });

  it("returns null for text that is not JSON", () => {
    expect(parseJsonMessage({ raw: "{", schema: computerMessage })).toBeNull();
  });
});
