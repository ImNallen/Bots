import { z } from "zod";

export const MAX_MARKS = 200;
// Fits the link's frame and a Convex row, with room for the marks. computerd tries PNG, then JPEG at falling quality, to stay under it.
export const MAX_SCREEN_IMAGE_BYTES = 384 * 1024;

const label = (max: number) => z.string().max(max);
const mark = z.number().int().min(1).max(MAX_MARKS);

export const desktopLookArgs = z.strictObject({});

export const box = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export type Box = z.infer<typeof box>;

export const WINDOW_KINDS = ["frame", "dialog", "popup", "panel"] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

// A window is its app, its process, and its kind. The title is for people and the model, and it is not part of what makes a window
// itself, because a page's title changes as it loads.
export const windowRef = z.strictObject({
  app: label(40),
  pid: z.number().int().min(1),
  kind: z.enum(WINDOW_KINDS),
  title: label(120),
});
export type WindowRef = z.infer<typeof windowRef>;

export const ELEMENT_STATES = ["focused", "checked", "pressed", "selected", "expanded", "disabled"] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

export const element = z.strictObject({
  role: label(32),
  name: label(120),
  // Only for an entry, a text, a combo box, a spin button, or a slider. A password text never has one.
  value: label(100).optional(),
  states: z.array(z.enum(ELEMENT_STATES)).max(ELEMENT_STATES.length),
  box,
});
export type Element = z.infer<typeof element>;

export const markedElement = element.extend({ mark, win: z.number().int().min(0) });
export type MarkedElement = z.infer<typeof markedElement>;

export const screenImage = z.strictObject({
  mediaType: z.enum(["image/png", "image/jpeg"]),
  base64: z.string().max(Math.ceil(MAX_SCREEN_IMAGE_BYTES / 3) * 4),
});
export type ScreenImage = z.infer<typeof screenImage>;

// One look. computerd builds it, and the orchestrator stores and shows it. marks[].win and active index windows.
export const screenView = z.strictObject({
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  windows: z.array(windowRef).max(32),
  active: z.number().int().min(0).nullable(),
  marks: z.array(markedElement).max(MAX_MARKS),
  // Elements past MAX_MARKS.
  unlisted: z.number().int().min(0),
  // Apps that did not answer in time, or "accessibility" when the desktop has no accessibility tree to read.
  silent: z.array(label(40)).max(16),
  // Absent when the journal answers a repeated call, or when no encoding fit.
  image: screenImage.optional(),
});
export type ScreenView = z.infer<typeof screenView>;

export const desktopInvocations = [z.strictObject({ name: z.literal("desktop_look"), args: desktopLookArgs })] as const;
