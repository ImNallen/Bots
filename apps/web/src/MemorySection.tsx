import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type FormEvent } from "react";
import { timeLabel } from "./conversation.ts";
import { errorMessage } from "./session.tsx";

type Note = NonNullable<FunctionReturnType<typeof api.memories.list>>["notes"][number];

export function noteAuthor(by: Note["by"], botName: string): string {
  return by === "owner" ? "You" : botName;
}

export function NoteText({ note, botName, now, locale }: { note: Note; botName: string; now: number; locale: string }) {
  return (
    <>
      <p className="note-text">{note.text}</p>
      <p className="note-meta">
        {noteAuthor(note.by, botName)}, {timeLabel({ at: note.createdAt, now, locale })}
      </p>
    </>
  );
}

function NoteForm(props: {
  label: string;
  initial: string;
  rows: number;
  submitLabel: string;
  pendingLabel: string;
  onSubmit: (text: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const { label, initial, rows, submitLabel, pendingLabel, onSubmit, onCancel } = props;
  const [text, setText] = useState(initial);
  const [save, setSave] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "failed"; message: string }>({ kind: "idle" });
  const trimmed = text.trim();
  const unchanged = trimmed === initial;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSave({ kind: "pending" });
    try {
      await onSubmit(text);
      setText("");
      setSave({ kind: "idle" });
    } catch (error) {
      setSave({ kind: "failed", message: errorMessage(error) });
    }
  }

  return (
    <form className="note-form" onSubmit={(event) => void handleSubmit(event)}>
      <label className="profile-field">
        <span>{label}</span>
        <textarea
          className="field profile-assignment"
          rows={rows}
          value={text}
          aria-invalid={save.kind === "failed"}
          onChange={(event) => {
            setText(event.target.value);
            setSave({ kind: "idle" });
          }}
        />
      </label>
      {save.kind === "failed" && (
        <p className="error" role="alert">
          {save.message}
        </p>
      )}
      <div className="confirm-actions">
        <button type="submit" className="btn btn-go" disabled={save.kind === "pending" || trimmed === "" || unchanged}>
          {save.kind === "pending" ? pendingLabel : submitLabel}
        </button>
        {onCancel !== undefined && (
          <button type="button" className="btn" disabled={save.kind === "pending"} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function NoteRow({ note, botId, botName, now, locale }: { note: Note; botId: Id<"bots">; botName: string; now: number; locale: string }) {
  const write = useMutation(api.memories.write);
  const remove = useMutation(api.memories.remove);
  const [step, setStep] = useState<
    { kind: "idle" } | { kind: "editing" } | { kind: "confirming" } | { kind: "deleting" } | { kind: "failed"; message: string }
  >({ kind: "idle" });

  async function confirmDelete() {
    setStep({ kind: "deleting" });
    try {
      await remove({ noteId: note._id });
    } catch (error) {
      setStep({ kind: "failed", message: errorMessage(error) });
    }
  }

  if (step.kind === "editing") {
    return (
      <li className="note">
        <NoteForm
          label="Edit this note. It then counts as yours."
          initial={note.text}
          rows={6}
          submitLabel="Save"
          pendingLabel="Saving"
          onSubmit={(text) => write({ botId, text, replaces: note._id })}
          onCancel={() => setStep({ kind: "idle" })}
        />
      </li>
    );
  }
  const deciding = step.kind === "confirming" || step.kind === "deleting" || step.kind === "failed";
  return (
    <li className="note">
      <NoteText note={note} botName={botName} now={now} locale={locale} />
      {step.kind === "failed" && (
        <p className="error" role="alert">
          {step.message}
        </p>
      )}
      {deciding ? (
        <div className="confirm-actions">
          <button type="button" className="btn btn-danger" disabled={step.kind === "deleting"} onClick={() => void confirmDelete()}>
            {step.kind === "deleting" ? "Deleting" : "Delete"}
          </button>
          <button type="button" className="btn" disabled={step.kind === "deleting"} onClick={() => setStep({ kind: "idle" })}>
            Keep
          </button>
        </div>
      ) : (
        <div className="note-actions">
          <button type="button" onClick={() => setStep({ kind: "editing" })}>
            Edit
          </button>
          <button type="button" onClick={() => setStep({ kind: "confirming" })}>
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

export function MemorySection({ botId, botName }: { botId: Id<"bots">; botName: string }) {
  const memory = useQuery(api.memories.list, { botId }) ?? null;
  const write = useMutation(api.memories.write);
  const now = Date.now();
  const locale = navigator.language;
  return (
    <>
      <div className="note-head">
        <h3 className="label">Memory</h3>
        {memory !== null && (
          <span className="note-count">
            {memory.notes.length} of {memory.limit}
          </span>
        )}
      </div>
      {memory === null ? (
        <p className="panel-note" role="status">
          Loading the notes.
        </p>
      ) : (
        <>
          {memory.notes.length > 0 && (
            <ul className="card notes">
              {memory.notes.map((note) => (
                <NoteRow key={note._id} note={note} botId={botId} botName={botName} now={now} locale={locale} />
              ))}
            </ul>
          )}
          <div className="card note-new">
            <NoteForm
              label="Add a note"
              initial=""
              rows={3}
              submitLabel="Add note"
              pendingLabel="Adding"
              onSubmit={(text) => write({ botId, text })}
            />
          </div>
          <p className="panel-note">
            {botName} reads these at each step. It can save and forget its own notes, and it cannot change yours.
          </p>
        </>
      )}
    </>
  );
}
