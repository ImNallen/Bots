import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_COMPUTER_MESSAGE_BYTES, PAGE_LIMITS, fitToLink, pageView, pageAim, toolInvocation, parseToolCall, toolResult, type PageView, type ToolResult } from "./index.ts";

const page: PageView = { snapshotId: randomUUID(), origin: "https://example.com", targets: [{ ref: 1, words: "Read more", control: { kind: "submit" } }], truncated: false };

describe("page facts", () => {
  it("accepts strict schema-derived controls and optional legacy results", () => {
    expect(pageView.parse(page)).toEqual(page);
    expect(toolResult.safeParse({ outcome: "ok", output: "", truncated: false }).success).toBe(true);
  });
  it.each([
    { ...page, snapshotId: "bad" },
    { ...page, origin: "https://example.com/path?token=secret" },
    { ...page, origin: "file:///tmp/x" },
    { ...page, title: "retained" },
    { ...page, targets: [...page.targets, ...page.targets] },
    { ...page, targets: [{ ref: 1, words: "x", control: { kind: "field", field: "secret" } }] },
    { ...page, targets: [{ ref: 1, words: "x", control: { kind: "link", value: "secret" } }] },
    { ...page, targets: Array.from({ length: PAGE_LIMITS.targets + 1 }, (_, i) => ({ ref: i + 1, words: "", control: { kind: "button" } })) },
  ])("rejects invalid facts %#", (invalid) => expect(pageView.safeParse(invalid).success).toBe(false));
  it("bounds JSON escaping in addition to target count and string length", () => {
    const escaped = { ...page, targets: Array.from({ length: PAGE_LIMITS.targets }, (_, i) => ({ ref: i + 1, words: "\0".repeat(PAGE_LIMITS.words), control: { kind: "field", field: "secret", readOnly: false } })) };
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeGreaterThan(PAGE_LIMITS.jsonBytes);
    expect(pageView.safeParse(escaped).success).toBe(false);
  });
});

describe("fitting full result envelopes", () => {
  const envelopeBytes = (result: ToolResult) => Buffer.byteLength(JSON.stringify({ kind: "toolResult", callId: "x".repeat(129), result }));
  it("fits page-only and escaped oversized text, dropping facts together", () => {
    const fitted = fitToLink({ outcome: "ok", output: "\0😀".repeat(500000), truncated: false, page });
    expect(envelopeBytes(fitted)).toBeLessThanOrEqual(MAX_COMPUTER_MESSAGE_BYTES);
    expect(fitted.page).toBeUndefined();
    expect(fitted.truncated).toBe(true);
  });
  it("keeps bounded page facts when an oversized picture is removed", () => {
    const fitted = fitToLink({ outcome: "ok", output: "[1] submit Read more", truncated: false, page, screen: {
      width: 100, height: 100, windows: [], active: null, marks: [], unlisted: 0, silent: [],
      image: { mediaType: "image/png", base64: "x".repeat(MAX_COMPUTER_MESSAGE_BYTES + 1) },
    } });
    expect(envelopeBytes(fitted)).toBeLessThanOrEqual(MAX_COMPUTER_MESSAGE_BYTES);
    expect(fitted.page).toEqual(page);
    expect(fitted.screen?.image).toBeUndefined();
  });
});

describe("trusted page input wire", () => {
  const aim = { kind: "element", snapshotId: page.snapshotId, origin: page.origin, target: page.targets[0] };
  it("requires aim on the wire and rejects model aim spoofing at every accepted level", () => {
    for (const name of ["browser_click", "browser_type", "browser_press"]) {
      const args = name === "browser_click" ? { ref: 1 } : name === "browser_type" ? { ref: 1, text: "x" } : { key: "Enter" };
      expect(parseToolCall({ name, arguments: JSON.stringify(args) }).kind).toBe("ok");
      for (const forged of [{ ...args, aim }, { ...args, args: { aim } }, { ...args, target: aim }]) {
        expect(parseToolCall({ name, arguments: JSON.stringify(forged) }).kind).toBe("invalid");
      }
      expect(toolInvocation.safeParse({ name, args }).success).toBe(false);
    }
    expect(toolInvocation.safeParse({ name: "browser_click", args: { ref: 1 }, aim }).success).toBe(true);
  });
  it("distinguishes historical absence, observed none, target and unlisted focus", () => {
    for (const focus of [undefined, { kind: "none" }, { kind: "unlisted" }, { kind: "target", ref: 1 }]) {
      expect(pageView.safeParse({ ...page, focus }).success).toBe(true);
    }
    expect(pageView.safeParse({ ...page, focus: { kind: "target", ref: 2 } }).success).toBe(false);
    expect(pageAim.safeParse({ kind: "focus", snapshotId: page.snapshotId, origin: null, focus: { kind: "target", ref: 1 }, target: null }).success).toBe(false);
  });
});
