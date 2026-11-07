import { api } from "@bots/convex";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { errorMessage } from "./session.tsx";

export function AboutSection() {
  const user = useQuery(api.users.current);
  const setAbout = useMutation(api.users.setAbout);
  const [draft, setDraft] = useState<string | null>(null);
  const [save, setSave] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "saved" } | { kind: "failed"; message: string }>({
    kind: "idle",
  });
  if (user === undefined) {
    return <p role="status">Loading what you wrote.</p>;
  }
  const saved = user?.about ?? "";
  const shown = draft ?? saved;
  const saving = save.kind === "pending";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSave({ kind: "pending" });
    try {
      await setAbout({ about: shown });
      setDraft(null);
      setSave({ kind: "saved" });
    } catch (error) {
      setSave({ kind: "failed", message: errorMessage(error) });
    }
  }

  return (
    <>
      <form className="card profile" onSubmit={(event) => void handleSubmit(event)}>
        <label className="profile-field">
          <span>What your bots should know about you</span>
          <textarea
            className="field profile-textarea"
            rows={4}
            placeholder="Your name, your time zone, how you like to work"
            readOnly={saving}
            value={shown}
            aria-invalid={save.kind === "failed"}
            onChange={(event) => {
              setDraft(event.target.value);
              setSave({ kind: "idle" });
            }}
          />
        </label>
        <div className="confirm-actions">
          <button type="submit" className="btn btn-go" disabled={saving || shown === saved}>
            {saving ? "Saving" : "Save"}
          </button>
        </div>
      </form>
      {save.kind === "failed" ? (
        <p className="error panel-note" role="alert">
          {save.message}
        </p>
      ) : (
        <p className="panel-note" role="status">
          {save.kind === "saved" ? "Saved. " : ""}All of your bots read this, and no bot can change it.
        </p>
      )}
    </>
  );
}
