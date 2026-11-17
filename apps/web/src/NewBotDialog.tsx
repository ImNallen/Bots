import { api } from "@bots/convex";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState, type FormEvent } from "react";
import { DEFAULT_CHARACTER, type Character } from "./character.ts";
import { CharacterPicker, CharacterPreview } from "./CharacterPicker.tsx";
import { DialogFrame } from "./Dialog.tsx";
import { errorMessage } from "./session.tsx";
import { useIsPhone } from "./useIsPhone.ts";

const FORM_ID = "new-bot-form";

export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const createBot = useMutation(api.bots.create);
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const [name, setName] = useState("");
  const [character, setCharacter] = useState<Character>(DEFAULT_CHARACTER);
  const [submission, setSubmission] = useState<
    { kind: "idle" } | { kind: "pending" } | { kind: "failed"; message: string }
  >({ kind: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === "" || submission.kind === "pending") {
      return;
    }
    setSubmission({ kind: "pending" });
    try {
      const botId = await createBot({ name, ...character });
      onClose();
      await navigate({ to: "/bots/$botId", params: { botId } });
    } catch (error) {
      setSubmission({ kind: "failed", message: errorMessage(error) });
    }
  }

  return (
    <DialogFrame title="Create a bot" className="dialog appearance-create" onClose={onClose} dismissible={submission.kind !== "pending"}>
      <form id={FORM_ID} className="new-bot" onSubmit={(event) => void handleSubmit(event)}>
        <div className="appearance-intro"><h2>Create a bot</h2><p>Give your bot a name and a look.</p></div>
        <CharacterPreview character={character} name={name}>
          <input
            className="field new-bot-name"
            aria-label="Name"
            placeholder="Name your bot"
            maxLength={64}
            autoComplete="off"
            // On a phone the keyboard would cover the choices below.
            data-autofocus={isPhone ? undefined : true}
            aria-invalid={submission.kind === "failed"}
            disabled={submission.kind === "pending"}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSubmission((current) => (current.kind === "failed" ? { kind: "idle" } : current));
            }}
          />
        </CharacterPreview>
        <CharacterPicker character={character} disabled={submission.kind === "pending"} onChange={(patch) => setCharacter((current) => ({ ...current, ...patch }))} />
        {submission.kind === "failed" && (
          <p className="error" role="alert">
            {submission.message}
          </p>
        )}
        <div className="appearance-create-actions">
          <button type="button" disabled={submission.kind === "pending"} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-go" disabled={name.trim() === "" || submission.kind === "pending"}>{submission.kind === "pending" ? "Creating" : "Create bot"}</button>
        </div>
        <p className="appearance-create-note">Your choices are saved when you create the bot.</p>
      </form>
    </DialogFrame>
  );
}
