import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { COMPUTER_PLACEMENT_KEY, computerFits, computerHeight, fitComputer, parseComputerPlacement, resizeComputer,
  type ComputerBounds, type ComputerPlacement, type ComputerRect, type ResizeEdge } from "./floatingComputer.ts";

type Gesture = { kind: "move" } | { kind: "resize"; edge: ResizeEdge };
type Drag = { gesture: Gesture; pointerId: number; x: number; y: number; rect: ComputerRect; before: ComputerPlacement | null };

export function useFloatingComputer(chat: RefObject<HTMLElement | null>, minimized: boolean) {
  const [placement, setPlacement] = useState(() => {
    try { return parseComputerPlacement(localStorage.getItem(COMPUTER_PLACEMENT_KEY)); } catch { return null; }
  });
  const [bounds, setBounds] = useState<ComputerBounds>({ left: 0, top: 0, right: 0, bottom: 0 });
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const pending = useRef(0);

  useLayoutEffect(() => {
    const element = chat.current;
    if (element === null) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      const head = element.querySelector(".chat-head")?.getBoundingClientRect();
      const composer = element.querySelector(".composer")?.getBoundingClientRect();
      const next = { left: rect.left + 24, right: rect.right - 24, top: (head?.bottom ?? rect.top) + 16, bottom: (composer?.top ?? rect.bottom - 160) - 24 };
      setReady(true);
      setBounds((old) => old.left === next.left && old.right === next.right && old.top === next.top && old.bottom === next.bottom ? old : next);
    };
    const observer = new ResizeObserver(measure);
    const observe = () => {
      observer.observe(element);
      const dock = element.querySelector(".dock");
      if (dock !== null) observer.observe(dock);
      measure();
    };
    observe();
    const children = new MutationObserver(() => {
      cancelAnimationFrame(pending.current);
      pending.current = requestAnimationFrame(observe);
    });
    children.observe(element, { childList: true, subtree: true });
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); children.disconnect(); window.removeEventListener("resize", measure); cancelAnimationFrame(pending.current); };
  }, [chat]);

  useEffect(() => {
    if (placement === null) return;
    const timer = setTimeout(() => { try { localStorage.setItem(COMPUTER_PLACEMENT_KEY, JSON.stringify(placement)); } catch { /* Position still works without storage. */ } }, 150);
    return () => clearTimeout(timer);
  }, [placement]);

  const fits = computerFits(bounds);
  useEffect(() => {
    if (!fits) { drag.current = null; setDragging(false); }
  }, [fits]);
  const expanded = fitComputer(placement, bounds);
  const rect = fitComputer(placement, bounds, minimized);
  function moveTo(x: number, y: number) {
    const visible = { ...rect, x: Math.max(bounds.left, Math.min(x, bounds.right - rect.width)), y: Math.max(bounds.top, Math.min(y, bounds.bottom - rect.height)) };
    setPlacement({ x: visible.x - (minimized ? expanded.width - 248 : 0), y: visible.y - (minimized ? computerHeight(expanded.width) - 44 : 0), width: expanded.width });
  }
  return {
    ready, fits, rect, dragging, maxWidth: fitComputer({ ...expanded, width: 960 }, bounds).width,
    pointerDown(event: PointerEvent<HTMLElement>, gesture: Gesture) {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { gesture, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, before: placement };
      setDragging(true);
    },
    pointerMove(event: PointerEvent<HTMLElement>) {
      const start = drag.current;
      if (start === null || start.pointerId !== event.pointerId) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (start.gesture.kind === "resize") setPlacement(resizeComputer(start.rect, start.gesture.edge, dx, dy, bounds));
      else moveTo(start.rect.x + dx, start.rect.y + dy);
    },
    pointerEnd(event: PointerEvent<HTMLElement>) {
      if (drag.current?.pointerId !== event.pointerId) return;
      if (event.type === "pointercancel") setPlacement(drag.current.before);
      drag.current = null; setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    moveKey(event: KeyboardEvent<HTMLElement>) {
      const step = event.shiftKey ? 40 : 16;
      if (event.key === "ArrowLeft") moveTo(rect.x - step, rect.y);
      else if (event.key === "ArrowRight") moveTo(rect.x + step, rect.y);
      else if (event.key === "ArrowUp") moveTo(rect.x, rect.y - step);
      else if (event.key === "ArrowDown") moveTo(rect.x, rect.y + step);
      else return;
      event.preventDefault(); event.stopPropagation();
    },
    resizeKey(event: KeyboardEvent<HTMLElement>) {
      const step = event.shiftKey ? 40 : 16;
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const dx = event.key === "Home" ? 384 - rect.width : event.key === "End" ? 960 - rect.width : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -step : step;
      setPlacement(resizeComputer(rect, "e", dx, 0, bounds));
      event.preventDefault(); event.stopPropagation();
    },
  };
}
