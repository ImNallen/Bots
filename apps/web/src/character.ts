import type { Doc } from "@bots/convex/dataModel";
import type { CSSProperties } from "react";

export type BotShape = NonNullable<Doc<"bots">["shape"]>;
export type BotColor = NonNullable<Doc<"bots">["color"]>;
export type Character = { shape: BotShape; color: BotColor };
export type CharacterPatch = { shape: BotShape; color?: BotColor } | { color: BotColor; shape?: BotShape };

export const DEFAULT_CHARACTER = { shape: "ball", color: "green" } satisfies Character;

export const SHAPES = {
  ball: { label: "Round", d: "M30 0H34C50.6 0 64 13.4 64 30V34C64 50.6 50.6 64 34 64H30C13.4 64 0 50.6 0 34V30C0 13.4 13.4 0 30 0Z" },
  tile: { label: "Square", d: "M18 0H46Q64 0 64 18V46Q64 64 46 64H18Q0 64 0 46V18Q0 0 18 0Z" },
  egg: { label: "Oval", d: "M28 4H36A28 28 0 0 1 36 60H28A28 28 0 0 1 28 4Z" },
  flower: { label: "Squircle", d: "M32 0C56 0 64 8 64 32C64 56 56 64 32 64C8 64 0 56 0 32C0 8 8 0 32 0Z" },
  hex: { label: "Hexagon", d: "M24 2H40Q45 2 48 7L61 25Q65 32 61 39L48 57Q45 62 40 62H24Q19 62 16 57L3 39Q-1 32 3 25L16 7Q19 2 24 2Z" },
  bean: { label: "Capsule", d: "M24 8H40A24 24 0 0 1 40 56H24A24 24 0 0 1 24 8Z" },
} satisfies Partial<Record<BotShape, { label: string; d: string }>>;

export const SHAPE_NAMES = ["ball", "tile", "egg", "flower", "hex", "bean"] as const satisfies readonly BotShape[];

const DISPLAY_SHAPES = {
  ball: "ball", bun: "ball", tile: "tile", sparkle: "ball", clover: "ball", heart: "ball",
  flower: "flower", egg: "egg", bean: "bean", peak: "ball", gem: "ball", burst: "ball", hex: "hex",
} as const satisfies Record<BotShape, keyof typeof SHAPES>;

export function displayShape(shape: BotShape) {
  return DISPLAY_SHAPES[shape];
}

export const COLORS = {
  green: { label: "Sage", fill: "#43a96e", darkFill: "#50b87e", eyes: "#ffffff", bubble: "#0d884e" },
  blue: { label: "Blue", fill: "#5687da", darkFill: "#6999ed", eyes: "#ffffff", bubble: "#1b6fd6" },
  orange: { label: "Peach", fill: "#e88b50", darkFill: "#f09a64", eyes: "#ffffff", bubble: "#c55415" },
  purple: { label: "Lilac", fill: "#9278b8", darkFill: "#a18ac6", eyes: "#ffffff", bubble: "#7a47e6" },
  pink: { label: "Rose", fill: "#bf789b", darkFill: "#cb8daa", eyes: "#ffffff", bubble: "#da2a83" },
  teal: { label: "Teal", fill: "#449c94", darkFill: "#5bada5", eyes: "#ffffff", bubble: "#118575" },
  amber: { label: "Honey", fill: "#b9964c", darkFill: "#c6a65d", eyes: "#ffffff", bubble: "#ac6609" },
  brown: { label: "Clay", fill: "#a98167", darkFill: "#ba947a", eyes: "#ffffff", bubble: "#8a5b2e" },
  red: { label: "Coral", fill: "#c8766d", darkFill: "#d18b82", eyes: "#ffffff", bubble: "#d82433" },
  grey: { label: "Mist", fill: "#87949e", darkFill: "#9aa6b0", eyes: "#ffffff", bubble: "#767676" },
  black: { label: "Graphite", fill: "#60676b", darkFill: "#788187", eyes: "#ffffff", bubble: "#222222" },
  lemon: { label: "Lemon", fill: "#a9a047", darkFill: "#bcb35d", eyes: "#ffffff", bubble: "#716b24" },
} satisfies Record<BotColor, { label: string; fill: string; darkFill: string; eyes: string; bubble: string }>;

export const COLOR_NAMES = ["green", "blue", "orange", "purple", "pink", "teal", "amber", "brown", "red", "grey", "black", "lemon"] as const satisfies readonly BotColor[];

// These tuples are the historical hash vocabulary. Picker changes must never reassign existing bots.
const DERIVED_SHAPES = ["ball", "bun", "tile", "sparkle", "clover", "heart", "flower", "egg", "bean", "peak", "gem", "burst", "hex"] as const;
const DERIVED_COLORS = ["brown", "red", "orange", "amber", "green", "teal", "blue", "purple", "pink"] as const;

function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

export function characterOf(bot: { _id: string; shape?: BotShape; color?: BotColor }): Character {
  const hash = hashOf(bot._id);
  return {
    shape: bot.shape ?? (DERIVED_SHAPES[hash % DERIVED_SHAPES.length] ?? "ball"),
    color: bot.color ?? (DERIVED_COLORS[(hash >>> 8) % DERIVED_COLORS.length] ?? "green"),
  };
}

export function tintOf(color: BotColor): { "data-color": BotColor; style: CSSProperties } {
  const { fill, darkFill, eyes, bubble } = COLORS[color];
  return { "data-color": color, style: { "--bot-fill": fill, "--bot-dark-fill": darkFill, "--bot-eye": eyes, "--bot-bubble": bubble } as CSSProperties };
}
