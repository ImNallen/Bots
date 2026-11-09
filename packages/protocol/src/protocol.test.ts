import { describe, expect, it, expectTypeOf } from "vitest";
import {
  COMPUTER_TOOL_NAMES,
  isDesktopInputRequest,
  parseKeyCombo,
  MAX_COMPUTER_MESSAGE_BYTES,
  MAX_MARKS,
  OUTPUT_CAP_BYTES,
  TOOLS_BEFORE_ANNOUNCEMENT,
  fitToLink,
  isDesktopInvocation,
  toolResult,
  withoutScreenImage,
  type ScreenView,
  callIdToFileStem,
  capText,
  computerMessage,
  createOutputCollector,
  orchestratorMessage,
  parseJsonMessage,
  isBrowserInvocation,
  isWebInvocation,
  isMemoryInvocation,
  parseToolCall,
  returnsUntrustedText,
  toolDefinitions,
  toolEffect,
  toolInvocation,
  type ToolEffect,
  type ToolInvocation,
  type ToolName,
} from "./index.ts";

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

describe("how a call browses", () => {
  const parse = (message: object) => parseJsonMessage({ raw: JSON.stringify(message), schema: orchestratorMessage });
  const call = { kind: "toolCall", callId: "run:call", botId: "bot", tool: { name: "browser_snapshot", args: {} } };

  it("accepts a toolCall with no browsing, which is every chat run's call", () => {
    expect(parse(call)).toEqual(call);
  });

  it("accepts a logged-out call and browsingEnd", () => {
    const browsing = { kind: "loggedOut", key: "run" };
    expect(parse({ ...call, browsing })).toEqual({ ...call, browsing });
    expect(parse({ kind: "browsingEnd", botId: "bot", key: "run" })).toEqual({ kind: "browsingEnd", botId: "bot", key: "run" });
  });

  it.each([
    ["an unknown kind", { kind: "loggedIn", key: "run" }],
    ["an extra field", { kind: "loggedOut", key: "run", context: "x" }],
    ["no key", { kind: "loggedOut" }],
    ["a key that is not a safe id", { kind: "loggedOut", key: "../run" }],
  ])("refuses %s, so a call cannot browse some other way than the two it names", (_name, browsing) => {
    expect(parse({ ...call, browsing })).toBeNull();
  });

  it("refuses a browsingEnd with an unsafe bot or key", () => {
    expect(parse({ kind: "browsingEnd", botId: "../bot", key: "run" })).toBeNull();
    expect(parse({ kind: "browsingEnd", botId: "bot", key: "" })).toBeNull();
  });
});

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

describe("web_fetch", () => {
  const parse = (args: unknown) => parseToolCall({ name: "web_fetch", arguments: JSON.stringify(args) });

  it("takes an http or https URL, and a start that defaults to 0", () => {
    expect(parse({ url: "https://example.com/a?b=c" })).toEqual({ kind: "ok", invocation: { name: "web_fetch", args: { url: "https://example.com/a?b=c", start: 0 } } });
    expect(parse({ url: "http://example.com/", start: 16384 })).toEqual({ kind: "ok", invocation: { name: "web_fetch", args: { url: "http://example.com/", start: 16384 } } });
  });

  it.each([
    ["a file URL", { url: "file:///etc/passwd" }],
    ["a script", { url: "javascript:alert(1)" }],
    ["a bare host", { url: "example.com" }],
    ["a user name", { url: "https://user@example.com/" }],
    ["a password", { url: "https://user:secret@example.com/" }],
    ["a negative start", { url: "https://example.com/", start: -1 }],
    ["a fractional start", { url: "https://example.com/", start: 1.5 }],
  ])("refuses %s", (_label, args) => {
    expect(parse(args).kind).toBe("invalid");
  });

  it("is a web invocation, not a browser one, so it never gets a browsing context", () => {
    const tool: ToolInvocation = { name: "web_fetch", args: { url: "https://example.com/", start: 0 } };
    expect(isWebInvocation(tool)).toBe(true);
    expect(isBrowserInvocation(tool)).toBe(false);
    expect(isWebInvocation({ name: "browser_snapshot", args: {} })).toBe(false);
  });
});

describe("web_search", () => {
  const parse = (args: unknown) => parseToolCall({ name: "web_search", arguments: JSON.stringify(args) });

  it("takes a query", () => {
    expect(parse({ query: "solar eclipse 2027" })).toEqual({ kind: "ok", invocation: { name: "web_search", args: { query: "solar eclipse 2027" } } });
    expect(isWebInvocation({ name: "web_search", args: { query: "a" } })).toBe(true);
  });

  it.each([
    ["no query", {}],
    ["an empty query", { query: "" }],
    ["a blank query", { query: "   " }],
    ["a query of more than 1,000 characters", { query: "a".repeat(1001) }],
    ["a second field", { query: "a", page: 2 }],
  ])("refuses %s", (_label, args) => {
    expect(parse(args).kind).toBe("invalid");
  });
});

