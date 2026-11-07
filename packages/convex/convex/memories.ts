import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireOwnedBot } from "./identity.js";
import type { MemoryCall, RunEventBody } from "./validators.js";

const MAX_NOTES = 40;
const MAX_NOTE_LENGTH = 500;
const MAX_ABOUT_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 8000;

const found = (pattern: RegExp) => (text: string) => pattern.test(text);

const SECRET_NAME = /(?:password|passwd|passphrase|passcode|pwd|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key)/;

const CARD_IN_GROUPS_OF_FOUR = /\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}/;
const CARD_OF_THIRTEEN_DIGITS = /\d{4}[ -]\d{4}[ -]\d{5}/;
const CARD_LIKE_AMERICAN_EXPRESS = /\d{4}[ -]\d{6}[ -]\d{4,5}/;
const UNBROKEN_DIGITS = /\d{13,19}/;
const CARD_DIGITS = new RegExp(String.raw`\b(?:${[CARD_IN_GROUPS_OF_FOUR, CARD_OF_THIRTEEN_DIGITS, CARD_LIKE_AMERICAN_EXPRESS, UNBROKEN_DIGITS].map((layout) => layout.source).join("|")})\b`, "g");

function passesLuhn(digits: string): boolean {
  const sum = [...digits].reverse().reduce((total, character, index) => {
    const digit = Number(character);
    return total + (index % 2 === 0 ? digit : digit > 4 ? digit * 2 - 9 : digit * 2);
  }, 0);
  return sum % 10 === 0;
}

function holdsCardNumber(text: string): boolean {
  return (text.match(CARD_DIGITS) ?? []).some((digits) => passesLuhn(digits.replace(/[ -]/g, "")));
}

const SHORTEST_LONG_TOKEN = 32;
const SHORTEST_LONG_VALUE = 16;
const TOKEN_CHARACTERS = String.raw`A-Za-z0-9_+=/.~-`;
const NAME_CHARACTERS = String.raw`A-Za-z0-9_.-`;
const URL_PATH_CHARACTERS = String.raw`A-Za-z0-9._~/-`;
const OPENING_MARK = String.raw`\\?["'\x60(<[{]?`;

const LONGEST_URL_SCHEME = SHORTEST_LONG_TOKEN - 1;
const NO_USER_BEFORE_THE_HOST = String.raw`(?![A-Za-z0-9._~-]*@)`;
const NO_LONG_RUN_FOR_A_HOST = String.raw`(?![A-Za-z0-9_~-]{${SHORTEST_LONG_TOKEN}})`;
const URL_SCHEME_HOST_PORT_AND_PATH = new RegExp(
  String.raw`(?<![A-Za-z0-9_+/.~-])[a-z][a-z0-9+.-]{0,${LONGEST_URL_SCHEME - 1}}:\/\/${NO_USER_BEFORE_THE_HOST}${NO_LONG_RUN_FOR_A_HOST}[A-Za-z0-9._~-]*(?::\d{1,5}(?![A-Za-z0-9_+=.~-]))?(?:\/[${URL_PATH_CHARACTERS}]*)?`,
  "gi",
);
const outsideUrls = (holds: (text: string) => boolean) => (text: string) => holds(text.replace(URL_SCHEME_HOST_PORT_AND_PATH, "url"));

