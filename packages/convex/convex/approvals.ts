import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireService } from "./identity.js";
import { computerOfOwner, requireComputerAvailable } from "./computers.js";
import { eligibleShell, matchingCommand, MAX_SAVED_COMMANDS, sameScope } from "./commandPermissions.js";
import { screenBox } from "./validators.js";

// Long enough for a person who is asleep. After this the bot gets a refusal and can tell the user what it wanted.
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// A restarted runner asks again with the same call, and it must find the same row and the same answer.
export const request = mutation({
  args: { runId: v.id("runs"), toolCallId: v.string(), toolName: v.string(), leaseToken: v.optional(v.string()), pageAim: v.optional(v.string()), subject: v.optional(v.string()), box: v.optional(screenBox), reason: v.optional(v.string()) },
  handler: async (ctx, { runId, toolCallId, toolName, leaseToken, pageAim, subject, box, reason }) => {
    await requireService(ctx);
    const run = await ctx.db.get(runId);
    if (run === null || (run.state.kind !== "queued" && run.state.kind !== "running")) {
      throw new ConvexError("No such run");
    }
    await requireComputerAvailable(ctx, run.ownerId);
    if (run.capability !== "full") {
      throw new ConvexError("A read-only run cannot ask for approval");
    }
    const existing = await ctx.db
      .query("approvals")
      .withIndex("by_run_call", (q) => q.eq("runId", runId).eq("toolCallId", toolCallId))
      .unique();
    if (existing !== null) {
      return { approvalId: existing._id, state: existing.state, expiresAt: existing.requestedAt + APPROVAL_TTL_MS, pageAim: existing.pageAim ?? null };
    }
    if (pageAim !== undefined && (pageAim.length > 8192 || run.state.kind !== "running" || run.state.leaseToken !== leaseToken || run.state.leaseUntil < Date.now())) {
      throw new ConvexError("A page approval needs the current run lease and a bounded aim");
    }
    const eligible = toolName === "shell" && run.state.kind === "running" && run.state.leaseToken === leaseToken ? await eligibleShell(ctx, run, toolCallId) : null;
    const requestedAt = Date.now();
    const approvalId = await ctx.db.insert("approvals", {
      ownerId: run.ownerId,
      botId: run.botId,
      threadId: run.threadId,
      runId,
      toolCallId,
      toolName,
      state: "pending",
      requestedAt,
      ...(eligible === null ? {} : { shellSubject: eligible.subject }),
      ...(pageAim === undefined ? {} : { pageAim }),
      ...(subject === undefined || toolName === "shell" ? {} : { subject }),
      ...(box === undefined ? {} : { box }),
      ...(reason === undefined ? {} : { reason }),
    });
    return { approvalId, state: "pending" as const, expiresAt: requestedAt + APPROVAL_TTL_MS, pageAim: pageAim ?? null };
  },
});

export const forCall = query({
  args: { runId: v.id("runs"), toolCallId: v.string() },
  handler: async (ctx, { runId, toolCallId }) => {
    await requireService(ctx);
    const row = await ctx.db.query("approvals").withIndex("by_run_call", (q) => q.eq("runId", runId).eq("toolCallId", toolCallId)).unique();
    if (row === null) return null;
    const reset = (await computerOfOwner(ctx, row.ownerId))?.reset !== undefined;
    return { approvalId: row._id, state: reset ? "expired" as const : row.state, expiresAt: row.requestedAt + APPROVAL_TTL_MS, pageAim: row.pageAim ?? null };
  },
});

export const stateOf = query({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, { approvalId }) => {
    await requireService(ctx);
    // A request that has vanished cannot have been approved.
    const approval = await ctx.db.get(approvalId);
    if (approval === null) return "denied";
    if ((await computerOfOwner(ctx, approval.ownerId))?.reset !== undefined) return "expired";
    return approval.state;
  },
});

export const decide = mutation({
  args: { approvalId: v.id("approvals"), decision: v.union(v.literal("approved"), v.literal("denied")) },
  handler: async (ctx, { approvalId, decision }) => {
    const { user } = await requireIdentity(ctx);
    const approval = await ctx.db.get(approvalId);
    if (user === null || approval === null || approval.ownerId !== user._id) {
      throw new ConvexError("Approval not found");
    }
    await requireComputerAvailable(ctx, approval.ownerId);
    // The first answer stands, so a second device cannot turn a refusal into a run.
    if (approval.state !== "pending") {
      throw new ConvexError("This call has already been answered");
    }
    await ctx.db.patch(approvalId, { state: decision });
  },
});

export const expire = mutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, { approvalId }) => {
    await requireService(ctx);
    const approval = await ctx.db.get(approvalId);
    if (approval?.state === "pending") {
      await ctx.db.patch(approvalId, { state: "expired" });
    }
  },
});

async function pendingOnActiveRuns<T extends { runId: Id<"runs"> }>(ctx: QueryCtx, approvals: T[]): Promise<T[]> {
  const live: T[] = [];
  for (const approval of approvals) {
    const run = await ctx.db.get(approval.runId);
    if (run?.state.kind === "running" || run?.state.kind === "queued") {
      live.push(approval);
    }
  }
  return live;
}

