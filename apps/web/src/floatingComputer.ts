export type ComputerPlacement = { x: number; y: number; width: number };
export type ComputerBounds = { left: number; top: number; right: number; bottom: number };
export type ComputerRect = ComputerPlacement & { height: number };
export const COMPUTER_PLACEMENT_KEY = "bots.computerPlacement";
export const COMPUTER_MIN_WIDTH = 384;
export const COMPUTER_MAX_WIDTH = 960;
export const COMPUTER_CHROME_HEIGHT = 92;
export const COMPUTER_ASPECT = 16 / 10;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
export const computerHeight = (width: number) => width / COMPUTER_ASPECT + COMPUTER_CHROME_HEIGHT;

export function parseComputerPlacement(value: string | null): ComputerPlacement | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || !("x" in parsed) || !("y" in parsed) || !("width" in parsed)) return null;
    const { x, y, width } = parsed;
    return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
      && typeof width === "number" && Number.isFinite(width) && width >= COMPUTER_MIN_WIDTH && width <= COMPUTER_MAX_WIDTH ? { x, y, width } : null;
  } catch {
    return null;
  }
}

export function computerFits(bounds: ComputerBounds): boolean {
  return bounds.right - bounds.left >= COMPUTER_MIN_WIDTH && bounds.bottom - bounds.top >= computerHeight(COMPUTER_MIN_WIDTH);
}

export function fitComputer(placement: ComputerPlacement | null, bounds: ComputerBounds, minimized = false): ComputerRect {
  const maxWidth = Math.min(COMPUTER_MAX_WIDTH, bounds.right - bounds.left, (bounds.bottom - bounds.top - COMPUTER_CHROME_HEIGHT) * COMPUTER_ASPECT);
  const expandedWidth = clamp(placement?.width ?? 640, COMPUTER_MIN_WIDTH, Math.max(COMPUTER_MIN_WIDTH, maxWidth));
  const expandedHeight = computerHeight(expandedWidth);
  const width = minimized ? 248 : expandedWidth;
  const height = minimized ? 44 : expandedHeight;
  const x = (placement?.x ?? bounds.right - expandedWidth) + (minimized ? expandedWidth - width : 0);
  const y = (placement?.y ?? bounds.bottom - expandedHeight) + (minimized ? expandedHeight - height : 0);
  return { x: clamp(x, bounds.left, bounds.right - width), y: clamp(y, bounds.top, bounds.bottom - height), width, height };
}

export type ResizeEdge = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";
export function resizeComputer(rect: ComputerRect, edge: ResizeEdge, dx: number, dy: number, bounds: ComputerBounds): ComputerRect {
  const horizontal = edge.includes("w") ? -dx : dx;
  const vertical = (edge.includes("n") ? -dy : dy) * COMPUTER_ASPECT;
  const change = edge.length === 2 ? (Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical) : edge === "e" || edge === "w" ? horizontal : vertical;
  const width = Math.max(COMPUTER_MIN_WIDTH, Math.min(COMPUTER_MAX_WIDTH, rect.width + change));
  const height = computerHeight(width);
  return fitComputer({ x: edge.includes("w") ? rect.x + rect.width - width : rect.x,
    y: edge.includes("n") ? rect.y + rect.height - height : rect.y, width }, bounds);
}
