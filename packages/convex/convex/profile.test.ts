import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { parseName } from "./names.js";
import { parseBotName, parseBotProfile } from "./profile.js";

const profile = (fields: { name?: string; description?: string }) =>
  parseBotProfile({ name: "Ada", description: "", ...fields });

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

  it("stores a blank description as absent", () => {
    expect(profile({ description: "\n\t" })).toEqual({ name: "Ada", description: undefined });
  });

  it("trims a description and keeps its lines", () => {
    expect(profile({ description: "\nFirst line.\n\nSecond line.\n" }).description).toBe("First line.\n\nSecond line.");
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

describe("shared name parser", () => {
  it.each(["Åsa", "שלום", "مرحبا", "👩‍💻", "ロボット"])("keeps Unicode name %s for owners and bots", (name) => {
    expect(parseName(`  ${name}  `)).toEqual({ kind: "ok", name });
    expect(parseBotName(`  ${name}  `)).toBe(name);
  });

  it("returns ordinary refusals for bot calls and the owner wrapper throws", () => {
    expect(parseName(" \n ")).toEqual({ kind: "refused", problem: "empty" });
    expect(parseName("x".repeat(65))).toEqual({ kind: "refused", problem: "tooLong" });
    expect(parseName(` ${"x".repeat(64)} `)).toEqual({ kind: "ok", name: "x".repeat(64) });
    expect(() => parseBotName("x".repeat(65))).toThrow("Name cannot be longer than 64 characters");
  });
});
