import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { nextFireAfter, FALLBACK_ZONE } from "./scheduleTime.js";
import { closeUnansweredCalls, endRun } from "./runEnd.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { requireIdentity, requireService, upsertUser } from "./identity.js";

// Slot n is VM 200 + n at 10.77.0.(20 + n), so 200 slots stay inside the user network.
// A VM holds at most 8 desktops, so a stop of each fits one call of the script, however many bots it names.
const MAX_REMOVED_BOTS_PER_PASS = 64;
const MAX_SLOT = 200;
// Longer than the activate step, which swaps a symlink and restarts one service.
const UPDATE_FENCE_MS = 60 * 1000;

export const register = mutation({
  args: {
    ownerSubject: v.string(),
    email: v.string(),
    displayName: v.string(),
    tokenHash: v.string(),
  },
  handler: async (ctx, { ownerSubject, email, displayName, tokenHash }) => {
    await requireService(ctx);
    const ownerId = await upsertUser(ctx, { authSubject: ownerSubject, email, displayName });
    const holder = await ctx.db
      .query("computers")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (holder !== null && holder.ownerId !== ownerId) {
      throw new ConvexError("This computer token belongs to another owner");
    }
    const existing = await ctx.db
      .query("computers")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (existing === null) {
      const computerId = await ctx.db.insert("computers", { ownerId, tokenHash });
      return { ownerId, computerId };
    }
    if (existing.desiredVm !== undefined) throw new ConvexError("Provisioned computer tokens belong to the reconciler");
    if (existing.tokenHash !== tokenHash) {
      await ctx.db.patch(existing._id, { tokenHash });
    }
    return { ownerId, computerId: existing._id };
  },
});

export const byTokenHash = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    await requireService(ctx);
    const computer = await ctx.db
      .query("computers")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    return computer === null ? null : { computerId: computer._id, ownerId: computer.ownerId, generation: computer.desiredVm?.generation ?? 0 };
  },
});

export const declareVm = mutation({
  args: {
    ownerSubject: v.string(),
    email: v.string(),
    displayName: v.string(),
    cores: v.number(),
    memoryMb: v.number(),
    diskGb: v.number(),
  },
  handler: async (ctx, { ownerSubject, email, displayName, cores, memoryMb, diskGb }) => {
    await requireService(ctx);
    for (const [name, value] of Object.entries({ cores, memoryMb, diskGb })) {
      if (!Number.isInteger(value) || value < 1) {
        throw new ConvexError(`${name} must be a positive integer`);
      }
    }
    const ownerId = await upsertUser(ctx, { authSubject: ownerSubject, email, displayName });
    const existing = await ctx.db
      .query("computers")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (existing?.reset !== undefined) throw new ConvexError("This computer is resetting");
    if (existing?.desiredVm?.removing === true) {
      throw new ConvexError("This computer is being removed");
    }
    let slot = existing?.desiredVm?.slot;
    if (slot === undefined) {
      const computers = await ctx.db.query("computers").collect();
      const taken = new Set(computers.map((computer) => computer.desiredVm?.slot));
      slot = 1;
      while (taken.has(slot)) {
        slot += 1;
      }
      if (slot > MAX_SLOT) {
        throw new ConvexError("Every VM slot is taken");
      }
    }
    const desiredVm = { slot, cores, memoryMb, diskGb, removing: false, generation: existing?.desiredVm?.generation ?? 0 };
    if (existing === null) {
      const computerId = await ctx.db.insert("computers", { ownerId, desiredVm });
      return { computerId, slot };
    }
    await ctx.db.patch(existing._id, { desiredVm });
    return { computerId: existing._id, slot };
  },
});

