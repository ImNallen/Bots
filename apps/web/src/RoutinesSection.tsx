import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { describeCadence } from "@bots/convex/scheduleTime";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { timeLabel } from "./conversation.ts";
import { browserTimeZone, routineStatus, runStateWords, type Routine } from "./routines.ts";
import { errorMessage } from "./session.tsx";
import { Icon } from "./Icon.tsx";

function RoutineRow({ routine, timeZone, now, locale }: { routine: Routine; timeZone: string; now: number; locale: string }) {
  const pause = useMutation(api.schedules.pause);
  const resume = useMutation(api.schedules.resume);
  const runNow = useMutation(api.schedules.runNow);
  const remove = useMutation(api.schedules.remove);
  const [step, setStep] = useState<
    { kind: "idle" } | { kind: "pending" } | { kind: "confirming" } | { kind: "deleting" } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const scheduleId = routine._id;

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

  const paused = routine.nextFireAt === undefined;
  return (
    <li className="note routine-row">
      <span className="routine-icon"><Icon name="clock" /></span>
      <div className="routine-content">
      <p className="note-text">{routine.instruction}</p>
      <p className="note-meta">{describeCadence(routine.cadence, timeZone)}</p>
      <p className="note-meta">{routineStatus(routine, { now, timeZone, locale })}</p>
      {routine.lastMissed !== undefined && (
        <p className="note-meta">
          Missed {timeLabel({ at: routine.lastMissed.at, now, locale })}. {routine.lastMissed.reason}
        </p>
      )}
      {routine.recentRuns.length > 0 && (
        <ul className="routine-runs" aria-label="Recent runs">
          {routine.recentRuns.map((run) => {
            const { words, tone } = runStateWords(run.state);
            return (
              <li key={run._id} data-tone={tone}>
                {timeLabel({ at: run.createdAt, now, locale })}. {words}
              </li>
            );
          })}
        </ul>
      )}
      {step.kind === "failed" && (
        <p className="error" role="alert">
          {step.message}
        </p>
      )}
      {step.kind === "confirming" || step.kind === "deleting" ? (
        <>
          <p className="note-meta">Delete this routine? Its raw pages go. Reports already in the chat stay.</p>
          <div className="confirm-actions">
            <button type="button" className="btn btn-danger" disabled={step.kind === "deleting"} onClick={() => void confirmDelete()}>
              {step.kind === "deleting" ? "Deleting" : "Delete"}
            </button>
            <button type="button" className="btn" disabled={step.kind === "deleting"} onClick={() => setStep({ kind: "idle" })}>
              Keep
            </button>
          </div>
        </>
      ) : (
        <div className="note-actions">
          <button type="button" disabled={step.kind === "pending"} onClick={() => void act(paused ? resume : pause)}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button type="button" disabled={step.kind === "pending"} onClick={() => void act(runNow)}>
            Test now
          </button>
          <button type="button" disabled={step.kind === "pending"} onClick={() => setStep({ kind: "confirming" })}>
            Delete
          </button>
        </div>
      )}
      </div>
      <span className="routine-badge">{paused ? "Paused" : "Active"}</span>
    </li>
  );
}

export function RoutinesSection({ botId, botName, onNewRoutine, onShowChat }: { botId: Id<"bots">; botName: string; onNewRoutine: () => void; onShowChat: () => void }) {
  const list = useQuery(api.schedules.listForBot, { botId });
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");
  const now = Date.now();
  const locale = navigator.language;
  const routines = list?.routines ?? [];
  const active = routines.filter((r) => r.nextFireAt !== undefined).length;
  const shown = routines.filter((r) => filter === "all" || (filter === "active" ? r.nextFireAt !== undefined : r.nextFireAt === undefined));
  const latest = routines.flatMap((routine) => routine.recentRuns.map((run) => ({ run, instruction: routine.instruction })))
    .sort((a, b) => b.run.createdAt - a.run.createdAt)[0];
  const lastStatus = latest === undefined ? undefined : runStateWords(latest.run.state);
  return (
    <section className="routines-page" aria-label={`${botName}'s routines`}>
      <div className="routines-heading">
        <div><h2>A little less to remember.</h2><p>Give {botName} a rhythm. Your routines run quietly in the background.</p></div>
        <button type="button" className="btn btn-go" onClick={onNewRoutine}><Icon name="plus" /> New routine</button>
      </div>
      <nav className="routine-filters" aria-label="Filter routines">
        <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All routines <span>{routines.length}</span></button>
        <button type="button" aria-pressed={filter === "active"} onClick={() => setFilter("active")}>Active <span>{active}</span></button>
        <button type="button" aria-pressed={filter === "paused"} onClick={() => setFilter("paused")}>Paused <span>{routines.length - active}</span></button>
      </nav>
      {list === undefined ? <p role="status">Loading routines.</p> : shown.length === 0 ? (
        <div className="card routine-empty"><Icon name="clock" /><h3>{routines.length === 0 ? "A little help, on repeat." : "No routines here."}</h3><p>Ask {botName} in chat to repeat a task, then approve its routine card.</p></div>
      ) : (
        <ul className="card notes routine-list">
          {shown.map((routine) => <RoutineRow key={routine._id} routine={routine} timeZone={list?.timeZone ?? browserTimeZone()} now={now} locale={locale} />)}
        </ul>
      )}
      {latest !== undefined && lastStatus !== undefined && <section className="routine-last-run" aria-label="Last run">
        <h3>Last run</h3>
        <button type="button" className="routine-result" onClick={onShowChat}>
          <Icon name={latest.run.state.kind === "done" ? "routineCheck" : "clock"} />
          <span className="routine-result-text">
            <strong>{latest.instruction}</strong>
            <span data-tone={lastStatus.tone}>{lastStatus.words}{latest.run.state.kind === "done" ? ". Reports arrive in your conversation." : "."}</span>
            <small>{timeLabel({ at: latest.run.createdAt, now, locale })}</small>
          </span>
          <span className="routine-result-arrow"><Icon name="forward" /></span>
        </button>
      </section>}
      <p className="panel-note">Routine reports arrive in your conversation. To add a routine, ask {botName} in chat.</p>
    </section>
  );
}
