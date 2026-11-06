import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { looksLikeSecret, NOTE_PROBLEMS, parseAbout, parseNote } from "./memories.js";

const note = (text: string, otherNotes = 0) => parseNote({ text, otherNotes });
const textOfLength = (length: number) => "word ".repeat(length).slice(0, length).replace(/ $/, "x");

describe("parseNote", () => {
  it("stores the trimmed text and keeps the lines inside", () => {
    expect(note("  First line.\n\nSecond line.\n")).toEqual({ kind: "ok", text: "First line.\n\nSecond line." });
  });

  it("refuses blank text", () => {
    expect(note("  \n\t ")).toEqual({ kind: "refused", problem: "empty" });
  });

  it("allows 500 characters and refuses 501, counted after trimming", () => {
    expect(note(` ${textOfLength(500)} `)).toEqual({ kind: "ok", text: textOfLength(500) });
    expect(note(textOfLength(501))).toEqual({ kind: "refused", problem: "tooLong" });
  });

  it("allows a note when 39 others exist and refuses it when 40 do", () => {
    expect(note("Out on Fridays.", 39).kind).toBe("ok");
    expect(note("Out on Fridays.", 40)).toEqual({ kind: "refused", problem: "full" });
  });

  it.each([
    ["a NUL", "a\u0000b"],
    ["an escape", "a\u001bb"],
    ["a carriage return", "a\rb"],
    ["a C1 control", "a\u0085b"],
    ["a right-to-left override", "a\u202Eb"],
    ["a directional isolate", "a\u2067b"],
    ["a right-to-left mark", "a\u200Fb"],
    ["a line separator", "a\u2028b"],
  ])("refuses %s", (_label, text) => {
    expect(note(text)).toEqual({ kind: "refused", problem: "characters" });
  });

  it("allows a tab, an emoji with a joiner, and accented and right-to-left letters", () => {
    for (const text of ["a\tb", "👩‍💻 likes tea", "Malmö, Århus", "שלום and مرحبا"]) {
      expect(note(text).kind).toBe("ok");
    }
  });

  it("refuses a secret", () => {
    expect(note("password=hunter2")).toEqual({ kind: "refused", problem: "secret" });
  });
});

describe("NOTE_PROBLEMS", () => {
  it("tells a bot what to do about a secret, and tells an owner why", () => {
    expect(NOTE_PROBLEMS.secret.bot).toMatch(/ask your owner to take over and log in/);
    expect(NOTE_PROBLEMS.secret.owner).toMatch(/looks like/);
  });

  it("tells a bot how to make room, and tells an owner the same in the owner's terms", () => {
    expect(NOTE_PROBLEMS.full.bot).toMatch(/Forget one of your own/);
    expect(NOTE_PROBLEMS.full.owner).toMatch(/Delete one/);
  });
});

describe("looksLikeSecret", () => {
  it.each([
    ["a PEM header", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["a Mistral-style bare key", "aB3".repeat(11)],
    ["an OpenAI-style key", "use sk-proj-abcdefghijklmnop1234"],
    ["a Stripe key", "sk_live_51HabcdefGhijkl"],
    ["a GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["a GitLab token", "glpat-abcdefghijklmnopqrst"],
    ["a Slack token", "xoxb-123456789012-abcdefgh"],
    ["an AWS access key", "AKIAIOSFODNN7EXAMPLE"],
    ["a Google key", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123"],
    ["a password pair", "password=hunter2"],
    ["a password pair with a colon and a space", "My Password: hunter2"],
    ["an API key pair", "api key = abc123"],
    ["a token pair", "token:abc"],
    ["a URL with a password", "https://ada:hunter2@example.com/"],
    ["a card number with spaces", "4242 4242 4242 4242"],
    ["a card number with hyphens", "4242-4242-4242-4242"],
    ["an unbroken card number", "4242424242424242"],
    ["an American Express number", "3782 822463 10005"],
    ["a 32 character hex token", "0123456789abcdef0123456789abcdef"],
    ["a 32 character token inside a sentence", "the value is abcdefghijklmnopqrstuvwxyz012345 today"],
    ["a token in a URL's query", "https://example.com/cb?key=abcdefghijklmnopqrstuvwxyz012345"],
  ])("refuses %s", (_label, text) => {
    expect(looksLikeSecret(text)).toBe(true);
  });

  it.each([
    ["an ordinary sentence", "Ada prefers short answers, and she is out every Friday."],
    ["a short id", "The order is abc123, ticket BOT-42."],
    ["a 7 character git hash", "It broke in 039d8d6."],
    ["a 31 character unbroken run", "abcdefghijklmnopqrstuvwxyz01234"],
    ["a URL with a long path", "Release notes live at https://github.com/ImNallen/Bots/releases/tag/v1.2.3"],
    ["a date range", "Away 2026-11-06 2026-11-07"],
    ["a phone-length number", "Gate code 12345678"],
    ["the word password with no value", "Never ask for my password."],
    ["the word token in a sentence", "The token count matters to me."],
    ["sk- in a word", "A task-tracker is fine."],
    ["a short sk- word", "sk-learn is the library I use."],
  ])("allows %s", (_label, text) => {
    expect(looksLikeSecret(text)).toBe(false);
  });
});

describe("parseAbout", () => {
  it("stores the trimmed text, and blank as absent", () => {
    expect(parseAbout("  I am Ada.\nI live in Lund.\n")).toBe("I am Ada.\nI live in Lund.");
    expect(parseAbout(" \n ")).toBeUndefined();
  });

  it("allows 2,000 characters and refuses 2,001, and the error says the limit", () => {
    expect(parseAbout(textOfLength(2000))).toBe(textOfLength(2000));
    expect(() => parseAbout(textOfLength(2001))).toThrow(ConvexError);
    expect(() => parseAbout(textOfLength(2001))).toThrow(/2,000/);
  });

  it("refuses a secret and a direction control, as a note does", () => {
    expect(() => parseAbout("password=hunter2")).toThrow(/looks like/);
    expect(() => parseAbout("a\u202Eb")).toThrow(/direction/);
  });
});