// Removing the hash makes the link refuse a new connection at once. The reconcile loop closes a live one on its next pass.
export const removeVm = mutation({
  args: { ownerSubject: v.string() },
  handler: async (ctx, { ownerSubject }) => {
    await requireService(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_auth_subject", (q) => q.eq("authSubject", ownerSubject))
      .unique();
    if (user === null) {
      throw new ConvexError("No such user");
    }
    const computer = await ctx.db
      .query("computers")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .unique();
    if (computer?.desiredVm === undefined) {
      throw new ConvexError("This user has no provisioned computer");
    }
    if (computer.reset !== undefined) throw new ConvexError("This computer is resetting");
    await ctx.db.patch(computer._id, { tokenHash: undefined, desiredVm: { ...computer.desiredVm, removing: true } });
  },
});

export const desiredVms = query({
  args: {},
  handler: async (ctx) => {
    await requireService(ctx);
    const computers = await ctx.db.query("computers").collect();
    // Run state is durable, so this holds right after a restart, before the runner has picked its runs back up.
    const owners = new Set<string>();
    for (const kind of ["queued", "running"] as const) {
      for await (const run of ctx.db.query("runs").withIndex("by_state", (q) => q.eq("state.kind", kind))) {
        owners.add(run.ownerId);
      }
    }
    const withVms = computers.flatMap(({ _id, ownerId, tokenHash, desiredVm, observedVm, computerdCommit }) =>
      desiredVm === undefined
        ? []
        : [{ computerId: _id, ownerId, tokenHash, desiredVm, observedVm, computerdCommit, hasActiveRun: owners.has(ownerId) }],
    );
    return await Promise.all(
      withVms.map(async (computer) => ({
        ...computer,
        removedBots: (
          await ctx.db
            .query("removedBots")
            .withIndex("by_owner", (q) => q.eq("ownerId", computer.ownerId))
            .take(MAX_REMOVED_BOTS_PER_PASS)
        ).map(({ botId }) => botId),
      })),
    );
  },
});

export const recordObservedVm = mutation({
  args: { computerId: v.id("computers"), generation: v.number(), stage: v.string(), detail: v.optional(v.string()) },
  handler: async (ctx, { computerId, generation, stage, detail }) => {
    await requireService(ctx);
    await requireGeneration(ctx, computerId, generation);
    await ctx.db.patch(computerId, { observedVm: { stage, detail, at: Date.now() } });
  },
});

export const recordVmToken = mutation({
  args: { computerId: v.id("computers"), generation: v.number(), tokenHash: v.string() },
  handler: async (ctx, { computerId, generation, tokenHash }) => {
    await requireService(ctx);
    const computer = await requireGeneration(ctx, computerId, generation);
    if (computer.desiredVm?.removing === true) {
      throw new ConvexError("This computer is being removed");
    }
    const holder = await ctx.db
      .query("computers")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (holder !== null && holder._id !== computerId) {
      throw new ConvexError("This computer token belongs to another computer");
    }
    await ctx.db.patch(computerId, { tokenHash });
  },
});

// Convex runs a mutation atomically, so this and runs.claim cannot both win. An orchestrator that dies here leaves a fence
// that expires, so a crash delays a user's run and cannot strand it.
export const fenceForUpdate = mutation({
  args: { computerId: v.id("computers"), generation: v.number() },
  handler: async (ctx, { computerId, generation }) => {
    await requireService(ctx);
    const computer = await requireGeneration(ctx, computerId, generation);
    for (const kind of ["queued", "running"] as const) {
      const active = await ctx.db
        .query("runs")
        .withIndex("by_state", (q) => q.eq("state.kind", kind))
        .filter((q) => q.eq(q.field("ownerId"), computer.ownerId))
        .first();
      if (active !== null) {
        return { fenced: false };
      }
    }
    await ctx.db.patch(computerId, { updateFenceUntil: Date.now() + UPDATE_FENCE_MS });
    return { fenced: true };
  },
});

export const releaseUpdateFence = mutation({
  args: { computerId: v.id("computers"), generation: v.number() },
  handler: async (ctx, { computerId, generation }) => {
    await requireService(ctx);
    await requireGeneration(ctx, computerId, generation);
    await ctx.db.patch(computerId, { updateFenceUntil: undefined });
  },
});

export const recordComputerdCommit = mutation({
  args: { computerId: v.id("computers"), generation: v.number(), commit: v.string() },
  handler: async (ctx, { computerId, generation, commit }) => {
    await requireService(ctx);
    await requireGeneration(ctx, computerId, generation);
    await ctx.db.patch(computerId, { computerdCommit: commit });
  },
});

export const forgetVm = mutation({
  args: { computerId: v.id("computers"), generation: v.number() },
  handler: async (ctx, { computerId, generation }) => {
    await requireService(ctx);
    const computer = await requireGeneration(ctx, computerId, generation);
    if (computer?.desiredVm?.removing !== true) {
      throw new ConvexError("Only a computer being removed can be forgotten");
    }
    await ctx.db.delete(computerId);
  },
});

export async function computerOfOwner(ctx: QueryCtx, ownerId: Id<"users">) {
  return await ctx.db.query("computers").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).unique();
}

