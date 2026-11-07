import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { parseBotName, parseBotProfile } from "./profile.js";

const profile = (fields: { name?: string; title?: string; description?: string }) =>
  parseBotProfile({ name: "Ada", title: "", description: "", ...fields });

describe("parseBotName", () => {
  it("trims a name", () => {
    expect(parseBotName("  Ada  ")).toBe("Ada");
  });

  it("refuses a blank name", () => {
    expect(() => parseBotName("   ")).toThrow(ConvexError);
  });

  it("allows 64 characters and refuses 65, counted after trimming", () => {
    expect(parseBotName(` ${"x".repeat(64)} `)).toHaveLength(64);
    expect(() => parseBotName("x".repeat(65))).toThrow(ConvexError);
  });
});

describe("parseBotProfile", () => {
  it("applies the name rules", () => {
    expect(profile({ name: " Ada " }).name).toBe("Ada");
    expect(() => profile({ name: " " })).toThrow(ConvexError);
  });

  it("stores a blank title or description as absent", () => {
    expect(profile({ title: "  ", description: "\n\t" })).toEqual({ name: "Ada", title: undefined, description: undefined });
  });

  it("trims the ends of a title and a description and keeps the lines inside", () => {
    const { title, description } = profile({ title: " Scout ", description: "\nFirst line.\n\nSecond line.\n" });
    expect(title).toBe("Scout");
    expect(description).toBe("First line.\n\nSecond line.");
  });

  it("allows a 64 character title and refuses 65, and the error names the title", () => {
    expect(profile({ title: "x".repeat(64) }).title).toHaveLength(64);
    expect(() => profile({ title: "x".repeat(65) })).toThrow(/^Title.* 64 /);
  });

  it("allows an 8,000 character description and refuses 8,001, and the error names the description", () => {
    const full = `${"word ".repeat(1599)}words`;
    expect(full).toHaveLength(8000);
    expect(profile({ description: full }).description).toBe(full);
    expect(() => profile({ description: `${full}s` })).toThrow(/^Description.* 8,000 /);
  });

  it.each([
    ["a secret", "password=hunter2", /looks like a password/],
    ["a control character", "a\u0007b", /^Description cannot hold invisible or control characters/],
    ["a character that changes the text's direction", "a\u202Eb", /^Description cannot hold invisible or control characters/],
    ["a zero-width space", "a\u200Bb", /^Description cannot hold invisible or control characters/],
  ])("refuses %s from the owner, and the error says why", (_label, description, message) => {
    expect(() => profile({ description })).toThrow(message);
  });
});