const isDigits = found(/^\d+$/);
const isUuid = found(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const isGitHash = found(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const WORD_IN_ONE_CASE_OR_CAMEL_CASE = /^[a-z]*(?:[A-Z]+[a-z]{2,})*[A-Z]*\d{0,4}$/;

function readsAsWords(token: string, lettersNeeded: number): boolean {
  const segments = token.split(/[^A-Za-z0-9]+/).filter((segment) => segment !== "");
  const isWord = (segment: string) => segment.length < SHORTEST_LONG_TOKEN && WORD_IN_ONE_CASE_OR_CAMEL_CASE.test(segment);
  return segments.every((segment) => isDigits(segment) || isWord(segment)) && segments.filter((segment) => !isDigits(segment)).length >= lettersNeeded;
}

const withoutOuterSeparators = (token: string) => /[A-Za-z0-9](?:.*[A-Za-z0-9])?/.exec(token)?.[0] ?? "";

const ORDINARY_LONG_TOKENS = {
  onlySeparators: (token) => token === "",
  words: (token) => readsAsWords(token, 2),
  uuid: isUuid,
  gitHash: isGitHash,
  digits: isDigits,
} satisfies Record<string, (token: string) => boolean>;

const LONG_RUN = new RegExp(`[${TOKEN_CHARACTERS}]{${SHORTEST_LONG_TOKEN},}`, "g");

function holdsLongToken(text: string): boolean {
  const pieces = (text.match(LONG_RUN) ?? []).flatMap((run) => run.split(/=(?=[^=])/));
  return pieces.some((piece) => {
    const token = withoutOuterSeparators(piece);
    return piece.length >= SHORTEST_LONG_TOKEN && !Object.values(ORDINARY_LONG_TOKENS).some((isOrdinary) => isOrdinary(token));
  });
}

const looksLikeToken = (value: string) => /\d/.test(value) && /[A-Za-z]/.test(value) && !readsAsWords(value, 1);

const NAMES_THAT_HOLD_HASHES = /^(?:commit|hash|sha|sha1|sha256|digest|rev|revision|etag|id|uuid)$/i;
const VALUE_AFTER_EQUALS_OR_COLON = new RegExp(String.raw`[=:](?<=([${NAME_CHARACTERS}]*)\\?["'\x60]?[ \t]*[=:])[ \t]*${OPENING_MARK}([${TOKEN_CHARACTERS}]{${SHORTEST_LONG_VALUE},})`, "g");

function holdsLongValueAfterEqualsOrColon(text: string): boolean {
  return [...text.matchAll(VALUE_AFTER_EQUALS_OR_COLON)].some(([, name = "", value = ""]) => {
    const token = withoutOuterSeparators(value);
    const isHashUnderItsName = NAMES_THAT_HOLD_HASHES.test(name) && (isGitHash(token) || isUuid(token));
    return looksLikeToken(value) && !isHashUnderItsName;
  });
}

const FLAG_AND_VALUE = new RegExp(String.raw`(?<![A-Za-z0-9_-])-([A-Za-z0-9_-]+)[ \t]+${OPENING_MARK}([${TOKEN_CHARACTERS}]{${SHORTEST_LONG_VALUE},})`, "g");
const ENDS_IN_A_SECRET_WORD = new RegExp(String.raw`(?:${SECRET_NAME.source}|pass|key|auth)$`, "i");

function holdsLongValueAfterFlag(text: string): boolean {
  return [...text.matchAll(FLAG_AND_VALUE)].some(([, flag = "", value = ""]) => ENDS_IN_A_SECRET_WORD.test(flag) && looksLikeToken(value));
}

const SECRET_WORD_AND_VALUE = new RegExp(String.raw`(?:bearer|basic|key|${SECRET_NAME.source})\\?["'\x60]?[ \t]+(?:is[ \t]+)?${OPENING_MARK}([${TOKEN_CHARACTERS}]{${SHORTEST_LONG_VALUE},})`, "gi");

function holdsLongValueAfterSecretWord(text: string): boolean {
  return [...text.matchAll(SECRET_WORD_AND_VALUE)].some(([, value = ""]) => looksLikeToken(value));
}

export const SECRET_SHAPES = {
  pemHeader: found(/-----BEGIN [A-Z0-9 ]+-----/),
  openAiStyleKey: found(/\b[sr]k-[A-Za-z0-9_-]{16,}/),
  stripeKey: found(/\b[sr]k_[A-Za-z0-9_-]{16,}/),
  githubToken: found(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_-]{16,}/),
  gitlabToken: found(/\bglpat-[A-Za-z0-9_-]{16,}/),
  slackToken: found(/\bxox[abprs]-[A-Za-z0-9_-]{16,}/),
  huggingFaceToken: found(/\bhf_[A-Za-z0-9_-]{16,}/),
  npmToken: found(/\bnpm_[A-Za-z0-9_-]{16,}/),
  tailscaleKey: found(/\btskey-[A-Za-z0-9_-]{16,}/),
  digitalOceanToken: found(/\bdop_v1_[A-Za-z0-9_-]{16,}/),
  shopifyToken: found(/\bshpat_[A-Za-z0-9_-]{16,}/),
  awsAccessKey: found(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/),
  googleApiKey: found(/\bAIza[0-9A-Za-z_-]{30,}/),
  jwt: found(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/),
  pairWithEquals: found(new RegExp(String.raw`\b${SECRET_NAME.source}\s*=(?!=)\s*\S+|_${SECRET_NAME.source}\s*=(?!=)\s*(?=[^\s=]*\d)(?=[^\s=]*[A-Za-z])\S`, "i")),
  pairWithColon: found(new RegExp(String.raw`\b${SECRET_NAME.source}\s*:\s*\S+[ \t]*$`, "im")),
  urlPassword: found(/\/\/[^\s/:@]+:[^\s/@]+@/),
  urlQuerySecret: found(/[?&#](?:token|key|api_key|apikey|secret|password|access_token|auth|sig|signature)=[^\s&#]{16,}/i),
  slackWebhook: found(/\bhooks\.slack\.com\/services\/[A-Za-z0-9]/i),
  discordWebhook: found(/\bdiscord(?:app)?\.com\/api\/webhooks\/[0-9]/i),
  cardNumber: holdsCardNumber,
  longToken: outsideUrls(holdsLongToken),
  longValueAfterEqualsOrColon: outsideUrls(holdsLongValueAfterEqualsOrColon),
  longValueAfterFlag: outsideUrls(holdsLongValueAfterFlag),
  longValueAfterSecretWord: outsideUrls(holdsLongValueAfterSecretWord),
} satisfies Record<string, (text: string) => boolean>;

export function looksLikeSecret(text: string): boolean {
  return Object.values(SECRET_SHAPES).some((holds) => holds(text));
}

const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]?)\u200D(?=\p{Extended_Pictographic})/u;
const EMOJI_STYLE = /(?<=\p{Extended_Pictographic})\uFE0F/u;
const KEYCAP_STYLE = /(?<=[0-9#*])\uFE0F(?=\u20E3)/u;
const SCRIPTS_THAT_USE_JOINERS = ["Arabic", "Syriac", "Mongolian", "Nko", "Mandaic", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Khmer", "Myanmar"];
const CHARACTER_OF_A_JOINING_SCRIPT = `[${SCRIPTS_THAT_USE_JOINERS.map((script) => String.raw`\p{Script=${script}}`).join("")}]`;
// The joiners are themselves in the Inherited script, so they must not count as the mark that links a joiner to its letter.
const COMBINING_MARK = String.raw`(?:(?![\u200C\u200D])\p{Script=Inherited})`;
const LETTER_JOINER = new RegExp(String.raw`[\u200C\u200D](?:(?<=${CHARACTER_OF_A_JOINING_SCRIPT}${COMBINING_MARK}*[\u200C\u200D])|(?=${CHARACTER_OF_A_JOINING_SCRIPT}))`, "u");

const INVISIBLE_CHARACTERS_REAL_TEXT_NEEDS = new RegExp([EMOJI_JOINER, EMOJI_STYLE, KEYCAP_STYLE, LETTER_JOINER].map((pattern) => pattern.source).join("|"), "gu");

// An emoji newer than this runtime's Unicode tables is unassigned here, and its block is Extended_Pictographic already.
const REFUSED_CHARACTERS: readonly RegExp[] = [/[^\P{Cc}\n\t]/u, /[\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800\u2D7F\u{1D159}]/u, /(?!\p{Extended_Pictographic})\p{Cn}/u];

export type TextProblem = "tooLong" | "characters" | "secret";

export function textProblem(text: string, max: number): TextProblem | null {
  if (text.length > max) {
    return "tooLong";
  }
  const refusable = text.replace(INVISIBLE_CHARACTERS_REAL_TEXT_NEEDS, "");
  if (REFUSED_CHARACTERS.some((characters) => characters.test(refusable))) {
    return "characters";
  }
  return looksLikeSecret(text) ? "secret" : null;
}

type NoteProblem = TextProblem | "empty" | "full";

export const NOTE_PROBLEMS: Record<NoteProblem, { owner: string; bot: string }> = {
  empty: { owner: "A note cannot be empty", bot: "A note cannot be empty, so nothing was saved." },
  tooLong: {
    owner: `A note cannot be longer than ${MAX_NOTE_LENGTH} characters`,
    bot: `A note cannot be longer than ${MAX_NOTE_LENGTH} characters, so nothing was saved. Save a shorter note.`,
  },
  characters: {
    owner: "A note cannot hold invisible or control characters. Pasted text can carry them, so type it again",
    bot: "A note cannot hold invisible or control characters, so nothing was saved. Save it without them.",
  },
  secret: {
    owner: "This looks like a password, key, token, or card number, so it was not saved. For a login, take over the bot's screen",
    bot: "This looks like a password, key, token, or card number, so nothing was saved. Do not try again. For a login, ask your owner to take over and log in.",
  },
  full: {
    owner: `This bot already has ${MAX_NOTES} notes. Delete one first`,
    bot: `You already have ${MAX_NOTES} notes, so nothing was saved. Forget one of your own first, or ask your owner to delete one.`,
  },
};

export function parseNote(args: {
  text: string;
  otherNotes: number;
}): { kind: "ok"; text: string } | { kind: "refused"; problem: NoteProblem } {
  const text = args.text.trim();
  const problem = text === "" ? "empty" : (textProblem(text, MAX_NOTE_LENGTH) ?? (args.otherNotes >= MAX_NOTES ? "full" : null));
  return problem === null ? { kind: "ok", text } : { kind: "refused", problem };
}

const ABOUT_PROBLEMS: Record<TextProblem, string> = {
  tooLong: `About you cannot be longer than ${MAX_ABOUT_LENGTH.toLocaleString("en-US")} characters`,
  characters: "About you cannot hold invisible or control characters. Pasted text can carry them, so type it again",
  secret: "This looks like a password, key, token, or card number, so it was not saved. All of your bots read this text",
};

export function parseAbout(about: string): string | undefined {
  const text = about.trim();
  const problem = textProblem(text, MAX_ABOUT_LENGTH);
  if (problem !== null) {
    throw new ConvexError(ABOUT_PROBLEMS[problem]);
  }
  return text === "" ? undefined : text;
}

export const DESCRIPTION_PROBLEMS: Record<TextProblem, { owner: string; bot: string }> = {
  tooLong: {
    owner: `Description cannot be longer than ${MAX_DESCRIPTION_LENGTH.toLocaleString("en-US")} characters`,
    bot: `Your description cannot be longer than ${MAX_DESCRIPTION_LENGTH.toLocaleString("en-US")} characters, so nothing changed. Write a shorter one.`,
  },
  characters: {
    owner: "Description cannot hold invisible or control characters. Pasted text can carry them, so type it again",
    bot: "Your description cannot hold invisible or control characters, so nothing changed. Write it without them.",
  },
  secret: {
    owner: "This looks like a password, key, token, or card number, so the description was not saved. For a login, take over the bot's screen",
    bot: "This looks like a password, key, token, or card number, so nothing changed. Do not try again. For a login, ask your owner to take over and log in.",
  },
};

export function parseDescription(description: string): { kind: "ok"; text: string | undefined } | { kind: "refused"; problem: TextProblem } {
  const text = description.trim();
  const problem = textProblem(text, MAX_DESCRIPTION_LENGTH);
  if (problem !== null) {
    return { kind: "refused", problem };
  }
  return { kind: "ok", text: text === "" ? undefined : text };
}

function descriptionChangeRecord(previous: string | undefined, next: string | undefined): string {
  return ["Updated your description.", "[Previous description]", previous ?? "", "[End of previous description]", "[New description]", next ?? "", "[End of new description]"].join("\n");
}

export async function notesOf(ctx: QueryCtx, botId: Id<"bots">): Promise<Doc<"memories">[]> {
  return await ctx.db
    .query("memories")
    .withIndex("by_bot", (q) => q.eq("botId", botId))
    .collect();
}

const WHAT_A_CALL_CHANGES: Record<MemoryCall["kind"], { tool: string; subject: string }> = {
  memorySave: { tool: "memory_save", subject: "your notes" },
  memoryForget: { tool: "memory_forget", subject: "your notes" },
  descriptionSet: { tool: "description_set", subject: "your description" },
};

export async function applyMemoryCall(
  ctx: MutationCtx,
  run: Doc<"runs">,
  call: MemoryCall,
): Promise<Extract<RunEventBody, { kind: "toolResult" }>> {
  const { tool, subject } = WHAT_A_CALL_CHANGES[call.kind];
  const result = (outcome: "ok" | "error" | "cancelled" | "rejected", output: string) => ({
    kind: "toolResult" as const,
    toolCallId: call.toolCallId,
    name: tool,
    outcome,
    output,
    truncated: false,
  });
  if (run.capability !== "full") {
    return result("rejected", `This run is read-only, so it cannot change ${subject}, and this call did not run.`);
  }
  // The runner hears of a stop only at its next heartbeat, so only this transaction can honor one made just now.
  if (run.cancelRequested) {
    return result("cancelled", `The run was cancelled before this call changed ${subject}, so it did not run.`);
  }
  switch (call.kind) {
    case "memorySave": {
      const parsed = parseNote({ text: call.text, otherNotes: (await notesOf(ctx, run.botId)).length });
      if (parsed.kind === "refused") {
        return result("error", NOTE_PROBLEMS[parsed.problem].bot);
      }
      const noteId = await ctx.db.insert("memories", {
        botId: run.botId,
        text: parsed.text,
        source: { kind: "bot", runId: run._id },
      });
      return result("ok", `Saved note ${noteId}. Its text is: ${parsed.text}`);
    }
    case "memoryForget": {
      const noteId = ctx.db.normalizeId("memories", call.noteId);
      const note = noteId === null ? null : await ctx.db.get(noteId);
      if (note === null || note.botId !== run.botId) {
        return result("error", "You have no note with that id. Your system prompt lists your notes.");
      }
      if (note.source.kind === "owner") {
        return result("error", `Note ${note._id} is your owner's, so you cannot forget it. Your owner can edit it in your info panel.`);
      }
      await ctx.db.delete(note._id);
      return result("ok", `Forgot note ${note._id}. Its text was: ${note.text}`);
    }
    case "descriptionSet": {
      const parsed = parseDescription(call.text);
      if (parsed.kind === "refused") {
        return result("error", DESCRIPTION_PROBLEMS[parsed.problem].bot);
      }
      const previous = (await ctx.db.get(run.botId))?.description;
      await ctx.db.patch(run.botId, { description: parsed.text });
      return result("ok", descriptionChangeRecord(previous, parsed.text));
    }
  }
}

export function promptNotes(notes: readonly Doc<"memories">[]) {
  return notes.map((note) => ({
    id: note._id,
    by: note.source.kind === "owner" ? ("owner" as const) : ("you" as const),
    date: new Date(note._creationTime).toISOString().slice(0, 10),
    text: note.text,
  }));
}

export const list = query({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const { user } = await requireIdentity(ctx);
    const bot = await ctx.db.get(botId);
    if (user === null || bot === null || bot.ownerId !== user._id) {
      return null;
    }
    const notes = await notesOf(ctx, botId);
    return {
      limit: MAX_NOTES,
      notes: notes.toReversed().map((note) => ({
        _id: note._id,
        text: note.text,
        by: note.source.kind,
        createdAt: note._creationTime,
      })),
    };
  },
});

export const write = mutation({
  args: { botId: v.id("bots"), text: v.string(), replaces: v.optional(v.id("memories")) },
  handler: async (ctx, { botId, text, replaces }) => {
    await requireOwnedBot(ctx, botId);
    const notes = await notesOf(ctx, botId);
    if (replaces !== undefined && !notes.some((note) => note._id === replaces)) {
      throw new ConvexError("This note is gone. The bot may have forgotten it");
    }
    const parsed = parseNote({ text, otherNotes: notes.length - (replaces === undefined ? 0 : 1) });
    if (parsed.kind === "refused") {
      throw new ConvexError(NOTE_PROBLEMS[parsed.problem].owner);
    }
    if (replaces !== undefined) {
      await ctx.db.delete(replaces);
    }
    return await ctx.db.insert("memories", { botId, text: parsed.text, source: { kind: "owner" } });
  },
});

export const remove = mutation({
  args: { noteId: v.id("memories") },
  handler: async (ctx, { noteId }) => {
    const { user } = await requireIdentity(ctx);
    const note = await ctx.db.get(noteId);
    const bot = note === null ? null : await ctx.db.get(note.botId);
    if (user === null || bot === null || bot.ownerId !== user._id) {
      throw new ConvexError("Note not found");
    }
    await ctx.db.delete(noteId);
  },
});
