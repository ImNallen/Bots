import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { DESCRIPTION_PROBLEMS, looksLikeSecret, NOTE_PROBLEMS, parseAbout, parseDescription, parseNote, SECRET_SHAPES, textProblem } from "./memories.js";

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
    ["a zero-width non-joiner between Latin letters", "a\u200Cb"],
    ["a zero-width joiner between Latin letters", "a\u200Db"],
    ["a joiner after a Latin letter and a combining mark", "a\u0301\u200Db"],
    ["a joiner between Cyrillic letters", "\u0430\u200D\u0431"],
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
  ])("allows %s", (_label, text) => {
    expect(textProblem(text, 100)).toBeNull();
  });

  it.each([
    ["an Arabic number sign", "1\u0600 2"],
    ["an Arabic end of ayah", "\u06DD1"],
    ["a Syriac abbreviation mark", "\u0710\u070F\u0712"],
    ["an Arabic pound mark above", "\u0890\u0661"],
    ["an Arabic piastre mark above", "\u0891\u0661"],
    ["an Arabic disputed end of ayah", "\u08E2"],
    ["a Kaithi number sign", "\u{110BD}1"],
    ["a Kaithi number sign above", "\u{110CD}1"],
    ["an Egyptian hieroglyph format control", "\u{13430}"],
    ["the last Egyptian hieroglyph format control", "\u{1343F}"],
    ["an interlinear annotation", "a\uFFF9b"],
    ["a musical null notehead, which a font draws as nothing", "a\u{1D159}b"],
    ["a Tifinagh consonant joiner, which a font draws as nothing", "a\u2D7Fb"],
    ["a private use character", "a\uE000b"],
    ["a supplementary private use character", "a\u{F0000}b"],
    ["an unassigned code point", "a\u0378b"],
    ["a noncharacter", "a\uFFFEb"],
    ["a joiner after a Latin letter and an Arabic mark", "a\u064E\u200Cb"],
    ["a joiner after a Cyrillic letter and a combining mark", "\u0430\u0301\u200D\u0431"],
    ["three joiners after an Arabic letter", "\u0643\u200C\u200C\u200C"],
    ["a joiner beside an Arabic number sign, with no letter of the script", "a\u200C\u0600\u200Db"],
  ])("refuses %s", (_label, text) => {
    expect(textProblem(text, 100)).toBe("characters");
  });

  it.each([
    ["an Arabic fatha and a non-joiner before a space", "\u0643\u064E\u200C \u0628"],
    ["an Arabic shadda and a non-joiner at the end", "\u0643\u0651\u200C"],
    ["a Persian ezafe and a non-joiner before a space", "\u06A9\u062A\u0627\u0628\u0650\u200C \u0645\u0646"],
    ["an Arabic tanwin and a non-joiner before a Latin letter", "\u0642\u0637\u0639\u064B\u200Ca"],
    ["two Arabic marks and a non-joiner", "\u0643\u0651\u064E\u200C \u0628"],
    ["a Hindi udatta and a joiner before a space", "\u0915\u0951\u200D \u0916"],
    ["a Hindi anudatta and a non-joiner at the end", "\u0915\u0952\u200C"],
    ["a Vedic tone and a joiner before a space", "\u0915\u1CD0\u200D \u0916"],
    ["plain Arabic", "\u0627\u0644\u0639\u0631\u0628\u064A\u0629"],
    ["plain Syriac", "\u0710\u0712\u0713\u0715"],
    ["Syriac with a joiner", "\u0710\u200D\u0712"],
    ["a code point that Unicode reserves for emoji and has not assigned", "\u{1F02C}"],
    ["an emoji newer than these Unicode tables", "\u{1FAE9}\u{1FADC}\u{1FAC8}"],
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
const MIXED_KEY = "aB3".repeat(11);
const HEX_32 = "0f1e2d3c".repeat(4);
const HEX_40 = "0f1e2d3c".repeat(5);
const HEX_64 = "0f1e2d3c".repeat(8);
const LOWER_KEY = "a1b2".repeat(8);
const DOCUMENT_ID = "1Bx9".repeat(11);
const UUID = ["550e8400", "e29b", "41d4", "a716", "446655440000"].join("-");
const value = (length: number) => "v".repeat(length);

const STANDARD_BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE_BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LETTERS_AND_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function randomText(random: () => number, alphabet: string, length: number): string {
  return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
}

function randomBase64(random: () => number, bytes: number): string {
  const length = Math.ceil((bytes * 4) / 3);
  return randomText(random, STANDARD_BASE64_ALPHABET, length) + "=".repeat((4 - (length % 4)) % 4);
}

const matrixRandom = seededRandom(0x5ec7e7);
const MATRIX_VALUES = {
  "hex 32": HEX_32,
  "hex 40": HEX_40,
  "hex 64": HEX_64,
  "lowercase and digits 32": LOWER_KEY,
  "mixed case 32": MIXED_KEY.slice(0, 32),
  "base64url of 32 bytes": randomText(matrixRandom, URL_SAFE_BASE64_ALPHABET, 43),
  "base64 of 32 bytes": randomBase64(matrixRandom, 32),
  UUID,
};
type MatrixValue = keyof typeof MATRIX_VALUES;

const MATRIX_SYNTAXES: Record<string, (name: string, secret: string) => string> = {
  "NAME=VALUE": (name, secret) => `${name}=${secret}`,
  "NAME = VALUE": (name, secret) => `${name} = ${secret}`,
  "NAME: VALUE": (name, secret) => `${name}: ${secret}`,
  'export NAME="VALUE"': (name, secret) => `export ${name}="${secret}"`,
  '"NAME":"VALUE"': (name, secret) => `"${name}":"${secret}"`,
  '"NAME": "VALUE",': (name, secret) => `"${name}": "${secret}",`,
  'YAML NAME: "VALUE"': (name, secret) => `${name}: "${secret}"`,
  'TOML NAME = "VALUE"': (name, secret) => `${name} = "${secret}"`,
  'curl -H "NAME: VALUE"': (name, secret) => `curl -H "${name}: ${secret}" https://api.example.com/v1`,
  "?NAME=VALUE in a URL": (name, secret) => `https://example.com/cb?${name}=${secret}`,
  "Cookie: a=1; NAME=VALUE": (name, secret) => `Cookie: a=1; ${name}=${secret}`,
  '{"a":1,"NAME":"VALUE"}': (name, secret) => `{"a":1,"${name}":"${secret}"}`,
};

const MATRIX_NAMES = [
  "password",
  "TOKEN",
  "API_KEY",
  "MISTRAL_API_KEY",
  "SECRET_KEY",
  "SECRET_KEY_BASE",
  "DJANGO_SECRET_KEY",
  "PGPASSWORD",
  "DB_PASS",
  "fooToken",
  "accessToken",
  "clientSecret",
  "refreshToken",
  "JSESSIONID",
  "PHPSESSID",
  "sid",
  "session",
  "ADMIN_KEY",
  "MASTER_KEY",
  "ENCRYPTION_KEY",
  "OPENAI_KEY",
  "X-Api-Key",
  "foo.bar",
  "value",
  "x",
];
const NAMES_THAT_HOLD_HASHES = ["commit", "hash", "sha", "sha1", "sha256", "digest", "rev", "revision", "etag", "id", "uuid"];
const VALUES_A_HASH_NAME_MAY_HOLD: readonly MatrixValue[] = ["hex 40", "hex 64", "UUID"];

function matrixCells(names: readonly string[], values: readonly MatrixValue[]) {
  return names.flatMap((name) =>
    values.flatMap((valueLabel) =>
      Object.entries(MATRIX_SYNTAXES).map(([syntax, write]) => ({
        cell: `${name} / ${valueLabel} / ${syntax}`,
        text: write(name, MATRIX_VALUES[valueLabel]),
      })),
    ),
  );
}

const ALL_MATRIX_VALUES = Object.keys(MATRIX_VALUES) as MatrixValue[];
const passedCells = (cells: { cell: string; text: string }[]) => cells.filter(({ text }) => textProblem(text, 8000) !== "secret").map(({ cell }) => cell);

describe("a long value after any name", () => {
  it("is refused in every name, value, and syntax", () => {
    expect(passedCells(matrixCells(MATRIX_NAMES, ALL_MATRIX_VALUES))).toEqual([]);
  });

  it("passes only as a hash or a UUID under a name that holds one", () => {
    const hashCells = matrixCells(NAMES_THAT_HOLD_HASHES, VALUES_A_HASH_NAME_MAY_HOLD);
    const refusedHashCells = hashCells.filter(({ text }) => textProblem(text, 8000) !== null).map(({ cell }) => cell);
    expect(refusedHashCells).toEqual([]);
  });

  it("is refused under a hash's name when the value is no hash or UUID", () => {
    const others = ALL_MATRIX_VALUES.filter((label) => !VALUES_A_HASH_NAME_MAY_HOLD.includes(label));
    expect(passedCells(matrixCells(NAMES_THAT_HOLD_HASHES, others))).toEqual([]);
  });

  it.each([
    ["an exempt name in capitals", `COMMIT=${HEX_40}`],
    ["an image digest", `sha256:${HEX_64}`],
    ["an image with a digest", `ghcr.io/org/app@sha256:${HEX_64}`],
    ["a request id with two words", `Request ID: ${UUID}`],
    ["a hash at the end of a sentence", `The commit: ${HEX_40}.`],
  ])("passes %s", (_label, text) => {
    expect(textProblem(text, 8000)).toBeNull();
  });
});

describe("a key after a URL", () => {
  const PRINTABLE_PUNCTUATION = Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index)).filter((character) => !/[A-Za-z0-9]/.test(character));
  const SEPARATORS = [...PRINTABLE_PUNCTUATION, "\\n", "%2C", "%20", " ", "\n"];
  const KNOWN_PATH_GAP = [".", "-", "_", "~", "/"];
  const URLS = ["https://x.com", "https://x.com/docs/guide", "https://x.com:8080/docs"];
  const KEYS = { "mixed case": MIXED_KEY.slice(0, 32), "lowercase and digits": LOWER_KEY, "hex 32": HEX_32 };

  const cells = URLS.flatMap((url) =>
    Object.entries(KEYS).flatMap(([keyLabel, key]) =>
      SEPARATORS.map((separator) => ({ cell: `${url} ${JSON.stringify(separator)} ${keyLabel}`, separator, text: `${url}${separator}${key}` })),
    ),
  );

  it("covers all 32 printable punctuation characters", () => {
    expect(PRINTABLE_PUNCTUATION).toHaveLength(32);
  });

  it("is refused after every separator that is not part of a URL's path", () => {
    const passed = cells.filter(({ separator, text }) => !KNOWN_PATH_GAP.includes(separator) && textProblem(text, 8000) !== "secret");
    expect(passed.map(({ cell }) => cell)).toEqual([]);
  });

  it("passes after the separators of the path gap the docs record", () => {
    const refused = cells.filter(({ separator, text }) => KNOWN_PATH_GAP.includes(separator) && textProblem(text, 8000) !== null);
    expect(refused.map(({ cell }) => cell)).toEqual([]);
  });

  it.each([
    ["a key in a URL's query", `https://x.com/a?q=${MIXED_KEY}`],
    ["a hash in a URL's query", `https://x.com/a?q=${HEX_40}`],
    ["a key in a URL's fragment", `https://x.com/a#${MIXED_KEY}`],
    ["a key as a URL's user", `https://${MIXED_KEY}@github.com/o/r`],
    ["a hash as a URL's user", `git clone https://${HEX_40}@github.com/o/r`],
    ["a key where a URL's host belongs", `mistral://${MIXED_KEY}/`],
    ["a hash after a URL and a colon", `https://x.com:${HEX_40}`],
    ["a key that starts with digits, after a URL and a colon", `https://x.com:123${MIXED_KEY.slice(0, 29)}`],
    ["a key that ends with a scheme", `${MIXED_KEY}://x`],
  ])("refuses %s", (_label, text) => {
    expect(textProblem(text, 8000)).toBe("secret");
  });

  it("passes a key in the path of a URL inside a query, which is the path gap", () => {
    expect(textProblem(`https://x.com/a?next=https://y.com/${MIXED_KEY}`, 8000)).toBeNull();
  });
});

