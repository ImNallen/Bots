import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { DESCRIPTION_PROBLEMS, looksLikeSecret, NOTE_PROBLEMS, parseAbout, parseDescription, parseNote, textProblem } from "./memories.js";

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

describe("textProblem's characters", () => {
  it.each([
    ["a zero-width space between Latin letters", "a\u200Bb"],
    ["a BOM", "a\uFEFFb"],
    ["a BOM at the start", "\uFEFFab"],
    ["a soft hyphen", "a\u00ADb"],
    ["a word joiner", "a\u2060b"],
    ["a tag character", "a\u{E0041}b"],
    ["a subdivision flag, which is built from tag characters", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
    ["a variation selector from the supplement", "a\u{E0100}b"],
    ["a text-style variation selector", "\u2764\uFE0E"],
    ["a Hangul filler", "a\u3164b"],
    ["a halfwidth Hangul filler", "a\uFFA0b"],
    ["a Hangul choseong filler", "a\u115Fb"],
    ["a braille blank", "a\u2800b"],
    ["a right-to-left mark", "a\u200Fb"],
    ["an Arabic letter mark", "a\u061Cb"],
    ["a left-to-right embedding", "a\u202Ab"],
    ["a right-to-left override", "a\u202Eb"],
    ["a directional isolate", "a\u2067b"],
    ["a line separator", "a\u2028b"],
    ["a paragraph separator", "a\u2029b"],
    ["a NUL", "a\u0000b"],
    ["a carriage return", "a\rb"],
    ["a C1 control", "a\u0085b"],
    ["a zero-width joiner between digits", "1\u200D2"],
    ["a zero-width joiner with no letter or emoji beside it", ". \u200D ."],
    ["a zero-width non-joiner with no letter beside it", ". \u200C ."],
    ["a zero-width non-joiner between emoji", "\u{1F469}\u200C\u{1F4BB}"],
    ["an emoji style after a Latin letter", "a\uFE0F"],
    ["an emoji style after a digit with no keycap", "1\uFE0F"],
    ["a second emoji style after an emoji", "\u2764\uFE0F\uFE0F"],
    ["a joiner between two joiners", "a\u200D\u200D\u200Db"],
  ])("refuses %s", (_label, text) => {
    expect(textProblem(text, 100)).toBe("characters");
  });

  it.each([
    ["a family emoji", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"],
    ["a joined emoji with a skin tone", "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}"],
    ["a joined emoji with an emoji style", "\u{1F3F3}\uFE0F\u200D\u{1F308}"],
    ["a joined emoji that ends in an emoji style", "\u{1F3F4}\u200D\u2620\uFE0F"],
    ["a heart with an emoji style", "\u2764\uFE0F"],
    ["a digit keycap", "1\uFE0F\u20E3"],
    ["a hash keycap", "#\uFE0F\u20E3"],
    ["Persian with a zero-width non-joiner", "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"],
    ["Persian with a zero-width non-joiner before a space", "\u0646\u0627\u0645\u0647\u200C \u0627\u06CC"],
    ["Hindi with a zero-width joiner", "\u0915\u094D\u200D\u0937"],
    ["Hindi with a zero-width non-joiner", "\u0915\u094D\u200C\u0937"],
    ["Malayalam with a joiner that ends a word", "\u0D05\u0D35\u0D28\u0D4D\u200D \u0D35\u0D28\u0D4D\u0D28\u0D41"],
    ["a tab and a line break", "a\tb\nc"],
    ["accented and right-to-left letters", "Malm\u00F6, \u05E9\u05DC\u05D5\u05DD"],
    ["a Latin word with a zero-width non-joiner, a gap the docs record", "a\u200Cb"],
  ])("allows %s", (_label, text) => {
    expect(textProblem(text, 100)).toBeNull();
  });

  it("a note trims a leading BOM, so the stored text holds none", () => {
    expect(note("\uFEFFab")).toEqual({ kind: "ok", text: "ab" });
    expect(note("\uFEFF")).toEqual({ kind: "refused", problem: "empty" });
  });
});

describe("the character refusal's words", () => {
  it.each([
    ["a note, to its owner", NOTE_PROBLEMS.characters.owner],
    ["a note, to a bot", NOTE_PROBLEMS.characters.bot],
    ["a description, to its owner", DESCRIPTION_PROBLEMS.characters.owner],
    ["a description, to a bot", DESCRIPTION_PROBLEMS.characters.bot],
  ])("name invisible characters for %s", (_label, words) => {
    expect(words).toMatch(/invisible or control characters/);
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

// Keys are built at run time, because GitHub's secret scanner flags a full key shape in this public repository, even a fake one.
describe("looksLikeSecret", () => {
  it.each([
    ["a PEM header", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["a Mistral-style bare key", "aB3".repeat(11)],
    ["an OpenAI-style key", `use sk-proj-${"a1".repeat(10)}`],
    ["a Stripe key", `sk_live_${"a1".repeat(8)}`],
    ["a GitHub token", `ghp_${"a1".repeat(18)}`],
    ["a GitLab token", `glpat-${"a1".repeat(10)}`],
    ["a Slack token", `xoxb-${"1".repeat(12)}-abcdefgh`],
    ["an AWS access key", `AKIA${"A1".repeat(8)}`],
    ["a Google key", `AIza${"a1".repeat(17)}`],
    ["a JWT", ["eyJh", "eyJz", "abc123"].join(".")],
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
    expect(() => parseAbout("a\u202Eb")).toThrow(/invisible or control characters/);
    expect(() => parseAbout("a\u200Bb")).toThrow(/invisible or control characters/);
  });
});

describe("parseDescription", () => {
  it("trims the text, keeps the lines inside, and reads a blank text as a clear", () => {
    expect(parseDescription(" A scout.\n\nIt reads notes.\n")).toEqual({ kind: "ok", text: "A scout.\n\nIt reads notes." });
    expect(parseDescription(" \n\t")).toEqual({ kind: "ok", text: undefined });
  });

  it("allows 8,000 characters and refuses 8,001", () => {
    const full = `${"word ".repeat(1599)}words`;
    expect(parseDescription(full)).toEqual({ kind: "ok", text: full });
    expect(parseDescription(`${full}s`)).toEqual({ kind: "refused", problem: "tooLong" });
  });

  it.each([
    ["a control character", "a\u0007b", "characters"],
    ["a text-direction character", "a\u202Eb", "characters"],
    ["a line separator", "a\u2028b", "characters"],
    ["a password pair", "password=hunter2", "secret"],
    ["a key", `sk-${"a1".repeat(12)}`, "secret"],
    ["a card number", "4242 4242 4242 4242", "secret"],
  ])("refuses %s", (_label, text, problem) => {
    expect(parseDescription(text)).toEqual({ kind: "refused", problem });
  });

  it("names the description to the owner, and tells the bot that nothing changed", () => {
    expect(DESCRIPTION_PROBLEMS.tooLong.owner).toMatch(/^Description .* 8,000 /);
    expect(DESCRIPTION_PROBLEMS.characters.owner).toMatch(/^Description /);
    expect(DESCRIPTION_PROBLEMS.secret.owner).toMatch(/description was not saved/);
    for (const { bot } of Object.values(DESCRIPTION_PROBLEMS)) {
      expect(bot).toMatch(/nothing changed/);
    }
  });
});