export async function requireComputerAvailable(ctx: QueryCtx, ownerId: Id<"users">) {
  const computer = await computerOfOwner(ctx, ownerId);
  if (computer?.reset !== undefined || computer?.desiredVm?.removing === true) throw new ConvexError("The computer is resetting or being removed. Try again when it connects.");
  return computer;
}

async function requireGeneration(ctx: QueryCtx, computerId: Id<"computers">, generation: number): Promise<Doc<"computers">> {
  const computer = await ctx.db.get(computerId);
  if (computer === null || (computer.desiredVm?.generation ?? 0) !== generation) throw new ConvexError("Stale computer generation");
  return computer;
}

export const checkGeneration = query({
  args: { computerId: v.id("computers"), generation: v.number(), removing: v.boolean() },
  handler: async (ctx, { computerId, generation, removing }) => {
    await requireService(ctx);
    const computer = await requireGeneration(ctx, computerId, generation);
    if (computer.desiredVm?.removing !== removing) throw new ConvexError("Stale removal state");
  },
});

export const completeReset = mutation({
  args: { computerId: v.id("computers"), generation: v.number() },
  handler: async (ctx, { computerId, generation }) => {
    await requireService(ctx);
    const computer = await requireGeneration(ctx, computerId, generation);
    if (computer?.reset !== undefined) {
      const now = Date.now();
      const zone = (await ctx.db.get(computer.ownerId))?.timeZone ?? FALLBACK_ZONE;
      for await (const routine of ctx.db.query("schedules").withIndex("by_owner", (q) => q.eq("ownerId", computer.ownerId))) {
        if (routine.nextFireAt !== undefined && routine.nextFireAt <= now) await ctx.db.patch(routine._id, { nextFireAt: nextFireAfter(routine.cadence, zone, now), lastMissed: { at: routine.nextFireAt, reason: "The computer was resetting" } });
      }
    }
    await ctx.db.patch(computerId, { reset: undefined });
  },
});

export const current = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireIdentity(ctx);
    const computer = user === null ? null : await computerOfOwner(ctx, user._id);
    if (computer?.desiredVm === undefined || computer.desiredVm.removing) return { kind: "unavailable" as const };
    if (computer.reset !== undefined) return { kind: "resetting" as const, requestedAt: computer.reset.requestedAt, stage: computer.observedVm?.stage ?? "Reset requested", detail: computer.observedVm?.detail };
    return { kind: "available" as const };
  },
});

export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireIdentity(ctx);
    const computer = user === null ? null : await computerOfOwner(ctx, user._id);
    if (computer?.desiredVm === undefined || computer.desiredVm.removing) throw new ConvexError("Reset requires a provisioned VM. Local Docker computers cannot be reset here.");
    if (computer.reset !== undefined) return;
    const generation = (computer.desiredVm.generation ?? 0) + 1;
    await ctx.db.patch(computer._id, {
      desiredVm: { ...computer.desiredVm, generation }, reset: { generation, requestedAt: Date.now() },
      tokenHash: undefined, observedVm: undefined, computerdCommit: undefined, updateFenceUntil: undefined,
    });
    for (const kind of ["queued", "running"] as const) {
      for await (const run of ctx.db.query("runs").withIndex("by_state", (q) => q.eq("state.kind", kind)).filter((q) => q.eq(q.field("ownerId"), computer.ownerId))) {
        await closeUnansweredCalls(ctx, run);
        await endRun(ctx, run._id, { kind: "failed", reason: "The owner reset the shared computer" });
      }
    }
    for await (const approval of ctx.db.query("approvals").withIndex("by_owner_state", (q) => q.eq("ownerId", computer.ownerId).eq("state", "pending"))) await ctx.db.patch(approval._id, { state: "expired" });
    for await (const bot of ctx.db.query("bots").withIndex("by_owner", (q) => q.eq("ownerId", computer.ownerId))) await ctx.db.patch(bot._id, { takeoverUntil: undefined });
  },
});