describe("a routine's cadence", () => {
  const propose = (cadence: unknown) => parseToolCall({ name: "schedule_propose", arguments: JSON.stringify({ instruction: "Read the news.", cadence }) });

  it("sends the model no schema with a choice in it, because every chat run sends these", () => {
    expect(JSON.stringify(toolDefinitions)).not.toMatch(/"(oneOf|anyOf|allOf)"/);
  });

  it("gives each kind only its own fields", () => {
    const weekly = { kind: "weekly", weekdays: [1, 5], hour: 8, minute: 30 };
    expect(propose(weekly)).toEqual({ kind: "ok", invocation: { name: "schedule_propose", args: { instruction: "Read the news.", cadence: weekly } } });
    expect(propose({ kind: "everyHours", hours: 6 })).toEqual({
      kind: "ok",
      invocation: { name: "schedule_propose", args: { instruction: "Read the news.", cadence: { kind: "everyHours", hours: 6 } } },
    });
  });

  it.each([
    ["weekly with no time", { kind: "weekly", weekdays: [1] }],
    ["weekly with hours too", { kind: "weekly", weekdays: [1], hour: 8, minute: 0, hours: 2 }],
    ["everyHours with no hours", { kind: "everyHours" }],
    ["everyHours with a weekday", { kind: "everyHours", hours: 2, weekdays: [1] }],
    ["a repeated day", { kind: "weekly", weekdays: [1, 1], hour: 8, minute: 0 }],
    ["an hour out of range", { kind: "weekly", weekdays: [1], hour: 24, minute: 0 }],
    ["hours out of range", { kind: "everyHours", hours: 25 }],
    ["an unknown kind", { kind: "daily", hour: 8 }],
    ["an unknown field", { kind: "everyHours", hours: 2, seconds: 1 }],
  ])("refuses %s", (_label, cadence) => {
    expect(propose(cadence).kind).toBe("invalid");
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
      "web_fetch",
      "web_search",
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_press",
      "desktop_look",
      "desktop_click",
      "desktop_type",
      "desktop_key",
      "desktop_scroll",
      "memory_save",
      "memory_forget",
      "description_set",
      "schedule_propose",
    ]);
    for (const tool of toolDefinitions) {
      expect(JSON.stringify(tool.function.parameters)).not.toMatch(/"(anyOf|oneOf)"/);
      expect(tool.function.parameters).toMatchObject({ type: "object" });
      expect(tool.function.parameters).not.toHaveProperty("$schema");
    }
    const shell = toolDefinitions[0]?.function.parameters;
    expect(shell).toMatchObject({ required: ["command"] });
  });

  it("sends the model only each tool's name, description, and parameters", () => {
    for (const tool of toolDefinitions) {
      expect(Object.keys(tool).sort()).toEqual(["function", "type"]);
      expect(Object.keys(tool.function).sort()).toEqual(["description", "name", "parameters"]);
    }
  });
});

describe("toolEffect", () => {
  it("gives each published tool its effect", () => {
    const expected: Record<ToolName, ToolEffect> = {
      shell: "controlsComputer",
      read_file: "reads",
      write_file: "changesVm",
      web_fetch: "reads",
      web_search: "reads",
      browser_navigate: "reads",
      browser_snapshot: "reads",
      browser_click: "changesOutside",
      browser_type: "changesOutside",
      browser_press: "changesOutside",
      desktop_look: "readsScreen",
      desktop_click: "controlsComputer",
      desktop_type: "controlsComputer",
      desktop_key: "controlsComputer",
      desktop_scroll: "controlsComputer",
      memory_save: "changesMemory",
      memory_forget: "changesMemory",
      description_set: "changesMemory",
      schedule_propose: "changesSchedule",
    };
    const effects = toolDefinitions.map((tool) => [tool.function.name, toolEffect(tool.function.name as ToolName)]);
    expect(Object.fromEntries(effects)).toEqual(expected);
  });
});

