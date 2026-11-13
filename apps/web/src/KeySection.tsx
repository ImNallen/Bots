import { api } from "@bots/convex";
import { useQuery } from "convex/react";
import { useState, type FormEvent } from "react";
import { Icon } from "./Icon.tsx";

export type KeyProvider = "mistral" | "together";

const COPY: Record<KeyProvider, { title: string; intro: string; missing: string; usedBy: string; needed: string }> = {
  mistral: {
    title: "Mistral API key",
    intro: "One key for all of your bots. You stay in control.",
    missing: "No key is set. Add one so your bots can answer with Mistral Large 4.",
    usedBy: "Used by Mistral Large 4 and by voice input.",
    needed: "Mistral Large 4 and voice input need a key.",
  },
  together: {
    title: "Together API key",
    intro: "A Together key lets your bots answer with Inkling 2 Small.",
    missing: "No key is set. Add one to use Inkling 2 Small.",
    usedBy: "Used when your bots answer with Inkling 2 Small.",
    needed: "Inkling 2 Small needs a key to answer.",
  },
};

type Submission =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "removing" }
  | { kind: "failed"; message: string };

async function requestKeyChange(args: { provider: KeyProvider; method: "PUT" | "DELETE"; key?: string }): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`/api/${args.provider}-key`, {
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

export function KeySection({ provider }: { provider: KeyProvider }) {
  const copy = COPY[provider];
  const fieldId = `${provider}-key`;
  const status = useQuery(api.credentials.status, { provider });
  const [key, setKey] = useState("");
  const [submission, setSubmission] = useState<Submission>({ kind: "idle" });
  const busy = submission.kind === "saving" || submission.kind === "removing";

  async function change(args: { method: "PUT" | "DELETE"; key?: string }) {
    setSubmission({ kind: args.method === "PUT" ? "saving" : "removing" });
    const failure = await requestKeyChange({ provider, ...args });
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
    return <p role="status">Loading the key status.</p>;
  }

  return (
    <>
      <p className="set-intro">{copy.intro}</p>
      <div className="card key-status">
        <div className="key-status-head"><Icon name="key" /><strong>{copy.title}</strong><span>{status.configured ? "Configured" : "Not configured"}</span></div>
        {status.configured ? <p className="key-masked">••••  ••••  ••••  {status.last4}</p> : <p>{copy.missing}</p>}
        <small>{copy.usedBy}</small>
      </div>
      <form className="key-form" onSubmit={handleSubmit}>
        <label className="label" htmlFor={fieldId}>
          {status.configured ? "Replace your key" : "Add a key"}
        </label>
        <p className="panel-note">We’ll check the key before saving it.</p>
        <div className="key-form-row">
          <input
            id={fieldId}
            className="field"
            type="password"
            value={key}
            placeholder={status.configured ? "Paste a new key" : "Paste your key"}
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
      <p className="key-privacy"><Icon name="shield" /><span>Your saved key is never shown here.<br />You can replace or remove it at any time.</span></p>
      {status.configured && <div className="card key-remove"><div><strong>Remove key</strong><small>{copy.needed}</small></div><button type="button" className="btn danger-link" disabled={busy} onClick={() => void change({ method: "DELETE" })}>{submission.kind === "removing" ? "Removing" : "Remove"}</button></div>}
    </>
  );
}
