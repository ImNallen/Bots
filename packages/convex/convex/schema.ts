import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    authSubject: v.string(),
    email: v.string(),
    displayName: v.string(),
  }).index("by_auth_subject", ["authSubject"]),

  bots: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
  }).index("by_owner", ["ownerId"]),
});
