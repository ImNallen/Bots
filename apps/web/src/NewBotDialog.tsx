import { api } from "@bots/convex";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState, type FormEvent } from "react";
import { BotFace } from "./BotFace.tsx";
import { characterOf } from "./character.ts";
import { CharacterPicker } from "./CharacterPicker.tsx";
import { Dialog } from "./Dialog.tsx";
import { errorMessage } from "./session.tsx";
import { useIsPhone } from "./useIsPhone.ts";

const FORM_ID = "new-bot-form";

export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const createBot = useMutation(api.bots.create);
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const [name, setName] = useState("");
  // A new bot has no id yet, so a random one gives it a look that is never black or grey.
  const [character, setCharacter] = useState(() => characterOf({ _id: crypto.randomUUID() }));
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
    <Dialog
      title="New bot"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} className="btn btn-go" disabled={name.trim() === "" || submission.kind === "pending"}>
            {submission.kind === "pending" ? "Creating" : "Create"}
          </button>
        </>
      }
    >
      <form id={FORM_ID} className="new-bot" onSubmit={(event) => void handleSubmit(event)}>
        <div className="new-bot-face">
          <BotFace character={character} size={76} />
        </div>
        <input
          className="field new-bot-name"
          aria-label="Name"
          placeholder="Name your bot"
          maxLength={64}
          autoComplete="off"
          // On a phone the keyboard would cover the choices below.
          data-autofocus={isPhone ? undefined : true}
          aria-invalid={submission.kind === "failed"}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            // Only a failure clears. Clearing a pending create would let a second click make a second bot.
            setSubmission((current) => (current.kind === "failed" ? { kind: "idle" } : current));
          }}
        />
        <CharacterPicker character={character} onChange={setCharacter} />
        {submission.kind === "failed" && (
          <p className="error" role="alert">
            {submission.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}
