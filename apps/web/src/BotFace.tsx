import { useEffect, useRef } from "react";
import { tintOf, type Character } from "./character.ts";
import happySage from "./assets/mascot/happy-sage.svg";
import happyBlue from "./assets/mascot/happy-blue.svg";
import happyPeach from "./assets/mascot/happy-peach.svg";

export type FaceState = "idle" | "thinking" | "working" | "needsApproval" | "held" | "success" | "error";

type Eye = readonly [x: number, y: number, width: number, height: number];
const EYES: Record<Exclude<FaceState, "success">, readonly [Eye, Eye]> = {
  idle: [[19, 22, 8, 20], [37, 22, 8, 20]],
  thinking: [[17, 16, 8, 18], [35, 18, 8, 14]],
  working: [[19, 28, 8, 12], [37, 28, 8, 12]],
  needsApproval: [[19, 20, 8, 22], [37, 22, 8, 16]],
  held: [[19, 29, 8, 6], [37, 29, 8, 6]],
  error: [[19, 26, 8, 10], [37, 24, 8, 14]],
};

export function BotFace({ character, size, state = "idle", badge = false }: { character: Character; size: number; state?: FaceState; badge?: boolean }) {
  const face = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const element = face.current;
    if (element === null || state !== "idle") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = window.matchMedia("(any-pointer: fine)");
    let frame = 0;
    const reset = () => {
      element.style.setProperty("--gaze-x", "0px");
      element.style.setProperty("--gaze-y", "0px");
      element.removeAttribute("data-looking");
    };
    const move = (event: PointerEvent) => {
      if (frame || motion.matches || !pointer.matches || event.pointerType === "touch") return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const box = element.getBoundingClientRect();
        const dx = event.clientX - box.x - box.width / 2;
        const dy = event.clientY - box.y - box.height / 2;
        if (Math.hypot(dx, dy) > 160) { reset(); return; }
        element.dataset.looking = "true";
        element.style.setProperty("--gaze-x", `${dx / 160 * 6}px`);
        element.style.setProperty("--gaze-y", `${dy / 160 * 6}px`);
      });
    };
    reset();
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    motion.addEventListener("change", reset);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
      motion.removeEventListener("change", reset);
      reset();
    };
  }, [state]);

  const happy = character.color === "blue" ? happyBlue : character.color === "orange" ? happyPeach : happySage;
  const eyes = EYES[state === "success" ? "idle" : state];
  const drawing = (
    <svg ref={face} className="tint face" {...tintOf(character.color)} data-state={state} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect className="face-body" width="64" height="64" rx="30" />
      {state === "success" ? <image href={happy} width="64" height="64" /> : (
        <g className="face-gaze"><g className="face-eyes">
          {eyes.map(([x, y, width, height], index) => <rect key={index} className="face-eye" x={x} y={y} width={width} height={height} rx={4} />)}
        </g></g>
      )}
    </svg>
  );
  return state === "needsApproval" && badge ? <span className="face-wrap" style={{ width: size, height: size }}>{drawing}<span className="face-badge" /></span> : drawing;
}

export function QueuedDots() {
  return <span className="dots" aria-hidden="true"><i /><i /><i /></span>;
}
