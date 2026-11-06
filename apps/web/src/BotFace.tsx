import { SHAPES, tintOf, type Character } from "./character.ts";

export type FaceState = "idle" | "working" | "needsApproval" | "held";

const EYE_SPACING = 11;

export function BotFace({ character, size, state = "idle" }: { character: Character; size: number; state?: FaceState }) {
  const {
    d,
    eyes: [x, y, scale],
  } = SHAPES[character.shape];
  const face = (
    <svg className="tint face" {...tintOf(character.color)} data-state={state} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path className="face-body" d={d} />
      <g className="face-eyes">
        {[-EYE_SPACING / 2, EYE_SPACING / 2].map((offset) => {
          const cx = x + offset * scale;
          return (
            <rect
              key={offset}
              className="face-eye"
              x={cx - 2.7 * scale}
              y={y - 6.6 * scale}
              width={5.4 * scale}
              height={13.2 * scale}
              rx={2.7 * scale}
              transform={`rotate(-18 ${cx} ${y})`}
            />
          );
        })}
      </g>
    </svg>
  );
  if (state !== "needsApproval") {
    return face;
  }
  return (
    <span className="face-wrap" style={{ width: size, height: size }}>
      {face}
      <span className="face-badge" />
    </span>
  );
}

export function QueuedDots() {
  return (
    <span className="dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
