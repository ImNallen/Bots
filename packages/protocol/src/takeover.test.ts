import { describe, expect, it } from "vitest";
import { COMPUTER_TOOL_NAMES, parseToolCall, returnsUntrustedText, toolInvocation } from "./tools.ts";

describe("request_takeover", () => {
  it("parses a bounded trimmed reason and never enters the computer wire schema", () => {
    expect(parseToolCall({ name: "request_takeover", arguments: '{"reason":"  Sign in privately  "}' })).toEqual({ kind: "ok", invocation: { name: "request_takeover", args: { reason: "Sign in privately" } } });
    expect(COMPUTER_TOOL_NAMES).not.toContain("request_takeover");
    expect(toolInvocation.safeParse({ name: "request_takeover", args: { reason: "Sign in" } }).success).toBe(false);
    expect(returnsUntrustedText("request_takeover")).toBe(false);
  });
  it.each(["", " ", "x".repeat(501)])("rejects an invalid reason", (reason) => {
    expect(parseToolCall({ name: "request_takeover", arguments: JSON.stringify({ reason }) }).kind).toBe("invalid");
  });
});
