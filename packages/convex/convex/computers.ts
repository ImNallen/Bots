import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireService, upsertUser } from "./identity.js";

// Slot n is VM 200 + n at 10.77.0.(20 + n), so 200 slots stay inside the user network.
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
    return computer === null ? null : { computerId: computer._id, ownerId: computer.ownerId };
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
    const desiredVm = { slot, cores, memoryMb, diskGb, removing: false };
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
    return computers.flatMap(({ _id, ownerId, tokenHash, desiredVm, observedVm, computerdCommit }) =>
      desiredVm === undefined
        ? []
        : [{ computerId: _id, ownerId, tokenHash, desiredVm, observedVm, computerdCommit, hasActiveRun: owners.has(ownerId) }],
    );
  },
});

export const recordObservedVm = mutation({
  args: { computerId: v.id("computers"), stage: v.string(), detail: v.optional(v.string()) },
  handler: async (ctx, { computerId, stage, detail }) => {
    await requireService(ctx);
    await ctx.db.patch(computerId, { observedVm: { stage, detail, at: Date.now() } });
  },
});

export const recordVmToken = mutation({
  args: { computerId: v.id("computers"), tokenHash: v.string() },
  handler: async (ctx, { computerId, tokenHash }) => {
    await requireService(ctx);
    const computer = await ctx.db.get(computerId);
    if (computer === null) {
      throw new ConvexError("No such computer");
    }
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
  args: { computerId: v.id("computers") },
  handler: async (ctx, { computerId }) => {
    await requireService(ctx);
    const computer = await ctx.db.get(computerId);
    if (computer === null) {
      throw new ConvexError("No such computer");
    }
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
  args: { computerId: v.id("computers") },
  handler: async (ctx, { computerId }) => {
    await requireService(ctx);
    await ctx.db.patch(computerId, { updateFenceUntil: undefined });
  },
});

export const recordComputerdCommit = mutation({
  args: { computerId: v.id("computers"), commit: v.string() },
  handler: async (ctx, { computerId, commit }) => {
    await requireService(ctx);
    await ctx.db.patch(computerId, { computerdCommit: commit });
  },
});

export const forgetVm = mutation({
  args: { computerId: v.id("computers") },
  handler: async (ctx, { computerId }) => {
    await requireService(ctx);
    const computer = await ctx.db.get(computerId);
    if (computer?.desiredVm?.removing !== true) {
      throw new ConvexError("Only a computer being removed can be forgotten");
    }
    await ctx.db.delete(computerId);
  },
});
