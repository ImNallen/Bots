import { z } from "zod";

export const MAX_MARKS = 200;
// Fits the link's frame and a Convex row, with room for the marks. computerd tries PNG, then JPEG at falling quality, to stay under it.
export const MAX_SCREEN_IMAGE_BYTES = 384 * 1024;
export const MAX_DESKTOP_TEXT = 1000;

const label = (max: number) => z.string().max(max);
const mark = z.number().int().min(1).max(MAX_MARKS);

export const DESKTOP_BUTTONS = ["left", "right", "middle", "double"] as const;
export const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;

const KEY_MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;
const NAMED_KEYS = [
  "Return",
  "Escape",
  "Tab",
  "BackSpace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "Page_Up",
  "Page_Down",
  "Up",
  "Down",
  "Left",
  "Right",
  "space",
  "Menu",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
];
// The names that browser_press uses, so a model that learned those is understood here too.
const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: "Return",
  esc: "Escape",
  backspace: "BackSpace",
  del: "Delete",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
};
const KEYS_BY_NAME = new Map<string, string>([
  ...NAMED_KEYS.map((name) => [name.toLowerCase(), name] as const),
  ...Object.entries(KEY_ALIASES),
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split("").map((key) => [key, key] as const),
]);

// "ctrl+shift+t", "alt+F4", or "Return", in the form that xdotool takes. Modifiers come first, each once, and one other key ends it.
export type KeyCombo = string & { readonly __brand: "KeyCombo" };

export function parseKeyCombo(text: string): KeyCombo | null {
  const parts = text.trim().split("+").map((part) => part.trim().toLowerCase());
  const key = KEYS_BY_NAME.get(parts.at(-1) ?? "");
  const modifiers = parts.slice(0, -1);
  const known = modifiers.every((modifier) => (KEY_MODIFIERS as readonly string[]).includes(modifier));
  if (key === undefined || !known || new Set(modifiers).size !== modifiers.length) {
    return null;
  }
  return [...KEY_MODIFIERS.filter((modifier) => modifiers.includes(modifier)), key].join("+") as KeyCombo;
}

// What the model sends. Each schema is flat, because every chat request carries them, and none has a choice in it.
export const desktopLookArgs = z.strictObject({});
export const desktopClickArgs = z.strictObject({
  mark,
  button: z.enum(DESKTOP_BUTTONS).default("left"),
});
export const desktopTypeArgs = z.strictObject({
  mark: mark.optional().describe("Click this mark first. Without it, the text goes where the keyboard focus is."),
  text: z
    .string()
    .min(1)
    .max(MAX_DESKTOP_TEXT)
    .refine((text) => !text.includes("\0"), "must not contain a NUL byte"),
  replace: z.boolean().default(false).describe("Press ctrl+a before typing, which selects the text of a field. It does not work in a terminal."),
  submit: z.boolean().default(false).describe("Press Enter after typing."),
});
export const desktopKeyArgs = z.strictObject({
  keys: z
    .string()
    .min(1)
    .max(64)
    .transform((keys, context) => {
      const combo = parseKeyCombo(keys);
      if (combo === null) {
        context.addIssue({ code: "custom", message: "must be a key or a combination such as ctrl+l, alt+F4, or Return" });
        return z.NEVER;
      }
      return combo;
    }),
  times: z.number().int().min(1).max(10).default(1),
});
export const desktopScrollArgs = z.strictObject({
  mark,
  direction: z.enum(SCROLL_DIRECTIONS),
  amount: z.number().int().min(1).max(10).default(3),
});

export const box = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export type Box = z.infer<typeof box>;

export const WINDOW_KINDS = ["frame", "dialog", "popup", "panel"] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

// A window is its app, its process, its kind, and its accessibility path, which stays the same for the window's life and differs
// between two windows of one process. The title is for people and the model, and it is not part of what makes a window itself,
// because a page's title changes as it loads.
export const windowRef = z.strictObject({
  app: label(40),
  pid: z.number().int().min(1),
  kind: z.enum(WINDOW_KINDS),
  path: label(96),
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

// What the owner approved. Only the orchestrator writes it, from the run's newest look, and the model's arguments cannot carry it.
export const elementAim = z.strictObject({ window: windowRef, element });
export const focusAim = z.strictObject({ window: windowRef.nullable(), element: element.nullable() });
export const windowAim = z.strictObject({ window: windowRef.nullable() });

// The wire's options. A look changes nothing, so it needs no aim.
export const desktopInvocations = [
  z.strictObject({ name: z.literal("desktop_look"), args: desktopLookArgs }),
  z.strictObject({ name: z.literal("desktop_click"), args: desktopClickArgs, aim: elementAim }),
  z.strictObject({ name: z.literal("desktop_type"), args: desktopTypeArgs, aim: focusAim }),
  z.strictObject({ name: z.literal("desktop_key"), args: desktopKeyArgs, aim: windowAim }),
  z.strictObject({ name: z.literal("desktop_scroll"), args: desktopScrollArgs, aim: elementAim }),
] as const;

// The same options without aim, which is what a model's call parses into.
export const desktopRequests = [
  desktopInvocations[0],
  desktopInvocations[1].omit({ aim: true }),
  desktopInvocations[2].omit({ aim: true }),
  desktopInvocations[3].omit({ aim: true }),
  desktopInvocations[4].omit({ aim: true }),
] as const;
