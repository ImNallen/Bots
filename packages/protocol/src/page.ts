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

export const pageView = z.strictObject({
  snapshotId: z.uuid(),
  origin: z.string().max(PAGE_LIMITS.origin).refine((origin) => {
    if (!URL.canParse(origin)) return false;
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.origin === origin;
  }).nullable(),
  targets: z.array(pageTarget).max(PAGE_LIMITS.targets),
  truncated: z.boolean(),
}).refine((page) => new Set(page.targets.map(({ ref }) => ref)).size === page.targets.length, "duplicate refs")
  .refine((page) => new TextEncoder().encode(JSON.stringify(page)).length <= PAGE_LIMITS.jsonBytes, "page too large");
export type PageView = z.infer<typeof pageView>;
