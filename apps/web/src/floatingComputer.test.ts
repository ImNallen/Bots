import { describe, expect, it } from "vitest";
import { computerFits, computerHeight, fitComputer, parseComputerPlacement, resizeComputer, type ResizeEdge } from "./floatingComputer.ts";

const bounds = { left: 288, top: 104, right: 1416, bottom: 802 };

describe("floating computer placement", () => {
  it("opens at the bottom right of the chat's available area", () => {
    expect(fitComputer(null, bounds)).toEqual({ x: 776, y: 310, width: 640, height: 492 });
  });
  it("keeps offscreen saved positions reachable after changing monitors or sidebars", () => {
    const rect = fitComputer({ x: 9000, y: -1000, width: 960 }, bounds);
    expect(rect).toEqual({ x: 456, y: 104, width: 960, height: 692 });
  });
  it("preserves 16:10 video and leaves room for chrome above a growing composer", () => {
    const smaller = { ...bounds, bottom: 600 };
    const rect = fitComputer({ x: 500, y: 300, width: 960 }, smaller);
    expect(rect.y + rect.height).toBeLessThanOrEqual(smaller.bottom);
    expect(rect.x + rect.width).toBeLessThanOrEqual(smaller.right);
    expect((rect.height - 92) / rect.width).toBeCloseTo(10 / 16);
  });
  it("uses full screen when chat cannot fit even the compact window", () => {
    expect(computerFits({ ...bounds, right: 600 })).toBe(false);
    expect(computerFits({ ...bounds, bottom: 400 })).toBe(false);
    expect(computerFits({ ...bounds, right: bounds.left + 384, bottom: bounds.top + computerHeight(384) })).toBe(true);
  });
  it("places the minimized bar at the expanded window's lower right", () => {
    expect(fitComputer(null, bounds, true)).toEqual({ x: 1168, y: 758, width: 248, height: 44 });
  });
  it("resizes from every edge without crossing the chat or composer", () => {
    const initial = fitComputer(null, bounds);
    for (const edge of ["n", "s", "e", "w", "ne", "nw", "se", "sw"] satisfies ResizeEdge[]) {
      const rect = resizeComputer(initial, edge, 2000, 2000, bounds);
      expect(rect.width).toBeGreaterThanOrEqual(384);
      expect(rect.width).toBeLessThanOrEqual(960);
      expect(rect.x).toBeGreaterThanOrEqual(bounds.left);
      expect(rect.y).toBeGreaterThanOrEqual(bounds.top);
      expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.right);
      expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.bottom);
    }
  });
  it("keeps the opposite corner anchored when resizing toward the upper left", () => {
    const initial = fitComputer(null, bounds);
    const rect = resizeComputer(initial, "nw", -100, -62.5, bounds);
    expect(rect.width).toBe(740);
    expect(rect.x + rect.width).toBe(initial.x + initial.width);
    expect(rect.y + rect.height).toBe(initial.y + initial.height);
  });
  it("validates browser storage before using it", () => {
    const value = { x: 100, y: 200, width: 640 };
    expect(parseComputerPlacement(JSON.stringify(value))).toEqual(value);
    for (const invalid of [null, "null", "{", "[]", '{"x":1,"y":2,"width":0}', '{"x":1e400,"y":2,"width":640}', '{"x":"1","y":2,"width":640}']) {
      expect(parseComputerPlacement(invalid)).toBeNull();
    }
  });
});
