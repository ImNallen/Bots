import { z } from "zod";
import { PAGE_LIMITS } from "./page-limits.ts";

export { PAGE_LIMITS } from "./page-limits.ts";

export const pageControl = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("link") }),
  z.strictObject({ kind: z.literal("submit") }),
  z.strictObject({ kind: z.literal("field"), field: z.enum(["line", "lines", "secret", "rich"]), readOnly: z.boolean() }),
  z.strictObject({ kind: z.literal("choice") }),
  z.strictObject({ kind: z.literal("button") }),
]);
export type PageControl = z.infer<typeof pageControl>;

// Words describe the page's control. They never authorize an action.
export const pageTarget = z.strictObject({
  ref: z.number().int().min(1).max(PAGE_LIMITS.targets),
  words: z.string().max(PAGE_LIMITS.words),
  control: pageControl,
});
export type PageTarget = z.infer<typeof pageTarget>;

export const pageFocus = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("target"), ref: pageTarget.shape.ref }),
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("unlisted") }),
]);
export type PageFocus = z.infer<typeof pageFocus>;

export const pageView = z.strictObject({
  snapshotId: z.uuid(),
  origin: z.string().max(PAGE_LIMITS.origin).refine((origin) => {
    if (!URL.canParse(origin)) return false;
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.origin === origin;
  }).nullable(),
  focus: pageFocus.optional(),
  targets: z.array(pageTarget).max(PAGE_LIMITS.targets),
  truncated: z.boolean(),
}).refine((page) => page.focus?.kind !== "target" || page.targets.some((target) => page.focus?.kind === "target" && target.ref === page.focus.ref), "missing focused ref")
  .refine((page) => new Set(page.targets.map(({ ref }) => ref)).size === page.targets.length, "duplicate refs")
  .refine((page) => new TextEncoder().encode(JSON.stringify(page)).length <= PAGE_LIMITS.jsonBytes, "page too large");
export type PageView = z.infer<typeof pageView>;

const pageIdentity = { snapshotId: z.uuid(), origin: pageView.shape.origin };
export const pageElementAim = z.strictObject({ kind: z.literal("element"), ...pageIdentity, target: pageTarget });
export const pageFocusAim = z.strictObject({ kind: z.literal("focus"), ...pageIdentity, focus: pageFocus, target: pageTarget.nullable() })
  .refine((aim) => aim.focus.kind === "target" ? aim.target?.ref === aim.focus.ref : aim.target === null, "focus target mismatch");
export const pageAim = z.discriminatedUnion("kind", [pageElementAim, pageFocusAim]);
export type PageAim = z.infer<typeof pageAim>;

export const PAGE_AIM_TOOL_CAPABILITY = "browser_page_aim_v1";
