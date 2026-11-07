import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { describeCadence } from "@bots/convex/scheduleTime";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { timeLabel } from "./conversation.ts";
import { browserTimeZone, routineStatus, runStateWords, type Routine } from "./routines.ts";
import { errorMessage } from "./session.tsx";

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
    <li className="note">
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
    </li>
  );
}

export function RoutinesSection({ botId, botName }: { botId: Id<"bots">; botName: string }) {
  const list = useQuery(api.schedules.listForBot, { botId }) ?? null;
  const now = Date.now();
  const locale = navigator.language;
  return (
    <>
      <div className="note-head">
        <h3 className="label">Routines</h3>
        {list !== null && (
          <span className="note-count">
            {list.routines.length} of {list.limit}
          </span>
        )}
      </div>
      {list === null ? (
        <p className="panel-note" role="status">
          Loading the routines.
        </p>
      ) : (
        <>
          {list.routines.length > 0 && (
            <ul className="card notes">
              {list.routines.map((routine) => (
                <RoutineRow key={routine._id} routine={routine} timeZone={list.timeZone ?? browserTimeZone()} now={now} locale={locale} />
              ))}
            </ul>
          )}
          <p className="panel-note">
            Ask {botName} in the chat for something that recurs, and approve its card. A routine reads the web logged out, changes nothing, and reports in the chat.
          </p>
        </>
      )}
    </>
  );
}
