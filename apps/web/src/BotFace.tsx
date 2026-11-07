import { tintOf, type Character } from "./character.ts";

export type FaceState = "idle" | "working" | "needsApproval" | "held";

const EYE_SPACING = 18;

export function BotFace({ character, size, state = "idle" }: { character: Character; size: number; state?: FaceState }) {
  const face = (
    <svg className="tint face" {...tintOf(character.color)} data-state={state} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect className="face-body" width="64" height="64" rx="30" />
      <g className="face-eyes">
        {[-EYE_SPACING / 2, EYE_SPACING / 2].map((offset) => {
          const cx = 32 + offset;
          return (
            <rect
              key={offset}
              className="face-eye"
              x={cx - 4}
              y={22}
              width={8}
              height={20}
              rx={4}
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
