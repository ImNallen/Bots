import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotFace, type FaceState } from "./BotFace.tsx";
import { COLOR_NAMES, SHAPE_NAMES, SHAPES, displayShape } from "./character.ts";

const states = ["idle", "thinking", "working", "needsApproval", "held", "success", "error"] satisfies FaceState[];

describe("BotFace", () => {
  it.each(states)("retains every selected silhouette and palette while %s", (state) => {
    for (const shape of SHAPE_NAMES) {
      for (const color of COLOR_NAMES) {
        const face = renderToStaticMarkup(<BotFace character={{ shape, color }} size={80} state={state} />);
        expect(face).toContain(`d="${SHAPES[shape].d}"`);
        expect(face).toContain(`data-color="${color}"`);
        expect(face).toContain(`data-state="${state}"`);
        expect(face).toContain("--bot-eye:#ffffff");
        if (state !== "success") expect(face.match(/class="face-eye"/g)).toHaveLength(2);
      }
    }
  });

  it("normalizes legacy silhouettes for display without changing stored identity", () => {
    expect(displayShape("burst")).toBe("ball");
    const face = renderToStaticMarkup(<BotFace character={{ shape: "burst", color: "red" }} size={32} />);
    expect(face).toContain(`d="${SHAPES.ball.d}"`);
  });

  it("adds the approval badge without replacing the selected body", () => {
    const face = renderToStaticMarkup(<BotFace character={{ shape: "tile", color: "lemon" }} size={32} state="needsApproval" badge />);
    expect(face).toContain('class="face-badge"');
    expect(face).toContain(`d="${SHAPES.tile.d}"`);
  });
});
