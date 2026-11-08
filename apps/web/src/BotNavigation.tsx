import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import {
  DndContext, DragOverlay, KeyboardSensor, MeasuringStrategy, MouseSensor, TouchSensor,
  pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { snapCenterToCursor } from "@dnd-kit/modifiers";
import { Link } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState } from "react";
import { faceStateFor, subLineOf, useShownActivity, type BotRow } from "./activity.ts";
import { BotFace, QueuedDots } from "./BotFace.tsx";
import { characterOf } from "./character.ts";
import { errorMessage } from "./session.tsx";
import { useIsPhone } from "./useIsPhone.ts";

const collisionDetection: CollisionDetection = (args) => {
  const hits = args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);
  const tile = hits.find((hit) => typeof hit.id === "string" && hit.id.startsWith("highlight:"));
  return tile ? [tile] : hits;
};

function BotLink({ row, highlighted, phone, compact, disabled }: { row: BotRow; highlighted: boolean; phone: boolean; compact: boolean; disabled: boolean }) {
  const activity = useShownActivity(row);
  const line = subLineOf({ activity, lastMessage: row.lastMessage });
  const text = line.text ?? row.title ?? null;
  const drag = useDraggable({ id: row._id, disabled, attributes: { role: "link", roleDescription: "draggable bot" } });
  const drop = useDroppable({ id: `highlight:${row._id}`, disabled: !highlighted });
  return (
    <div className={highlighted ? "highlight-tile" : "bot-row"} ref={highlighted ? drop.setNodeRef : undefined} data-over={drop.isOver}>
      <Link
        ref={drag.setNodeRef}
        className={highlighted ? "highlight-button" : "row"}
        to="/bots/$botId" params={{ botId: row._id }} search={true}
        {...drag.attributes} {...drag.listeners}
        aria-pressed={undefined}
        aria-label={compact ? row.name : undefined}
        data-dragging={drag.isDragging} data-bot-id={row._id} title={row.name}
        draggable={false}
      >
        <BotFace character={characterOf(row)} size={highlighted ? compact ? 36 : 44 : phone ? 40 : 32} state={faceStateFor(activity)} badge />
        {highlighted ? <span className="highlight-name">{row.name}</span> : (
          <span className="row-text">
            <span className="row-name">{row.name}</span>
            {(text !== null || activity.kind === "queued") && (
              <span className="row-sub" data-tone={line.tone}>
                {activity.kind === "queued" && <><QueuedDots /><span className="visually-hidden">Waiting to start. </span></>}
                <span className="row-sub-text">{text}</span>
              </span>
            )}
          </span>
        )}
      </Link>
    </div>
  );
}

function HighlightGroup({ rows, dragging, phone, compact, disabled }: { rows: BotRow[]; dragging: boolean; phone: boolean; compact: boolean; disabled: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "highlights" });
  if (rows.length === 0 && !dragging) return null;
  return (
    <div className="highlights" ref={setNodeRef} data-over={isOver} data-empty={rows.length === 0} data-count={rows.length} aria-label="Highlighted bots">
      {rows.length === 0 ? <span className="highlight-drop-label">Drop to highlight</span> : <div className="highlight-grid">{rows.map((row) => <BotLink key={row._id} row={row} highlighted phone={phone} compact={compact} disabled={disabled} />)}</div>}
    </div>
  );
}

function BotList({ rows, dragging, phone, compact, disabled }: { rows: BotRow[]; dragging: boolean; phone: boolean; compact: boolean; disabled: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: "bot-list" });
  return (
    <div className="bot-list" ref={setNodeRef} data-over={isOver && dragging}>
      {rows.map((row) => <BotLink key={row._id} row={row} highlighted={false} phone={phone} compact={compact} disabled={disabled} />)}
      {rows.length === 0 && dragging && <span className="highlight-drop-label">Drop back into the list</span>}
    </div>
  );
}

