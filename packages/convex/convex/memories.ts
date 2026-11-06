import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireOwnedBot } from "./identity.js";
import type { MemoryCall, RunEventBody } from "./validators.js";

const MAX_NOTES = 40;
const MAX_NOTE_LENGTH = 500;
const MAX_ABOUT_LENGTH = 2000;

const TOKEN_RUN_WITHOUT_SLASH_OR_DOT = /[A-Za-z0-9_+=-]{32,}/;

const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----/,
  /\b(?:sk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|hf|npm|tskey|dop_v1|shpat)[-_][A-Za-z0-9_-]{16,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /\b(?:password|passwd|passphrase|passcode|pwd|secret|token|api[ _-]?key|access[ _-]?key|private[ _-]?key)\s*[:=]\s*\S+/i,
  /\/\/[^\s/:@]+:[^\s/@]+@/,
  /\b\d{13,19}\b|\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}\b|\b\d{4}[ -]\d{6}[ -]\d{4,5}\b/,
  TOKEN_RUN_WITHOUT_SLASH_OR_DOT,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(text));
}

const REFUSED_CHARACTERS: readonly RegExp[] = [
  /[^\P{Cc}\n\t]/u,
  /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/,
  /[\u2028\u2029]/,
];

type TextProblem = "tooLong" | "characters" | "secret";

function textProblem(text: string, max: number): TextProblem | null {
  if (text.length > max) {
    return "tooLong";
  }
  if (REFUSED_CHARACTERS.some((characters) => characters.test(text))) {
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

const TOOL_OF_CALL: Record<MemoryCall["kind"], string> = { memorySave: "memory_save", memoryForget: "memory_forget" };

export async function applyMemoryCall(
  ctx: MutationCtx,
  run: Doc<"runs">,
  call: MemoryCall,
): Promise<Extract<RunEventBody, { kind: "toolResult" }>> {
  const result = (outcome: "ok" | "error" | "cancelled", output: string) => ({
    kind: "toolResult" as const,
    toolCallId: call.toolCallId,
    name: TOOL_OF_CALL[call.kind],
    outcome,
    output,
    truncated: false,
  });
  // The runner hears of a stop only at its next heartbeat, so only this transaction can honor one made just now.
  if (run.cancelRequested) {
    return result("cancelled", "The run was cancelled before this call changed your notes, so it did not run.");
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