describe("memory tools", () => {
  const save = { name: "memory_save", args: { text: "Out on Fridays." } };

  it("parses a save and a forget into memory invocations", () => {
    const parsed = parseToolCall({ name: "memory_save", arguments: JSON.stringify(save.args) });
    expect(parsed).toEqual({ kind: "ok", invocation: save });
    expect(parseToolCall({ name: "memory_forget", arguments: '{"id":"abc"}' })).toEqual({
      kind: "ok",
      invocation: { name: "memory_forget", args: { id: "abc" } },
    });
  });

  it.each([
    ["a save with no text", "memory_save", "{}"],
    ["a save with a second field", "memory_save", '{"text":"a","id":"b"}'],
    ["a forget with no id", "memory_forget", "{}"],
    ["a forget with a number for its id", "memory_forget", '{"id":1}'],
  ])("rejects %s", (_label, name, raw) => {
    expect(parseToolCall({ name, arguments: raw }).kind).toBe("invalid");
  });

  it("tells a memory invocation from a computer tool's", () => {
    expect(isMemoryInvocation({ name: "memory_save", args: { text: "a" } })).toBe(true);
    expect(isMemoryInvocation({ name: "memory_forget", args: { id: "a" } })).toBe(true);
    expect(isMemoryInvocation({ name: "read_file", args: { path: "a" } })).toBe(false);
  });

  it("parses a description call, and an empty text is a valid call that clears it", () => {
    expect(parseToolCall({ name: "description_set", arguments: '{"text":""}' })).toEqual({
      kind: "ok",
      invocation: { name: "description_set", args: { text: "" } },
    });
    expect(parseToolCall({ name: "description_set", arguments: "{}" }).kind).toBe("invalid");
    expect(parseToolCall({ name: "description_set", arguments: '{"text":"a","id":"b"}' }).kind).toBe("invalid");
    expect(isMemoryInvocation({ name: "description_set", args: { text: "a" } })).toBe(true);
  });

  it("keeps a description call off the link, in the wire type and in the static type", () => {
    expectTypeOf<Extract<ToolInvocation, { name: "description_set" }>>().toBeNever();
    expect(toolInvocation.safeParse({ name: "description_set", args: { text: "a" } }).success).toBe(false);
    expect(COMPUTER_TOOL_NAMES).not.toContain("description_set");
  });

  it("stays off the link's wire type, so a computerd closes the link on a routine call", () => {
    const propose = { name: "schedule_propose", args: { instruction: "a", cadence: { kind: "everyHours", hours: 1 } } };
    expect(toolInvocation.safeParse(propose).success).toBe(false);
    expect(COMPUTER_TOOL_NAMES).not.toContain("schedule_propose");
  });

  it("names every published tool but the memory tools and the routine tool as a computer tool", () => {
    expect(COMPUTER_TOOL_NAMES).toEqual(["shell", "read_file", "write_file", "web_fetch", "web_search", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press", "desktop_look", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll"]);
  });

  it("counts every published tool's result as untrusted text but a memory tool's and the routine tool's, and no unknown name", () => {
    const untrusted = toolDefinitions.map((tool) => tool.function.name).filter(returnsUntrustedText);
    expect(untrusted).toEqual(["shell", "read_file", "write_file", "web_fetch", "web_search", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_press", "desktop_look", "desktop_click", "desktop_type", "desktop_key", "desktop_scroll"]);
    expect(returnsUntrustedText("constructor")).toBe(false);
  });

  it("stays off the link's wire type, so a computerd closes the link on a memory call", () => {
    expect(toolInvocation.safeParse(save).success).toBe(false);
    const raw = JSON.stringify({ kind: "toolCall", callId: "a:b", botId: "bot", tool: save });
    expect(parseJsonMessage({ raw, schema: orchestratorMessage })).toBeNull();
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

describe("hello", () => {
  const parse = (message: object) => parseJsonMessage({ raw: JSON.stringify(message), schema: computerMessage });

  it("accepts a hello with the tools a computerd has, and one from before it named them", () => {
    const named = { kind: "hello", token: "t", tools: [...COMPUTER_TOOL_NAMES] };
    expect(parse(named)).toEqual(named);
    expect(parse({ kind: "hello", token: "t" })).toEqual({ kind: "hello", token: "t" });
  });

  it("keeps every tool from before the announcement on the link", () => {
    const onTheLink = new Set<string>(COMPUTER_TOOL_NAMES);
    expect(TOOLS_BEFORE_ANNOUNCEMENT.filter((name) => !onTheLink.has(name))).toEqual([]);
  });
});

describe("a result with a picture of the screen", () => {
  const mark = (at: number) => ({ mark: at, win: 0, role: "link", name: `\u0000${"\u2028".repeat(119)}`, states: [], box: { x: 0, y: 0, w: 10, h: 10 } });
  const view = (marks: number, base64: string): ScreenView => ({
    width: 1280,
    height: 800,
    windows: [{ app: "Chromium", pid: 7, kind: "frame", path: "/org/a11y/atspi/accessible/1", title: "\u0000".repeat(120) }],
    active: 0,
    marks: Array.from({ length: marks }, (_, index) => mark(index + 1)),
    unlisted: 0,
    silent: [],
    image: { mediaType: "image/png", base64 },
  });
  const sent = (result: object) => Buffer.byteLength(JSON.stringify({ kind: "toolResult", callId: `${"a".repeat(64)}:${"b".repeat(64)}`, result }));

  it("passes a result that fits through unchanged", () => {
    const result = { outcome: "ok" as const, output: "Looked at the screen.", truncated: false, screen: view(3, "AAAA") };
    expect(fitToLink(result)).toBe(result);
  });

  it("drops the picture first, and then marks from the end, so the frame stays under the link's limit", () => {
    const largest = "A".repeat(Math.ceil((384 * 1024) / 3) * 4);
    const result = { outcome: "ok" as const, output: "\u0000".repeat(OUTPUT_CAP_BYTES), truncated: false, screen: view(MAX_MARKS, largest) };
    expect(toolResult.safeParse(result).success).toBe(true);
    const fitted = fitToLink({ ...result, output: "\u0001".repeat(300_000) });
    expect(sent(fitted)).toBeLessThanOrEqual(MAX_COMPUTER_MESSAGE_BYTES);
    expect(fitted.screen?.image).toBeUndefined();
    expect(fitted.output).toContain("too large to send");
    expect((fitted.screen?.marks.length ?? 0) + (fitted.screen?.unlisted ?? 0)).toBe(MAX_MARKS);
  });

  it("keeps the marks and drops the picture for the journal", () => {
    const result = { outcome: "ok" as const, output: "Looked at the screen.", truncated: false, screen: view(2, "AAAA") };
    const kept = withoutScreenImage(result);
    expect(kept.screen?.image).toBeUndefined();
    expect(kept.screen?.marks).toHaveLength(2);
    expect(withoutScreenImage({ outcome: "ok", output: "", truncated: false })).toEqual({ outcome: "ok", output: "", truncated: false });
  });

  it("tells a desktop call from a browser call", () => {
    expect(isDesktopInvocation({ name: "desktop_look", args: {} })).toBe(true);
    expect(isDesktopInvocation({ name: "browser_snapshot", args: {} })).toBe(false);
  });
});

describe("desktop input", () => {
  const aim = {
    window: { app: "Chromium", pid: 7, kind: "frame", path: "/org/a11y/atspi/accessible/1", title: "a" },
    element: { role: "button", name: "Sign in", states: [], box: { x: 1, y: 2, w: 3, h: 4 } },
  };

  it.each([
    ["ctrl+l", "ctrl+l"],
    ["alt+F4", "alt+F4"],
    ["Enter", "Return"],
    ["shift+ctrl+T", "ctrl+shift+t"],
    ["ArrowDown", "Down"],
    ["page_down", "Page_Down"],
  ])("reads %s as %s", (text, combo) => {
    expect(parseKeyCombo(text)).toBe(combo);
  });

  it.each(["ctrl+", "ctrl+ctrl+l", "ctrl", "rm -rf", "hyper+a", "F13", "a+b"])("refuses %j", (text) => {
    expect(parseKeyCombo(text)).toBeNull();
  });

  it("parses a model's call with no aim, and refuses one that brings its own", () => {
    expect(parseToolCall({ name: "desktop_click", arguments: '{"mark":4}' })).toEqual({ kind: "ok", invocation: { name: "desktop_click", args: { mark: 4, button: "left" } } });
    expect(parseToolCall({ name: "desktop_click", arguments: JSON.stringify({ mark: 4, aim }) }).kind).toBe("invalid");
    expect(parseToolCall({ name: "desktop_key", arguments: '{"keys":"Enter"}' })).toEqual({ kind: "ok", invocation: { name: "desktop_key", args: { keys: "Return", times: 1 } } });
    expect(parseToolCall({ name: "desktop_key", arguments: '{"keys":"rm -rf /"}' }).kind).toBe("invalid");
    expect(parseToolCall({ name: "desktop_type", arguments: '{"text":"a\\u0000b"}' }).kind).toBe("invalid");
    expect(parseToolCall({ name: "desktop_click", arguments: '{"mark":201}' }).kind).toBe("invalid");
  });

  it("puts only an aimed call on the wire", () => {
    const call = (tool: object) => parseJsonMessage({ raw: JSON.stringify({ kind: "toolCall", callId: "a:b", botId: "bot", tool }), schema: orchestratorMessage });
    expect(call({ name: "desktop_click", args: { mark: 4, button: "left" } })).toBeNull();
    expect(call({ name: "desktop_click", args: { mark: 4, button: "left" }, aim })).not.toBeNull();
    expect(call({ name: "desktop_key", args: { keys: "ctrl+l", times: 1 }, aim: { window: null } })).not.toBeNull();
  });

  it("tells a desktop input from a look", () => {
    expect(isDesktopInputRequest({ name: "desktop_scroll", args: { mark: 1, direction: "down", amount: 3 } })).toBe(true);
    expect(isDesktopInputRequest({ name: "desktop_look", args: {} })).toBe(false);
  });
});
