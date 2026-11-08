import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { describeCadence } from "@bots/convex/scheduleTime";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import activeUrl from "./assets/ui/routine-active.svg";
import pausedUrl from "./assets/ui/routine-paused.svg";
import { timeLabel } from "./conversation.ts";
import { browserTimeZone, nextRunLabel, routineStatus, runStateWords, type Routine } from "./routines.ts";
import { errorMessage } from "./session.tsx";
import { Icon } from "./Icon.tsx";

function RoutineControl({ routine, timeZone, now, locale, expanded, onSelect, onChangeInChat }: {
  routine: Routine; timeZone: string; now: number; locale: string;
  expanded: boolean; onSelect: () => void; onChangeInChat: () => void;
}) {
  const pause = useMutation(api.schedules.pause);
  const resume = useMutation(api.schedules.resume);
  const runNow = useMutation(api.schedules.runNow);
  const remove = useMutation(api.schedules.remove);
  const [step, setStep] = useState<
    { kind: "idle" } | { kind: "pending" } | { kind: "confirming" } | { kind: "deleting" } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const scheduleId = routine._id;
  const paused = routine.nextFireAt === undefined;
  const busy = step.kind === "pending" || step.kind === "deleting";

  async function act(mutate: (args: { scheduleId: Id<"schedules"> }) => Promise<unknown>) {
    setStep({ kind: "pending" });
    try {
      await mutate({ scheduleId });
      setStep({ kind: "idle" });
    } catch (error) {
      setStep({ kind: "failed", message: errorMessage(error) });
    }
  }

  async function confirmDelete() {
    setStep({ kind: "deleting" });
    try {
      await remove({ scheduleId });
    } catch (error) {
      setStep({ kind: "failed", message: errorMessage(error) });
    }
  }

  const toggle = <button type="button" className="routine-toggle" role="switch" aria-checked={!paused}
    aria-label={`${paused ? "Resume" : "Pause"} ${routine.instruction}`} disabled={busy}
    onClick={() => void act(paused ? resume : pause)}>
    <img src={paused ? pausedUrl : activeUrl} alt="" width={32} height={20} />
  </button>;

  return (
    <div className={expanded ? "routine-detail" : "routine-row"}>
      {expanded ? <>
        <h3>{routine.instruction}</h3>
        <div className="routine-detail-field"><h4>Task</h4><p>{routine.instruction}</p></div>
        <div className="routine-detail-field"><h4>Schedule</h4><p>{describeCadence(routine.cadence, timeZone)}</p></div>
        <div className="routine-status"><span>{paused ? "Paused" : "Active"}</span>{toggle}</div>
        <p className="panel-note">{routineStatus(routine, { now, timeZone, locale })}</p>
        {routine.lastMissed !== undefined && <p className="panel-note">Missed {timeLabel({ at: routine.lastMissed.at, now, locale })}. {routine.lastMissed.reason}</p>}
        {routine.recentRuns.length > 0 && <ul className="routine-runs" aria-label="Recent runs">
          {routine.recentRuns.map((run) => {
            const { words, tone } = runStateWords(run.state);
            return <li key={run._id} data-tone={tone}>{timeLabel({ at: run.createdAt, now, locale })}. {words}</li>;
          })}
        </ul>}
        {step.kind === "confirming" || step.kind === "deleting" ? <div className="confirm">
          <p>Delete this routine? Its raw pages go. Reports already in the chat stay.</p>
          <div className="confirm-actions">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirmDelete()}>{busy ? "Deleting" : "Delete"}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setStep({ kind: "idle" })}>Keep</button>
          </div>
        </div> : <div className="routine-actions">
          <button type="button" className="btn btn-go" disabled={busy} onClick={onChangeInChat}>Change in chat</button>
          <button type="button" className="btn" disabled={busy} onClick={() => void act(runNow)}>Test now</button>
          <button type="button" className="btn" disabled={busy} onClick={() => setStep({ kind: "confirming" })}>Delete</button>
        </div>}
      </> : <>
        <button type="button" className="routine-content" aria-label={`Details for ${routine.instruction}`} onClick={onSelect}>
          <span className="routine-title">{routine.instruction}</span>
          <span className="routine-cadence">{describeCadence(routine.cadence, timeZone)}{paused ? " · Paused" : ""}</span>
        </button>
        {toggle}
      </>}
      {step.kind === "failed" && <p className="error" role="alert">{step.message}</p>}
    </div>
  );
}

export function RoutinesSection({ botId, botName, onNewRoutine }: { botId: Id<"bots">; botName: string; onNewRoutine: () => void }) {
  const list = useQuery(api.schedules.listForBot, { botId });
  const [selectedId, setSelectedId] = useState<Id<"schedules"> | null>(null);
  const now = Date.now();
  const locale = navigator.language;
  const routines = list?.routines ?? [];
  const selected = routines.find((routine) => routine._id === selectedId);
  const nextFireAt = routines.reduce<number | undefined>((next, routine) => routine.nextFireAt === undefined ? next : Math.min(next ?? Infinity, routine.nextFireAt), undefined);
  const timeZone = list?.timeZone ?? browserTimeZone();

  return (
    <section className="routines-panel" aria-label={`${botName}'s routines`}>
      {selected === undefined ? <>
        <div className="routines-heading"><h2>Routines</h2><button type="button" className="btn" onClick={onNewRoutine}><Icon name="plus" /> New</button></div>
        {list === undefined ? <p role="status">Loading routines.</p> : routines.length === 0 ? (
          <div className="card routine-empty"><h3>A little help, on repeat.</h3><p>Ask {botName} in chat to repeat a task, then approve its routine card.</p></div>
        ) : <ul className="routine-list">{routines.map((routine) => <li key={routine._id}>
          <RoutineControl routine={routine} timeZone={timeZone} now={now} locale={locale} expanded={false} onSelect={() => setSelectedId(routine._id)} onChangeInChat={onNewRoutine} />
        </li>)}</ul>}
        {nextFireAt !== undefined && <p className="panel-note">Next run: {nextRunLabel({ at: nextFireAt, now, timeZone, locale })}.</p>}
      </> : <>
        <button type="button" className="btn routine-back" onClick={() => setSelectedId(null)}><Icon name="back" /> All routines</button>
        <RoutineControl key={selected._id} routine={selected} timeZone={timeZone} now={now} locale={locale} expanded onSelect={() => setSelectedId(null)} onChangeInChat={onNewRoutine} />
      </>}
      <p className="panel-note">Results arrive in your conversation.</p>
    </section>
  );
}
