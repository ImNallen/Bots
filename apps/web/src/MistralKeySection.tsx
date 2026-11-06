import { api } from "@bots/convex";
import { useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

type Submission =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "removing" }
  | { kind: "failed"; message: string };

async function requestKeyChange(args: { method: "PUT" | "DELETE"; key?: string }): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch("/api/mistral-key", {
      method: args.method,
      headers: { "Content-Type": "application/json" },
      body: args.key === undefined ? undefined : JSON.stringify({ key: args.key }),
    });
  } catch {
    return "The orchestrator could not be reached. Try again.";
  }
  if (response.ok) {
    return null;
  }
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return `The request failed with status ${response.status}.`;
}

export function MistralKeySection() {
  const status = useQuery(api.credentials.status);
  const [key, setKey] = useState("");
  const [submission, setSubmission] = useState<Submission>({ kind: "idle" });
  const busy = submission.kind === "saving" || submission.kind === "removing";

  async function change(args: { method: "PUT" | "DELETE"; key?: string }) {
    setSubmission({ kind: args.method === "PUT" ? "saving" : "removing" });
    const failure = await requestKeyChange(args);
    if (failure === null) {
      setKey("");
      setSubmission({ kind: "idle" });
    } else {
      setSubmission({ kind: "failed", message: failure });
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change({ method: "PUT", key });
  }

  if (status === undefined) {
    return (
      <section className="settings-section">
        <h3 className="label">Mistral key</h3>
        <p role="status">Loading the key status.</p>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <h3 className="label">Mistral key</h3>
      <div className="card">
        <div className="card-row">
          <span>
            {status.configured ? (
              <>
                A key ending in <code>{status.last4}</code> is set.
              </>
            ) : (
              "No key is set. Bots need one before they can answer."
            )}
          </span>
          {status.configured && (
            <button type="button" className="btn" disabled={busy} onClick={() => void change({ method: "DELETE" })}>
              {submission.kind === "removing" ? "Removing" : "Remove key"}
            </button>
          )}
        </div>
      </div>
      <form className="key-form" onSubmit={handleSubmit}>
        <label className="label" htmlFor="mistral-key">
          {status.configured ? "Replace the key" : "Add a key"}
        </label>
        <div className="key-form-row">
          <input
            id="mistral-key"
            className="field"
            type="password"
            value={key}
            autoComplete="off"
            aria-invalid={submission.kind === "failed"}
            onChange={(event) => setKey(event.target.value)}
          />
          <button type="submit" className="btn btn-go" disabled={busy || key.trim() === ""}>
            {submission.kind === "saving" ? "Checking" : status.configured ? "Replace key" : "Save key"}
          </button>
        </div>
        {submission.kind === "failed" && (
          <p className="error" role="alert">
            {submission.message}
          </p>
        )}
      </form>
    </section>
  );
}
