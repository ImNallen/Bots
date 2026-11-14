import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { describeCadence } from "@bots/convex/scheduleTime";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import activeUrl from "./assets/ui/routine-active.svg";
import pausedUrl from "./assets/ui/routine-paused.svg";
import { timeLabel } from "./conversation.ts";
import { browserTimeZone, nextRunLabel, nextRunLine, runStateWords, shownRoutines, type DeletedRoutine, type Routine } from "./routines.ts";
import { errorMessage } from "./session.tsx";
import { Icon } from "./Icon.tsx";

const SWIPE_REVEAL = 96;
const SWIPE_SLOP = 8;
// True of every routine, because every routine runs read-only and logged out, and reports in its bot's chat.
const LIMITS = ["Read only", "Logged out", "Reports in this chat"];

type Clock = { now: number; timeZone: string; locale: string };

function RoutineSwitch({ routine, onError }: { routine: Routine; onError: (message: string) => void }) {
  const pause = useMutation(api.schedules.pause);
  const resume = useMutation(api.schedules.resume);
  const [pending, setPending] = useState(false);
  const paused = routine.nextFireAt === undefined;

  async function toggle() {
    setPending(true);
    try {
      await (paused ? resume : pause)({ scheduleId: routine._id });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <button type="button" className="routine-toggle" role="switch" aria-checked={!paused} aria-label={`${paused ? "Resume" : "Pause"} ${routine.title}`} disabled={pending} onClick={() => void toggle()}>
      <img src={paused ? pausedUrl : activeUrl} alt="" width={32} height={20} />
    </button>
  );
}

function useOutsidePointer(ref: { current: HTMLElement | null }, active: boolean, onOutside: () => void) {
  const latest = useRef(onOutside);
  latest.current = onOutside;
  useEffect(() => {
    if (!active) {
      return;
    }
    const listener = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) {
        latest.current();
      }
    };
    document.addEventListener("pointerdown", listener, true);
    return () => document.removeEventListener("pointerdown", listener, true);
  }, [ref, active]);
}

// A touch drags the row left to show Delete. A mouse uses the context menu instead, so only a touch or a pen starts a swipe.
function useSwipe(open: boolean, onOpenChange: (open: boolean) => void) {
  const drag = useRef<{ x: number; y: number; pointerId: number; from: number; horizontal: boolean | null } | null>(null);
  const swiped = useRef(false);
  const [offset, setOffset] = useState<number | null>(null);
  const base = open ? -SWIPE_REVEAL : 0;

  function end() {
    const current = drag.current;
    drag.current = null;
    if (current?.horizontal === true) {
      swiped.current = true;
      onOpenChange((offset ?? current.from) < -SWIPE_REVEAL / 2);
    }
    setOffset(null);
  }

  return {
    offset: offset ?? base,
    dragging: offset !== null,
    // A swipe ends in a click on whatever was under the finger, and that click must not open the details.
    takeClick: () => {
      const was = swiped.current;
      swiped.current = false;
      return was;
    },
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType !== "mouse") {
          drag.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, from: base, horizontal: null };
        }
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const current = drag.current;
        if (current === null || current.pointerId !== event.pointerId) {
          return;
        }
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        if (current.horizontal === null) {
          if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) {
            return;
          }
          current.horizontal = Math.abs(dx) > Math.abs(dy);
          if (!current.horizontal) {
            drag.current = null;
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        setOffset(Math.min(0, Math.max(-SWIPE_REVEAL, current.from + dx)));
      },
      onPointerUp: end,
      onPointerCancel: end,
    },
  };
}

