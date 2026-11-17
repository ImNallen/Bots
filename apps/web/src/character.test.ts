import { describe, expect, it } from "vitest";
import { characterOf, COLOR_NAMES, COLORS, displayShape, SHAPE_NAMES } from "./character.ts";

const ids = Array.from({ length: 2000 }, (_, index) => `j57${index.toString(36)}ab${(index * 7).toString(36)}`);

function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

describe("COLORS", () => {
  it.each(COLOR_NAMES)("keeps white body text readable on a %s bubble", (color) => {
    const ratio = 1.05 / (luminance(COLORS[color].bubble) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});

describe("characterOf", () => {
  it.each([
    ["k1742bot", "flower", "green"],
    ["existing-bot-1", "ball", "brown"],
    ["existing-bot-2", "hex", "brown"],
    ["existing-bot-3", "burst", "red"],
    ["j570ab0", "hex", "orange"],
    ["bot-without-appearance", "flower", "purple"],
    ["historical-bot-0", "tile", "blue"],
    ["historical-bot-1", "sparkle", "teal"],
    ["historical-bot-2", "clover", "teal"],
    ["historical-bot-3", "heart", "teal"],
    ["historical-bot-4", "burst", "pink"],
    ["historical-bot-5", "hex", "purple"],
    ["historical-bot-6", "ball", "purple"],
    ["historical-bot-7", "bun", "blue"],
    ["historical-bot-8", "gem", "amber"],
    ["historical-bot-9", "burst", "orange"],
    ["historical-bot-10", "egg", "pink"],
    ["historical-bot-11", "flower", "brown"],
    ["historical-bot-13", "clover", "red"],
    ["historical-bot-24", "peak", "purple"],
    ["historical-bot-27", "bean", "purple"],
    ["historical-bot-32", "ball", "green"],
  ])("preserves the historical appearance of %s", (_id, shape, color) => {
    expect(characterOf({ _id })).toEqual({ shape, color });
  });
  it("gives the same id the same look", () => {
    expect(characterOf({ _id: "k1742bot" })).toEqual(characterOf({ _id: "k1742bot" }));
  });

  it("lets a stored value win over the derived one", () => {
    expect(characterOf({ _id: "k1742bot", shape: "hex", color: "black" })).toEqual({ shape: "hex", color: "black" });
    expect(characterOf({ _id: "k1742bot", color: "grey" }).color).toBe("grey");
    expect(characterOf({ _id: "k1742bot", shape: "egg" }).shape).toBe("egg");
  });

  it("never derives black, grey, or lemon", () => {
    for (const _id of ids) {
      expect(["black", "grey", "lemon"]).not.toContain(characterOf({ _id }).color);
    }
  });

  it("spreads ids across every shape and every colour it can derive", () => {
    const looks = ids.map((_id) => characterOf({ _id }));
    expect(new Set(looks.map((look) => look.shape)).size).toBe(13);
    expect(new Set(looks.map((look) => look.color)).size).toBe(9);
  });
});


describe("appearance choices", () => {
  it("offers the approved six silhouettes and twelve colors", () => {
    expect(SHAPE_NAMES).toEqual(["ball", "tile", "egg", "flower", "hex", "bean"]);
    expect(COLOR_NAMES.map((color) => COLORS[color].label)).toEqual(["Sage", "Blue", "Peach", "Lilac", "Rose", "Teal", "Honey", "Clay", "Coral", "Mist", "Graphite", "Lemon"]);
  });

  it.each(["bun", "sparkle", "clover", "heart", "peak", "gem", "burst"] as const)("displays legacy %s as Round", (shape) => {
    expect(displayShape(shape)).toBe("ball");
    expect(characterOf({ _id: "legacy", shape }).shape).toBe(shape);
  });
});
