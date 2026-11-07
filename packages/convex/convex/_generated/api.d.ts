/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as approvals from "../approvals.js";
import type * as bots from "../bots.js";
import type * as computers from "../computers.js";
import type * as credentials from "../credentials.js";
import type * as identity from "../identity.js";
import type * as memories from "../memories.js";
import type * as profile from "../profile.js";
import type * as runs from "../runs.js";
import type * as schedules from "../schedules.js";
import type * as threads from "../threads.js";
import type * as users from "../users.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  approvals: typeof approvals;
  bots: typeof bots;
  computers: typeof computers;
  credentials: typeof credentials;
  identity: typeof identity;
  memories: typeof memories;
  profile: typeof profile;
  runs: typeof runs;
  schedules: typeof schedules;
  threads: typeof threads;
  users: typeof users;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