function RoutineListRow({ routine, timeZone, menuOpen, swiped, onSelect, onMenuChange, onSwipeChange, onDelete, onError }: {
  routine: Routine;
  timeZone: string;
  menuOpen: boolean;
  swiped: boolean;
  onSelect: () => void;
  onMenuChange: (open: boolean) => void;
  onSwipeChange: (open: boolean) => void;
  onDelete: () => void;
  onError: (message: string) => void;
}) {
  const item = useRef<HTMLLIElement>(null);
  const content = useRef<HTMLButtonElement>(null);
  const menuItem = useRef<HTMLButtonElement>(null);
  const swipe = useSwipe(swiped, onSwipeChange);
  const paused = routine.nextFireAt === undefined;
  useOutsidePointer(item, menuOpen || swiped, () => {
    onMenuChange(false);
    onSwipeChange(false);
  });
  useEffect(() => {
    if (menuOpen) {
      menuItem.current?.focus();
    }
  }, [menuOpen]);

  function closeMenu() {
    onMenuChange(false);
    content.current?.focus();
  }

  function openMenuFromKeys(event: KeyboardEvent) {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      onMenuChange(true);
    }
  }

  return (
    <li ref={item} className="routine-item" data-selected={menuOpen}>
      <div className="routine-swipe" data-open={swiped || swipe.dragging}>
        <button type="button" className="routine-swipe-delete" tabIndex={swiped ? 0 : -1} aria-hidden={!swiped} onClick={onDelete}>
          Delete
        </button>
        <div
          className="routine-row"
          data-dragging={swipe.dragging}
          style={{ transform: `translateX(${swipe.offset}px)` }}
          onContextMenu={(event) => {
            event.preventDefault();
            onSwipeChange(false);
            onMenuChange(true);
          }}
          {...swipe.handlers}
        >
          <button
            ref={content}
            type="button"
            className="routine-content"
            aria-label={`Details for ${routine.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onKeyDown={openMenuFromKeys}
            onClick={() => {
              if (swipe.takeClick()) {
                return;
              }
              if (swiped) {
                onSwipeChange(false);
                return;
              }
              onSelect();
            }}
          >
            <span className="routine-title">{routine.title}</span>
            <span className="routine-cadence">{describeCadence(routine.cadence, timeZone)}{paused ? " · Paused" : ""}</span>
          </button>
          <RoutineSwitch routine={routine} onError={onError} />
        </div>
      </div>
      {menuOpen && (
        <div className="routine-menu" role="menu" aria-label={`${routine.title} actions`}>
          <button
            ref={menuItem}
            type="button"
            role="menuitem"
            onClick={onDelete}
            onKeyDown={(event) => {
              if (event.key === "Escape" || event.key === "Tab") {
                event.preventDefault();
                closeMenu();
              }
            }}
          >
            Delete routine
          </button>
        </div>
      )}
    </li>
  );
}

function DeletedRow({ routine, undoMs, onError }: { routine: DeletedRoutine; undoMs: number; onError: (message: string) => void }) {
  const restore = useMutation(api.schedules.restore);
  // Fixed when the line appears, so a later render cannot restart the bar.
  const [left] = useState(() => Math.max(0, routine.deletingUntil - Date.now()));
  const bar = { "--undo-from": Math.min(1, left / undoMs), animationDuration: `${left}ms` } as CSSProperties;

  return (
    <li className="routine-deleted">
      <p role="status">{routine.title} deleted.</p>
      <button
        type="button"
        className="btn btn-go"
        onClick={() => {
          restore({ scheduleId: routine._id }).catch((error: unknown) => onError(errorMessage(error)));
        }}
      >
        Undo
      </button>
      <span className="routine-undo-bar" style={bar} aria-hidden="true" />
    </li>
  );
}

function RoutineDetail({ routine, clock, onError }: { routine: Routine; clock: Clock; onError: (message: string) => void }) {
  const { now, locale, timeZone } = clock;
  return (
    <div className="routine-detail">
      <div className="routine-head">
        <h3>{routine.title}</h3>
        {routine.summary !== undefined && <p>{routine.summary}</p>}
      </div>
      <div className="routine-when">
        <div>
          <p className="routine-when-cadence">{describeCadence(routine.cadence, timeZone, { withZone: false })}</p>
          <p className="routine-when-next">{nextRunLine(routine, clock)}</p>
          {routine.lastMissed !== undefined && (
            <p className="routine-when-next">
              Missed {timeLabel({ at: routine.lastMissed.at, now, locale })}. {routine.lastMissed.reason}
            </p>
          )}
        </div>
        <RoutineSwitch routine={routine} onError={onError} />
      </div>
      {routine.steps !== undefined && (
        <section className="routine-part" aria-label="What it does">
          <h4>What it does</h4>
          <ol className="routine-steps">
            {routine.steps.map((step, index) => (
              <li key={index}>
                <span className="routine-step-number" aria-hidden="true">{index + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="routine-part" aria-label="Limits">
        <h4>Limits</h4>
        <ul className="routine-limits">
          {LIMITS.map((limit) => <li key={limit}>{limit}</li>)}
        </ul>
      </section>
      {routine.recentRuns.length > 0 && (
        <section className="routine-part" aria-label="Recent runs">
          <h4>Recent runs</h4>
          <ul className="routine-runs">
            {routine.recentRuns.map((run) => {
              const { words, tone } = runStateWords(run.state);
              return (
                <li key={run._id} data-tone={tone}>
                  <span className="routine-run-dot" aria-hidden="true" />
                  <span className="routine-run-words">{words}</span>
                  <span className="routine-run-time">{timeLabel({ at: run.createdAt, now, locale })}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

// Re-renders when the soonest undo window ends, so its line goes on time even if the server's delete comes later.
function useRerenderAt(times: readonly number[]) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const now = Date.now();
  const next = Math.min(...times.filter((time) => time > now));
  useEffect(() => {
    if (!Number.isFinite(next)) {
      return;
    }
    const timer = setTimeout(rerender, next - Date.now());
    return () => clearTimeout(timer);
  }, [next]);
}

export function RoutinesSection({ botId, botName, onNewRoutine }: { botId: Id<"bots">; botName: string; onNewRoutine: () => void }) {
  const list = useQuery(api.schedules.listForBot, { botId });
  const remove = useMutation(api.schedules.remove);
  const { routine: selectedId } = useSearch({ from: "/app/bots/$botId" });
  const navigate = useNavigate({ from: "/bots/$botId" });
  const setSelectedId = (routine: Id<"schedules"> | undefined) => void navigate({ search: (previous) => ({ ...previous, routine }), replace: true });
  const [menuId, setMenuId] = useState<Id<"schedules"> | null>(null);
  const [swipedId, setSwipedId] = useState<Id<"schedules"> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useRerenderAt((list?.routines ?? []).flatMap((row) => (row.kind === "deleted" ? [row.deletingUntil] : [])));
  const clock: Clock = { now: Date.now(), locale: navigator.language, timeZone: list?.timeZone ?? browserTimeZone() };
  const rows = shownRoutines(list?.routines ?? [], clock.now);
  const live = rows.filter((row) => row.kind === "live");
  const selected = live.find((routine) => routine._id === selectedId);
  const nextFireAt = live.reduce<number | undefined>((next, routine) => (routine.nextFireAt === undefined ? next : Math.min(next ?? Infinity, routine.nextFireAt)), undefined);

  async function deleteRoutine(scheduleId: Id<"schedules">) {
    setMenuId(null);
    setSwipedId(null);
    setFailure(null);
    try {
      await remove({ scheduleId });
    } catch (error) {
      setFailure(errorMessage(error));
    }
  }

  return (
    <section className="routines-panel" aria-label={`${botName}'s routines`}>
      {selected === undefined ? (
        <>
          <div className="routines-heading">
            <h2>Routines</h2>
            <button type="button" className="btn" onClick={onNewRoutine}><Icon name="plus" /> New</button>
          </div>
          {list === undefined ? (
            <p role="status">Loading routines.</p>
          ) : list === null || rows.length === 0 ? (
            <div className="card routine-empty">
              <h3>A little help, on repeat.</h3>
              <p>Ask {botName} in chat to repeat a task, and it sets up a routine here.</p>
            </div>
          ) : (
            <ul className="routine-list">
              {rows.map((row) =>
                row.kind === "deleted" ? (
                  <DeletedRow key={row._id} routine={row} undoMs={list.undoMs} onError={setFailure} />
                ) : (
                  <RoutineListRow
                    key={row._id}
                    routine={row}
                    timeZone={clock.timeZone}
                    menuOpen={menuId === row._id}
                    swiped={swipedId === row._id}
                    onSelect={() => setSelectedId(row._id)}
                    onMenuChange={(open) => setMenuId((current) => (open ? row._id : current === row._id ? null : current))}
                    onSwipeChange={(open) => setSwipedId((current) => (open ? row._id : current === row._id ? null : current))}
                    onDelete={() => void deleteRoutine(row._id)}
                    onError={setFailure}
                  />
                ),
              )}
            </ul>
          )}
          {nextFireAt !== undefined && <p className="panel-note">Next run: {nextRunLabel({ at: nextFireAt, ...clock })}.</p>}
        </>
      ) : (
        <>
          <button type="button" className="btn routine-back" onClick={() => setSelectedId(undefined)}><Icon name="back" /> All routines</button>
          <RoutineDetail key={selected._id} routine={selected} clock={clock} onError={setFailure} />
        </>
      )}
      {failure !== null && <p className="error" role="alert">{failure}</p>}
      <p className="panel-note">Results arrive in your conversation.</p>
    </section>
  );
}