export const pendingForThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const { user } = await requireIdentity(ctx);
    const thread = await ctx.db.get(threadId);
    if (user === null || thread === null) {
      return [];
    }
    const rows = await ctx.db
      .query("approvals")
      .withIndex("by_thread_state", (q) => q.eq("threadId", threadId).eq("state", "pending"))
      .collect();
    const mine = rows.filter((row) => row.ownerId === user._id);
    const bot = await ctx.db.get(thread.botId);
    return (await pendingOnActiveRuns(ctx, mine)).map(({ _id, runId, toolCallId, subject, reason, shellSubject }) => ({
      _id, runId, toolCallId, subject: subject ?? null, reason: reason ?? null,
      commandPermission: shellSubject === undefined ? null : { ...shellSubject, botName: bot?.name ?? "Deleted bot" },
    }));
  },
});

export const pendingBots = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireIdentity(ctx);
    if (user === null) {
      return [];
    }
    const rows = await ctx.db
      .query("approvals")
      .withIndex("by_owner_state", (q) => q.eq("ownerId", user._id).eq("state", "pending"))
      .collect();
    return [...new Set((await pendingOnActiveRuns(ctx, rows)).map((row) => row.botId))];
  },
});

export const saveCommand = mutation({
  args: { approvalId: v.id("approvals") },
  handler: async (ctx, { approvalId }) => {
    const { user } = await requireIdentity(ctx);
    const approval = await ctx.db.get(approvalId);
    if (user === null || approval === null || approval.ownerId !== user._id) throw new ConvexError("Approval not found");
    if (approval.state === "approved" && approval.savedEntryId !== undefined) return;
    if (approval.state !== "pending") throw new ConvexError("This call has already been answered");
    if (approval.requestedAt + APPROVAL_TTL_MS <= Date.now()) throw new ConvexError("This approval has expired");
    const run = await ctx.db.get(approval.runId);
    const eligible = run === null ? null : await eligibleShell(ctx, run, approval.toolCallId);
    const original = approval.shellSubject;
    if (eligible === null || original === undefined || original.eventId !== eligible.subject.eventId || original.arguments !== eligible.subject.arguments || original.command !== eligible.subject.command || !sameScope(original.scope, eligible.subject.scope)) throw new ConvexError("This command can no longer be saved. Request it again at Automatic.");
    const { bot, subject } = eligible;
    const saved = bot.savedCommands;
    const entries = saved !== undefined && sameScope(saved.scope, subject.scope) ? saved.entries : [];
    let entry = entries.find(entry => entry.command === subject.command);
    if (entry === undefined) {
      if (entries.length >= MAX_SAVED_COMMANDS) throw new ConvexError(`This bot has ${MAX_SAVED_COMMANDS} saved commands. Revoke one in Approvals before saving another.`);
      entry = { id: crypto.randomUUID(), command: subject.command, createdAt: Date.now() };
      await ctx.db.patch(bot._id, { savedCommands: { scope: subject.scope, entries: [...entries, entry] } });
    }
    await ctx.db.patch(approvalId, { state: "approved", savedEntryId: entry.id });
  },
});

export const commandForCall = query({
  args: { runId: v.id("runs"), toolCallId: v.string(), leaseToken: v.string() },
  handler: async (ctx, args) => {
    await requireService(ctx);
    return (await matchingCommand(ctx, args))?.entry.id ?? null;
  },
});

export const authorizeCommand = mutation({
  args: { runId: v.id("runs"), toolCallId: v.string(), leaseToken: v.string(), entryId: v.string(), computerId: v.id("computers"), generation: v.number() },
  handler: async (ctx, args) => {
    await requireService(ctx);
    const match = await matchingCommand(ctx, args);
    if (match === null || match.entry.id !== args.entryId || match.subject.scope.computerId !== args.computerId || match.subject.scope.generation !== args.generation || (match.bot.takeoverUntil ?? 0) > Date.now()) return false;
    await ctx.db.patch(args.runId, { lastCommandAdmission: args.toolCallId });
    return true;
  },
});

export const wasCommandAdmitted = query({
  args: { runId: v.id("runs"), toolCallId: v.string(), leaseToken: v.string() },
  handler: async (ctx, { runId, toolCallId, leaseToken }) => {
    await requireService(ctx);
    const run = await ctx.db.get(runId);
    if (run?.state.kind !== "running" || run.state.leaseToken !== leaseToken || run.state.leaseUntil <= Date.now()) throw new ConvexError("Lease lost");
    return run.lastCommandAdmission === toolCallId;
  },
});

export const savedCommands = query({
  args: { botId: v.id("bots") },
  handler: async (ctx, { botId }) => {
    const { user } = await requireIdentity(ctx);
    const bot = await ctx.db.get(botId);
    if (user === null || bot === null || bot.ownerId !== user._id) return null;
    const saved = bot.savedCommands;
    if (saved === undefined) return null;
    const computer = await computerOfOwner(ctx, user._id);
    const active = (bot.approvalLevel ?? "automatic") === "automatic" && computer?._id === saved.scope.computerId && (computer?.desiredVm?.generation ?? 0) === saved.scope.generation && computer?.reset === undefined && computer?.desiredVm?.removing !== true;
    return { ...saved, active };
  },
});

export const revokeCommand = mutation({
  args: { botId: v.id("bots"), entryId: v.string() },
  handler: async (ctx, { botId, entryId }) => {
    const { user } = await requireIdentity(ctx);
    const bot = await ctx.db.get(botId);
    if (user === null || bot === null || bot.ownerId !== user._id) throw new ConvexError("Bot not found");
    if (bot.savedCommands !== undefined) await ctx.db.patch(botId, { savedCommands: { ...bot.savedCommands, entries: bot.savedCommands.entries.filter(entry => entry.id !== entryId) } });
  },
});
