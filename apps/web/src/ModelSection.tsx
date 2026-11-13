import { api } from "@bots/convex";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Icon } from "./Icon.tsx";
import type { KeyProvider } from "./KeySection.tsx";
import { errorMessage } from "./session.tsx";

const MODELS: Record<KeyProvider, { name: string; key: string }> = {
  mistral: { name: "Mistral Large 4", key: "Mistral key" },
  together: { name: "Inkling 2 Small, through Together", key: "Together key" },
};

export function ModelSection() {
  const user = useQuery(api.users.current);
  const current: KeyProvider = user?.modelProvider ?? "mistral";
  const key = useQuery(api.credentials.status, { provider: current });
  const setModelProvider = useMutation(api.users.setModelProvider);
  const [save, setSave] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "saved" } | { kind: "failed"; message: string }>({ kind: "idle" });
  if (user === undefined) {
    return <p role="status">Loading your model.</p>;
  }

  async function choose(provider: KeyProvider) {
    setSave({ kind: "pending" });
    try {
      await setModelProvider({ provider });
      setSave({ kind: "saved" });
    } catch (error) {
      setSave({ kind: "failed", message: errorMessage(error) });
    }
  }

  return (
    <>
      <p className="set-intro">Every one of your bots answers with this model. Voice input always uses your Mistral key.</p>
      <div className="card">
        <label className="card-row">
          <span>Model<small>A change reaches the next step of a bot that is working.</small></span>
          <span className="select">
            <select value={current} disabled={save.kind === "pending"} onChange={(event) => void choose(event.target.value as KeyProvider)}>
              {(Object.keys(MODELS) as KeyProvider[]).map((provider) => (
                <option key={provider} value={provider}>
                  {MODELS[provider].name}
                </option>
              ))}
            </select>
            <Icon name="chevron" />
          </span>
        </label>
      </div>
      {save.kind === "failed" ? (
        <p className="error panel-note" role="alert">
          {save.message}
        </p>
      ) : key !== undefined && !key.configured ? (
        <p className="error panel-note" role="alert">
          No {MODELS[current].key} is set, so your bots cannot answer. Add one under {MODELS[current].key}.
        </p>
      ) : save.kind === "saved" ? (
        <p className="panel-note" role="status">
          Saved.
        </p>
      ) : null}
    </>
  );
}
