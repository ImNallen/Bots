import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireOwnedBot } from "./identity.js";

const MAX_NOTES = 40;
const MAX_NOTE_LENGTH = 500;
const MAX_ABOUT_LENGTH = 2000;

// These catch careless saves. "My password is hunter2" passes, so the tool description and the prompt also carry the rule.
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----/,
  /\b(?:sk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|hf|npm|tskey|dop_v1|shpat)[-_][A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /\b(?:password|passwd|passphrase|passcode|pwd|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key)\s*[:=]\s*\S+/i,
  /\/\/[^\s/:@]+:[^\s/@]+@/,
  /\b\d{13,19}\b|\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}\b|\b\d{4}[ -]\d{6}[ -]\d{4,5}\b/,
  // A slash and a dot are left out, so a URL or a path stays allowed. A token in a URL's query still matches.
  /[A-Za-z0-9_+=-]{32,}/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

// A line break and a tab are ordinary text, and the prompt's JSON escapes them. Direction controls can make text read differently
// from what it says, in the panel and on a question card.
const BAD_CHARACTERS = /[^\P{Cc}\n\t]|[\u061C\u200E\u200F\u202A-\u202E\u2028\u2029\u2066-\u2069]/u;

type TextProblem = "tooLong" | "characters" | "secret";

// The length comes first, so the patterns above only ever see short text.
function textProblem(text: string, max: number): TextProblem | null {
  if (text.length > max) {
    return "tooLong";
  }
  if (BAD_CHARACTERS.test(text)) {
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
    owner: "A note cannot hold control characters or characters that change the text's direction",
    bot: "A note cannot hold control characters or characters that change the text's direction, so nothing was saved. Save it without them.",
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
  characters: "About you cannot hold control characters or characters that change the text's direction",
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

export async function notesOf(ctx: QueryCtx, botId: Id<"bots">): Promise<Doc<"memories">[]> {
  return await ctx.db
    .query("memories")
    .withIndex("by_bot", (q) => q.eq("botId", botId))
    .collect();
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