describe("random tokens", () => {
  const random = seededRandom(0x20261107);
  const tokens = Array.from({ length: 2000 }, (_, index) => {
    const length = 32 + Math.floor(random() * 33);
    const kinds = [
      () => randomBase64(random, Math.floor((length * 3) / 4)),
      () => randomText(random, URL_SAFE_BASE64_ALPHABET, length),
      () => randomText(random, LETTERS_AND_DIGITS, length),
    ];
    return kinds[index % kinds.length]?.() ?? "";
  });

  it("are refused standing alone", () => {
    expect(tokens.filter((token) => textProblem(token, 8000) !== "secret")).toEqual([]);
  });

  it("are refused in a sentence", () => {
    expect(tokens.filter((token) => textProblem(`The value for prod is ${token} until Friday.`, 8000) !== "secret")).toEqual([]);
  });
});

describe("SECRET_SHAPES", () => {
  const refused: [keyof typeof SECRET_SHAPES, string, string][] = [
    ["pemHeader", "a PEM header", ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ")],
    ["pemHeader", "a PEM header inside a sentence", `Here it is: ${["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ")}`],
    ["openAiStyleKey", "an OpenAI-style key", `use sk-proj-${"a1".repeat(10)}`],
    ["openAiStyleKey", "a bare OpenAI-style key", `sk-${"a1b2".repeat(6)}`],
    ["stripeKey", "a Stripe secret key", `sk_live_${"a1".repeat(8)}`],
    ["stripeKey", "a Stripe restricted key", `rk_test_${"a1".repeat(8)}`],
    ["githubToken", "a GitHub token", `ghp_${"a1".repeat(18)}`],
    ["githubToken", "a GitHub fine-grained token", `github_pat_${"a1".repeat(18)}`],
    ["gitlabToken", "a GitLab token", `glpat-${"a1".repeat(10)}`],
    ["slackToken", "a Slack token", `xoxb-${"1".repeat(12)}-abcdefgh`],
    ["huggingFaceToken", "a Hugging Face token", `hf_${"a1".repeat(17)}`],
    ["npmToken", "an npm token", `npm_${"a1".repeat(18)}`],
    ["tailscaleKey", "a Tailscale key", `tskey-auth-${"a1".repeat(10)}`],
    ["digitalOceanToken", "a DigitalOcean token", `dop_v1_${"a1".repeat(16)}`],
    ["shopifyToken", "a Shopify token", `shpat_${"a1".repeat(16)}`],
    ["awsAccessKey", "an AWS access key", `AKIA${"A1".repeat(8)}`],
    ["googleApiKey", "a Google key", `AIza${"a1".repeat(17)}`],
    ["jwt", "a JWT", ["eyJh", "eyJz", "abc123"].join(".")],
    ["pairWithEquals", "a password pair", "password=hunter2"],
    ["pairWithEquals", "an API key pair with spaces", "api key = abc123"],
    ["pairWithEquals", "a pair with more words after it", "token=abc is what the site gave me"],
    ["pairWithEquals", "a pair after an underscore", "FOO_PASSWORD=hunter2"],
    ["pairWithEquals", "a pair after an underscore with spaces", "my_token = abc123"],
    ["pairWithColon", "a password pair with a colon and a space", "My Password: hunter2"],
    ["pairWithColon", "a token pair with no space", "token:abc"],
    ["pairWithColon", "a pair on one line of several", "Hello.\nPassword: hunter2\nThanks."],
    ["pairWithColon", "a pair whose value is on the next line", "Password:\nhunter2"],
    ["pairWithColon", "a pair with spaces after its value", "secret: hunter2  "],
    ["urlPassword", "a URL with a password", "https://ada:hunter2@example.com/"],
    ...["token", "key", "api_key", "apikey", "secret", "password", "access_token", "auth", "sig", "signature"].flatMap(
      (name): [keyof typeof SECRET_SHAPES, string, string][] => [
        ["urlQuerySecret", `a query parameter named ${name}`, `https://example.com/cb?${name}=${value(16)}`],
        ["urlQuerySecret", `a later query parameter named ${name.toUpperCase()}`, `https://example.com/cb?page=2&${name.toUpperCase()}=${value(30)}&sort=new`],
      ],
    ),
    ["urlQuerySecret", "a percent-encoded value in a URL's query", `https://example.com/cb?sig=${"ab%2F".repeat(4)}`],
    ["slackWebhook", "a Slack webhook", `https://hooks.slack.com/services/${["T01", "B02", "c3".repeat(12)].join("/")}`],
    ["discordWebhook", "a Discord webhook", `https://discord.com/api/webhooks/${"1".repeat(18)}/${"c3".repeat(30)}`],
    ["cardNumber", "a card number with spaces", "4242 4242 4242 4242"],
    ["cardNumber", "a card number with hyphens", "4242-4242-4242-4242"],
    ["cardNumber", "an unbroken card number", "4242424242424242"],
    ["cardNumber", "an American Express number", "3782 822463 10005"],
    ["cardNumber", "a 13 digit card number", "4222222222222"],
    ["cardNumber", "a 13 digit card number with spaces", "4222 2222 22222"],
    ["cardNumber", "a card number and its security code", "4242 4242 4242 4242 123"],
    ["cardNumber", "a card number in a sentence", "Charge 4242-4242-4242-4242 today."],
    ["longToken", "a bare mixed-case key", MIXED_KEY],
    ["longToken", "a mixed-case key of exactly 32 characters", MIXED_KEY.slice(0, 32)],
    ["longToken", "a mixed-case key inside a sentence", `the value is ${MIXED_KEY} today`],
    ["longToken", "a mixed-case key after a URL and a space", `https://x/ ${MIXED_KEY}`],
    ["longToken", "a mixed-case key before a URL", `${MIXED_KEY} https://x/`],
    ["longToken", "a key in JSON after a URL", `{"baseUrl":"https://api.mistral.ai","apiKey":"${MIXED_KEY}"}`],
    ["longToken", "a key in a CSV line with a URL", `name,https://api.mistral.ai,${MIXED_KEY}`],
    ["longToken", "a key after a markdown link", `[docs](https://x.com):${MIXED_KEY}`],
    ["longToken", "a key after a URL and a semicolon", `Endpoint=https://x.example.com/;Key=${MIXED_KEY}`],
    ["longToken", "a bare 32 character hex token", HEX_32],
    ["longToken", "a bare 32 character run of lowercase letters and digits", LOWER_KEY],
    ["longToken", "a Convex id, which looks the same as a key", `My main bot is ${"j97dr5mq".repeat(4)}.`],
    ["longToken", "a 41 character hex run", `${HEX_40}0`],
    ["longToken", "a 39 character hex run", HEX_40.slice(0, 39)],
    ["longToken", "a 40 character uppercase hex run", HEX_40.toUpperCase()],
    ["longToken", "a hash joined to a word", `build-${HEX_40}`],
    ["longToken", "a UUID joined to a word", `${UUID}-${"ab".repeat(4)}`],
    ["longToken", "a long run of letters in two cases", "aB".repeat(20)],
    ["longToken", "a long run of uppercase letters and digits", "A1".repeat(20)],
    ["longToken", "a long run of lowercase letters", "z".repeat(40)],
    ["longToken", "a long camelCase run with no separator", "getUserProfileSettingsForAccountMigration"],
    ["longToken", "a long word beside a short one", `${"a".repeat(32)}-word`],
    ["longToken", "a dashed key in random case", "aBcD-eFgH-iJkL-mNoP-qRsT-uVwX-yZaB-cDeF"],
    ["longToken", "base64 padded to exactly 32 characters", `${"aB3xQ7/z".repeat(3)}aB3xQ7==`],
    ["longToken", "a mysql password flag with no space", `mysql -u root -p${HEX_40}`],
    ["longValueAfterEqualsOrColon", "a token in one line of JSON with more fields", `{"access_token": "${HEX_40}", "expires_in": 3600}`],
    ["longValueAfterEqualsOrColon", "a Django secret", `SECRET_KEY=${HEX_40}`],
    ["longValueAfterEqualsOrColon", "a Postgres password", `PGPASSWORD=${HEX_40}`],
    ["longValueAfterEqualsOrColon", "a camelCase name", `fooToken=${HEX_40}`],
    ["longValueAfterEqualsOrColon", "minified JSON", `"accessToken":"${HEX_40}"`],
    ["longValueAfterEqualsOrColon", "a Java session cookie", `JSESSIONID=${HEX_40}`],
    ["longValueAfterEqualsOrColon", "an admin key", `ADMIN_KEY=${HEX_40}`],
    ["longValueAfterEqualsOrColon", "a header in a curl command", `curl -H "X-Api-Key: ${HEX_40}"`],
    ["longValueAfterEqualsOrColon", "a user and token in a curl command", `curl -u ada:${HEX_40}`],
    ["longValueAfterEqualsOrColon", "a PHP session in a cookie header", `Cookie: x=1; PHPSESSID=${HEX_40}`],
    ["longValueAfterEqualsOrColon", "a value of exactly 16 characters", `x=${"a1b2".repeat(4)}`],
    ["longValueAfterEqualsOrColon", "a name that ends in a bracket", `API key (prod): ${HEX_40}`],
    ["longValueAfterEqualsOrColon", "a scheme word with a colon", `Bearer: ${HEX_40}`],
    ["longValueAfterEqualsOrColon", "JSON inside a JSON string", `{\"accessToken\":\"${HEX_40}\"}`],
    ["longValueAfterEqualsOrColon", "a value in backticks", `API key: \`${HEX_40}\``],
    ["longValueAfterEqualsOrColon", "a value in brackets", `mistral_key: (${HEX_40})`],
    ["longValueAfterEqualsOrColon", "a value in angle brackets", `mistral_key: <${HEX_40}>`],
    ["longValueAfterEqualsOrColon", "a scheme word with an equals sign", `bearer=${HEX_40}`],
    ["longValueAfterFlag", "a token flag", `deploy --token ${HEX_40}`],
    ["longValueAfterFlag", "an API key flag with a quote", `deploy --api-key "${HEX_40}"`],
    ["longValueAfterFlag", "a flag whose name ends in a secret's name", `deploy --client-secret ${HEX_40}`],
    ["longValueAfterFlag", "a password flag with one dash", `run -password ${HEX_40}`],
    ["longValueAfterFlag", "a flag named auth", `run --auth ${HEX_40}`],
    ["longValueAfterFlag", "a flag named pass", `run --pass ${HEX_40}`],
    ["longValueAfterSecretWord", "a bearer token", `Authorization: Bearer ${HEX_40}`],
    ["longValueAfterSecretWord", "a bearer token with dots and dashes", `bearer ${"a1b.c2d-".repeat(3)}`],
    ["longValueAfterSecretWord", "a bearer token of exactly 16 characters", `Bearer ${"a1b2".repeat(4)}`],
    ["longValueAfterSecretWord", "a bearer token in quotes", `Bearer "${HEX_40}"`],
    ["longValueAfterSecretWord", "a token scheme", `Authorization: Token ${HEX_40}`],
    ["longValueAfterSecretWord", "a basic scheme", `Authorization: Basic ${"dXNlcjpodW50ZXIy"}`],
    ["longValueAfterSecretWord", "an API key scheme", `Authorization: ApiKey ${HEX_40}`],
    ["longValueAfterSecretWord", "a sentence that names its key", `my api key is ${HEX_40}`],
    ["longValueAfterSecretWord", "a word that names a password", `password ${HEX_40}`],
    ["longValueAfterSecretWord", "a word that names a key", `The key is ${HEX_40}`],
  ];

  it("has a refused example for every shape", () => {
    expect(new Set(refused.map(([shape]) => shape))).toEqual(new Set(Object.keys(SECRET_SHAPES)));
  });

  it.each(refused)("%s finds %s", (shape, _label, text) => {
    expect(SECRET_SHAPES[shape](text)).toBe(true);
    expect(looksLikeSecret(text)).toBe(true);
    expect(textProblem(text, 8000)).toBe("secret");
  });
});

const JOB_DESCRIPTION = [
  "You are the release scout for the Bots project. Each morning you read the changelog at https://github.com/ImNallen/Bots/releases/tag/v1.2.3 and the planning sheet at https://docs.google.com/spreadsheets/d/" + DOCUMENT_ID + "/edit#gid=0.",
  "Summarize what changed in two sentences, and link the pull request, such as https://github.com/ImNallen/Bots/pull/34.",
  "If a build broke, name the commit, for example 039d8d6 or " + HEX_40 + ", and ask the owner before you retry it.",
  "Use the model mistral-large-2411 for long summaries, and keep each report under 200 words.",
  "Never ask for a password, and never store a token: ask the owner to take over the screen instead.",
].join(" ");

const README_PARAGRAPH = [
  "Install the packages with `pnpm install`, then read docs/architecture.md and packages/convex/convex/memories.test.ts.",
  "The config lives in ~/.config/chromium/Default/Preferences.backup and /usr/local/lib/python3.11/site-packages/numpy/__init__.py on the build host.",
  "See https://docs.example.com/guides/how-to-configure-release-notes-for-teams and https://en.wikipedia.org/wiki/Foo_(bar) for background.",
  "The API answers with application/vnd.github.v3+json, and the session id is printed as " + UUID + ".",
].join("\n");

const LIST_OF_LINKS = [
  "- [Spec](https://docs.google.com/document/d/" + DOCUMENT_ID + "/edit)",
  "- [Design](https://www.figma.com/file/" + DOCUMENT_ID + "/Design-System?node=1)",
  "- [Dashboard](https://grafana.example.com/d/abc/overview?orgId=1&from=now-24h&to=now&var-service=orchestrator)",
  "- [Video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)",
  "- <https://github.com/org/repo/commit/" + HEX_40 + ">",
  "- s3://bots-reports/2026/11/07/daily-report-final-version-two-reviewed.pdf",
].join("\n");

const CODE_FENCE = ["```ts", "const x = 1;", "const name = `verify_agent_description_scenario_long_name`;", "export function getUser(id: string) {", "  return users.get(id);", "}", "```"].join("\n");

const MARKDOWN_TABLE = [
  "| Name | Status | Updated |",
  "|--------------------------------|--------|---------------------|",
  "| state-of-the-art-end-to-end-release-note-summarizer | done | 2026-11-07T10:00:00Z |",
  "| hf-transformers-tokenizer-fast-loader | open | 2026-11-06 |",
].join("\n");

const ORDINARY_TEXT: readonly string[] = [
  JOB_DESCRIPTION,
  README_PARAGRAPH,
  LIST_OF_LINKS,
  CODE_FENCE,
  MARKDOWN_TABLE,
  "Ada prefers short answers, and she is out every Friday.",
  "The order is abc123, ticket BOT-42.",
  `[Spec](https://docs.google.com/document/d/${MIXED_KEY}/edit)`,
  `"https://docs.google.com/document/d/${MIXED_KEY}/edit"`,
  `https://a.example/${MIXED_KEY}, https://b.example/${MIXED_KEY}`,
  "See the notes (https://docs.example.com/guides/how-to-configure-release-notes-for-teams).",
  "Send the bearer token in a header.",
  "The session was short, and the cookie: banner stayed.",
  "Tokens: many, and the budget: small.",
  "MY_TOKEN_URL=https://x.example/a",
  "It broke in 039d8d6.",
  "Release notes live at https://github.com/ImNallen/Bots/releases/tag/v1.2.3",
  "https://docs.example.com/guides/how-to-configure-release-notes-for-teams",
  `The plan is in https://docs.google.com/document/d/${DOCUMENT_ID}/edit`,
  `[the plan](https://docs.google.com/document/d/${DOCUMENT_ID}/edit)`,
  "s3://bots-reports/2026/11/07/daily-report-final-version-two-reviewed.pdf",
  "https://grafana.example.com/d/abc/overview?orgId=1&from=now-24h&to=now&var-service=orchestrator",
  "Slack webhooks start with hooks.slack.com/services/ as a rule.",
  "Discord webhooks start with discord.com/api/webhooks/ as a rule.",
  `https://example.com/cb?key=${value(15)}`,
  `https://example.com/cb?monkey=${value(31)}`,
  "4129c345".repeat(5),
  UUID,
  UUID.toUpperCase(),
  `sha256:${"e9c084e8".repeat(8)}`,
  `It broke in ${HEX_40}.`,
  HEX_64,
  MIXED_KEY.slice(0, 31),
  "-".repeat(40),
  "=".repeat(40),
  "_".repeat(40),
  "~".repeat(40),
  ".".repeat(40),
  "1234567890".repeat(4),
  "state-of-the-art-end-to-end-release-note-summarizer",
  "verify_agent_description_scenario_long_name",
  "hf-transformers-tokenizer-fast-loader",
  "npm-check-updates-with-a-long-name",
  "A task-tracker is fine.",
  "sk-learn is the library I use.",
  "Away 2026-11-06 2026-11-07",
  "Away 2026-11-06 2026-11-18",
  "Gate code 12345678",
  "Call +46 70 123 45 67 if it breaks.",
  "1794067200000",
  "4242 4242 4242 4241",
  `${MIXED_KEY.slice(0, 31)}://x`,
  "Never ask for my password.",
  "The token count matters to me.",
  "The secret: be brief.",
  "Rotate the API key: ask the owner first.",
  "I help reset a password: open the admin console.",
  "Token budget: 150000",
  "The password:",
  "My password: hunter2 and more",
  "packages/convex/convex/memories.test.ts",
  "docs.example.com/guides/how-to-configure-release-notes",
  "/usr/local/lib/node_modules/typescript/lib/tsc.js",
  "~/.nvm/versions/node/v20.11.1/bin/node",
  "rustc-1.80.0-aarch64-apple-darwin.tar.xz",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  'curl -H "Accept: application/vnd.github.v3+json" https://api.github.com/repos/o/r',
  "oauth2-proxy-configuration-for-kubernetes-clusters",
  "model: mistral-large-2411",
  "file: report-2026-q3-final-version.pdf",
  "branch: release-2026-11-07",
  "git@github.com:org2/repo2-with-a-long-name.git",
  "Email: firstname.lastname1234@example.com",
  "Please rotate the token now, then go",
  "Use token: abc123, then go",
  "The secret: patience matters",
  "access key: none yet",
  "The private key: keep it safe",
  "account key: see the vault",
  "max_token: 100",
  "max_token=100",
  "page_token=abc",
  "next_page_token: abc",
  "input_token: 1500",
  "output_token = 200",
  "csrf_token: required",
  "user_token: none",
  "my_password = compute()",
  "db_password = os.environ['DB_PASSWORD']",
  "my_api_key: required",
  "access_token: string",
  "client_secret: string",
  "refresh_token: optional",
  "FOO_TOKEN=changeme",
  "DB_PASSWORD=",
  "DB_PASSWORD= ",
  "token=",
  "if (token == null)",
  "if (secret != other)",
  "passwordHash=bcrypt(pw)",
  "token_count = 12",
  "secret_name = foo",
  "tokens = 12",
  "tokens: 12",
  "Tokens: many",
  "password_hint: blue",
  '"password": "required"',
  '"token": null',
  '{"token": ""}',
  "AccountKey=<your key>",
  "Account key = none",
  "The Bearer authentication-scheme is standard",
  "bearer authorization-header-format",
  "Use a bearer token-based-authentication",
  "Authorization: Bearer YOUR_API_KEY_HERE",
  "Authorization: Bearer <token>",
  "Bearer abcdefghijklmnop",
  "The bearer of-this-letter-is-my-friend",
  "standard-bearer of-the-revolution-today",
  "session=",
  "session=abc123",
  "session=production-environment",
  "session=2026-11-07T10:00:00Z",
  '{"created_at": "2026-11-07T10:00:00.000Z", "session": "2026-11-07T10:00:00Z"}',
  "the setting session=long-running-background means it stays",
  "sid=my-service-identifier-long",
  "SID=my-service-identifier-long",
  "cookie: banner",
  "Cookie: consent=accepted-all-the-things",
  "cookie: theme=solarized-dark-high-contrast",
  "session-id=abc",
  "tmux attach -t session=my-long-running-session",
  "?session=my-long-running-session-name",
  "https://en.wikipedia.org/wiki/Foo_(bar)",
  "https://en.wikipedia.org/wiki/Foo,_Bar",
  "https://example.com/a,b/c",
  "https://example.com/a(b)/c",
  `[Spec](https://docs.google.com/document/d/${DOCUMENT_ID}/edit) and [Two](https://docs.google.com/document/d/${DOCUMENT_ID}/edit)`,
  `<https://docs.google.com/document/d/${DOCUMENT_ID}/edit>`,
  `![img](https://x.example/${DOCUMENT_ID}.png)`,
  `https://a.example/${DOCUMENT_ID},https://b.example/${DOCUMENT_ID}`,
  `https://docs.google.com/spreadsheets/d/${DOCUMENT_ID}/edit#gid=0`,
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://github.com/ImNallen/Bots/pull/34",
  `https://github.com/org/repo/commit/${HEX_40}`,
  "the_quick_brown_fox_jumps_over_the_lazy_dog",
  "how-to-configure-release-notes-for-teams",
  "getUserProfile.settings.forAccount.migrationV2",
];

describe("ordinary text", () => {
  it.each(ORDINARY_TEXT.map((text) => [text]))("passes %s", (text) => {
    expect(textProblem(text, 8000)).toBeNull();
  });
});

describe("ordinary text that stays refused", () => {
  it.each([
    ["one token follows a secret's name and the line ends, as on main", "Please rotate the token: tomorrow"],
    ["one token follows a secret's name and the line ends, as on main", "Reset the password: done"],
    ["one token follows a secret's name and the line ends, as on main", "Token: valid"],
    ["one token follows a secret's name and the line ends, as on main", "Password: required"],
    ["one token follows a secret's name and the line ends, as on main", "Secret: Santa"],
    ["one token follows a secret's name and the line ends, as on main", "New API key: rotated"],
    ["one token follows a secret's name and the line ends, as on main", "The word after token: value"],
    ["one token follows a secret's name and the line ends, as on main", "token: value"],
    ["one token follows a secret's name and the line ends, as on main", "It costs one token: cheap."],
    ["one token follows a secret's name and the line ends, as on main", "Budget: small, token: large"],
    ["one token follows a secret's name and the line ends, as on main", "Remember the secret: patience"],
    ["one token follows a secret's name and the line ends, as on main", "Here is the secret: patience"],
    ["one token follows a secret's name and the line ends, as on main", "x-api-key: required"],
    ["one token follows a secret's name and the line ends, as on main", "api key: required"],
    ["a secret's name has = and a value, as on main", "api_key = os.getenv('API_KEY')"],
    ["a secret's name has = and a value, as on main", "Set the API_KEY=your-key-here in .env"],
    ["a secret's name has = and a value, as on main", "password = NULL"],
    ["a secret's name has = and a value, as on main", "const token = getToken();"],
    ["the URL ends at the comma, so the id is a long token", `https://res.cloudinary.com/demo/image/upload/w_100,h_100/${DOCUMENT_ID}.png`],
    ["the URL ends at the bracket, so the id is a long token", `https://en.wikipedia.org/wiki/Foo_(${DOCUMENT_ID})`],
    ["the URL ends at the @, so the id is a long token", `https://www.google.com/maps/place/X/@59.3,18.0,15z/data=!3m1!4b1!${DOCUMENT_ID}`],
    ["the URL ends at the semicolon, so the id is a long token", `https://x.example/a;v=${DOCUMENT_ID}`],
    ["the URL ends at the pipe, so the id is a long token", `https://x.example/a|${DOCUMENT_ID}`],
    ["the URL ends at the brace, so the id is a long token", `https://x.example/{${DOCUMENT_ID}}`],
    ["the URL ends at the bracket, so the id is a long token", `https://x.example/[${DOCUMENT_ID}]`],
    ["the URL ends at the quote, so the id is a long token", `https://x.example/'${DOCUMENT_ID}'`],
    ["the id is not in a URL", `[${DOCUMENT_ID}](https://docs.google.com/document/d/${DOCUMENT_ID}/edit)`],
    ["the id is not in a URL", `[Spec](https://docs.google.com/document/d/${DOCUMENT_ID}/edit "${DOCUMENT_ID}")`],
    ["a URL's query is read", `https://www.youtube.com/playlist?list=${DOCUMENT_ID}`],
    ["with no scheme it is no URL", `docs.google.com/document/d/${DOCUMENT_ID}/edit`],
    ["a word with a digit inside it reads as a token", "IMG_20260101_123456_HDR_Screenshot_FINAL_v2Copy.png"],
    ["a word with a digit inside it reads as a token", "k8s/deployments/orchestrator-config.yaml/backups"],
    ["camelCase with a digit and no separator reads as a token", "getUserProfileSettingsForAccountV2Migration"],
    ["it starts with an npm token's prefix", "npm_config_registry_is_set_here_ok"],
    ["a mixed value of 16 or more characters after a name reads as a token", "Tracking: 1Z999AA10123456784"],
    ["a mixed value of 16 or more characters after a name reads as a token", "IBAN: SE3550000000054910000003"],
    ["a mixed value of 16 or more characters after a name reads as a token", `https://example.com/items?id=${"abc123def456".repeat(2)}`],
    ["a name that holds no hash is no exemption", `request_id=${UUID}`],
  ])("because %s: %s", (_reason, text) => {
    expect(textProblem(text, 8000)).toBe("secret");
  });
});

describe("textProblem's speed", () => {
  const fill = (unit: string, length: number, tail = "") => unit.repeat(Math.ceil((length - tail.length) / unit.length)).slice(0, length - tail.length) + tail;
  const LONGEST_ALLOWED_TEXT = 8000;

  it.each([
    ["a secret's name and colon, repeated", fill("token:", LONGEST_ALLOWED_TEXT, " x")],
    ["a JWT's start, repeated", fill("eyJ-", LONGEST_ALLOWED_TEXT)],
    ["dashes", fill("-", LONGEST_ALLOWED_TEXT, "!")],
    ["a name and equals, repeated", fill("a=", LONGEST_ALLOWED_TEXT)],
    ["a flag and many spaces", `--token${fill(" ", LONGEST_ALLOWED_TEXT - 8)}!`],
    ["a scheme, repeated", fill("a://", LONGEST_ALLOWED_TEXT)],
    ["combining marks before a joiner", `\u0627${fill("\u064E", LONGEST_ALLOWED_TEXT - 2)}\u200C`],
  ])("stays under 100 ms on %s", (_label, text) => {
    const fastest = Math.min(
      ...Array.from({ length: 3 }, () => {
        const started = performance.now();
        textProblem(text, LONGEST_ALLOWED_TEXT);
        return performance.now() - started;
      }),
    );
    expect(fastest).toBeLessThan(100);
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
