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

const SHORTEST_MIXED_CASE_KEY = 32;
const LONGEST_URL_SCHEME = SHORTEST_MIXED_CASE_KEY - 1;
const URL_UP_TO_ITS_QUERY = new RegExp(String.raw`\b[a-z][a-z0-9+.-]{0,${LONGEST_URL_SCHEME - 1}}:\/\/[^\s?#]*`, "gi");
const LONG_RUN_OF_LETTERS_AND_DIGITS = new RegExp(`[A-Za-z0-9]{${SHORTEST_MIXED_CASE_KEY},}`, "g");

function holdsMixedCaseKey(text: string): boolean {
  const runs = text.replace(URL_UP_TO_ITS_QUERY, " ").match(LONG_RUN_OF_LETTERS_AND_DIGITS) ?? [];
  return runs.some((run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run));
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
  pairWithEquals: found(new RegExp(String.raw`\b${SECRET_NAME.source}\s*=\s*\S+`, "i")),
  pairWithColon: found(new RegExp(String.raw`\b${SECRET_NAME.source}\s*:\s*\S+[ \t]*$`, "im")),
  urlPassword: found(/\/\/[^\s/:@]+:[^\s/@]+@/),
  urlQuerySecret: found(/[?&#](?:token|key|api_key|apikey|secret|password|access_token|auth|sig|signature)=[^\s&#]{16,}/i),
  slackWebhook: found(/\bhooks\.slack\.com\/services\/[A-Za-z0-9]/i),
  discordWebhook: found(/\bdiscord(?:app)?\.com\/api\/webhooks\/[0-9]/i),
  cardNumber: holdsCardNumber,
  mixedCaseKey: holdsMixedCaseKey,
} satisfies Record<string, (text: string) => boolean>;

export function looksLikeSecret(text: string): boolean {
  return Object.values(SECRET_SHAPES).some((holds) => holds(text));
}

const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]?)\u200D(?=\p{Extended_Pictographic})/u;
const EMOJI_STYLE = /(?<=\p{Extended_Pictographic})\uFE0F/u;
const KEYCAP_STYLE = /(?<=[0-9#*])\uFE0F(?=\u20E3)/u;
const LETTER_JOINER = /(?<=\p{L})[\u200C\u200D]|[\u200C\u200D](?=\p{L})/u;
const JOINER_AFTER_A_MARK = /(?<=\p{M})[\u200C\u200D]/u;

const INVISIBLE_CHARACTERS_REAL_TEXT_NEEDS = new RegExp([EMOJI_JOINER, EMOJI_STYLE, KEYCAP_STYLE, LETTER_JOINER, JOINER_AFTER_A_MARK].map((pattern) => pattern.source).join("|"), "gu");

const REFUSED_CHARACTERS: readonly RegExp[] = [/[^\P{Cc}\n\t]/u, /[\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800]/u];

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
