import { api } from "@bots/convex";
import type { Doc } from "@bots/convex/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useState, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import type { KeyProvider } from "./KeySection.tsx";
import { errorMessage } from "./session.tsx";

const KEY_NAME: Record<KeyProvider, string> = { mistral: "Mistral key", together: "Together key" };

const CHAT_MODELS: Record<KeyProvider, string> = {
  mistral: "Mistral Large 4",
  together: "Inkling 2 Small, through Together",
};

type VoiceModel = NonNullable<Doc<"users">["voiceModel"]>;

const VOICE_MODELS: Record<VoiceModel, { name: string; provider: KeyProvider }> = {
  voxtral: { name: "Voxtral, through Mistral", provider: "mistral" },
  "whisper-large-v3": { name: "Whisper Large v3, through Together", provider: "together" },
  "parakeet-v3": { name: "Parakeet v3, through Together", provider: "together" },
};

export function voiceProviderOf(model: VoiceModel | undefined): KeyProvider {
  return VOICE_MODELS[model ?? "voxtral"].provider;
}

type Save = { kind: "idle" } | { kind: "pending" } | { kind: "saved" } | { kind: "failed"; message: string };

function Choice<T extends string>(props: {
  label: string;
  note: string;
  value: T;
  options: Record<T, string>;
  keyProvider: KeyProvider;
  missingKey: string;
  save: (value: T) => Promise<void>;
}): ReactNode {
  const key = useQuery(api.credentials.status, { provider: props.keyProvider });
  const [state, setState] = useState<Save>({ kind: "idle" });

  async function choose(value: T) {
    setState({ kind: "pending" });
    try {
      await props.save(value);
      setState({ kind: "saved" });
    } catch (error) {
      setState({ kind: "failed", message: errorMessage(error) });
    }
  }

  return (
    <>
      <div className="card">
        <label className="card-row">
          <span>{props.label}<small>{props.note}</small></span>
          <span className="select">
            <select value={props.value} disabled={state.kind === "pending"} onChange={(event) => void choose(event.target.value as T)}>
              {(Object.keys(props.options) as T[]).map((value) => (
                <option key={value} value={value}>
                  {props.options[value]}
                </option>
              ))}
            </select>
            <Icon name="chevron" />
          </span>
        </label>
      </div>
      {state.kind === "failed" ? (
        <p className="error panel-note" role="alert">
          {state.message}
        </p>
      ) : key !== undefined && !key.configured ? (
        <p className="error panel-note" role="alert">
          No {KEY_NAME[props.keyProvider]} is set, so {props.missingKey}. Add one under {KEY_NAME[props.keyProvider]}.
        </p>
      ) : state.kind === "saved" ? (
        <p className="panel-note" role="status">
          Saved.
        </p>
      ) : null}
    </>
  );
}

export function ModelSection() {
  const user = useQuery(api.users.current);
  const setModelProvider = useMutation(api.users.setModelProvider);
  const setVoiceModel = useMutation(api.users.setVoiceModel);
  if (user === undefined) {
    return <p role="status">Loading your models.</p>;
  }
  const chat: KeyProvider = user?.modelProvider ?? "mistral";
  const voice: VoiceModel = user?.voiceModel ?? "voxtral";
  const voiceNames = Object.fromEntries(Object.entries(VOICE_MODELS).map(([id, model]) => [id, model.name])) as Record<VoiceModel, string>;

  return (
    <>
      <p className="set-intro">Every one of your bots answers with these. Each model needs the key of the service it runs on.</p>
      <Choice
        label="Model"
        note="A change reaches the next step of a bot that is working."
        value={chat}
        options={CHAT_MODELS}
        keyProvider={chat}
        missingKey="your bots cannot answer"
        save={async (provider) => void (await setModelProvider({ provider }))}
      />
      <Choice
        label="Voice input"
        note="Turns what you dictate into text before you send it."
        value={voice}
        options={voiceNames}
        keyProvider={VOICE_MODELS[voice].provider}
        missingKey="voice input is off"
        save={async (model) => void (await setVoiceModel({ model }))}
      />
    </>
  );
}