export function BotNavigation({ rows, highlightedIds, compact }: { rows: BotRow[] | undefined; highlightedIds: readonly Id<"bots">[]; compact: boolean }) {
  const setHighlight = useMutation(api.bots.setHighlight);
  const phone = useIsPhone();
  const [draggedId, setDraggedId] = useState<Id<"bots"> | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const highlighted = highlightedIds.flatMap((id) => rows?.find((row) => row._id === id) ?? []);
  const regular = rows?.filter((row) => !highlightedIds.includes(row._id)) ?? [];
  const dragged = rows?.find((row) => row._id === draggedId);

  const keyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
    let target: string;
    if (event.code === "ArrowUp") target = "highlights";
    else if (event.code === "ArrowDown") target = "bot-list";
    else if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
      const overIndex = highlighted.findIndex((row) => `highlight:${row._id}` === context.over?.id);
      const index = overIndex === -1 ? highlighted.findIndex((row) => row._id === context.active?.id) : overIndex;
      const row = highlighted[Math.max(0, Math.min(highlighted.length - 1, index + (event.code === "ArrowLeft" ? -1 : 1)))];
      if (!row) return undefined;
      target = `highlight:${row._id}`;
    } else return undefined;
    const rect = context.droppableContainers.get(target)?.node.current?.getBoundingClientRect();
    if (!rect || !context.collisionRect) return undefined;
    event.preventDefault();
    const height = target === "bot-list" ? Math.min(rect.height, 88) : rect.height;
    return { x: rect.left + (rect.width - context.collisionRect.width) / 2, y: rect.top + (height - context.collisionRect.height) / 2 };
  };
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] } }),
  );

  async function drop({ active, over }: DragEndEvent) {
    setDraggedId(null);
    const row = rows?.find((row) => row._id === active.id);
    if (!row || !over) return;
    const index = highlighted.findIndex((bot) => `highlight:${bot._id}` === over.id);
    let position: number | null;
    if (over.id === "bot-list") {
      if (!highlightedIds.includes(row._id)) return;
      position = null;
    } else if (index !== -1) position = index;
    else if (over.id === "highlights") position = Math.min(highlighted.length, 3);
    else return;
    setSaving(true);
    setProblem(null);
    try {
      await setHighlight({ botId: row._id, position });
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DndContext
      sensors={sensors} collisionDetection={collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={({ active }) => { setDraggedId(rows?.find((row) => row._id === active.id)?._id ?? null); setProblem(null); }}
      onDragCancel={() => setDraggedId(null)} onDragEnd={(event) => void drop(event)}
      accessibility={{
        screenReaderInstructions: { draggable: "Press Space to move this bot. Up highlights it, Down returns it to the list, and Left or Right reorders highlights. Press Space to drop or Escape to cancel." },
        announcements: {
          onDragStart: ({ active }) => `Picked up ${rows?.find((row) => row._id === active.id)?.name ?? "bot"}.`,
          onDragOver: ({ over }) => over?.id === "bot-list" ? "Drop to return to the bot list." : over ? "Drop to highlight or reorder." : "Move over the highlights or the bot list.",
          onDragEnd: () => "Bot dropped.",
          onDragCancel: () => "Move canceled.",
        },
      }}
    >
      <nav className="bot-nav" aria-label="Your bots" aria-busy={saving}>
        {rows === undefined ? <p className="rows-note" role="status">Loading bots.</p> : rows.length === 0 ? <p className="rows-note">No bots yet.</p> : <>
          <HighlightGroup rows={highlighted} dragging={dragged !== undefined} phone={phone} compact={compact} disabled={saving} />
          <BotList rows={regular} dragging={dragged !== undefined} phone={phone} compact={compact} disabled={saving} />
        </>}
        {problem !== null && <p className="error highlight-problem" role="alert">{problem}</p>}
      </nav>
      <DragOverlay modifiers={[snapCenterToCursor]} dropAnimation={null}>
        {dragged && <div className="highlight-button highlight-ghost" data-compact={compact}><BotFace character={characterOf(dragged)} size={compact ? 36 : 44} /><span className="highlight-name">{dragged.name}</span></div>}
      </DragOverlay>
    </DndContext>
  );
}
