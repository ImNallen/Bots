import { api } from "@bots/convex";
import type { Doc, Id } from "@bots/convex/dataModel";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { BotFace, type FaceState } from "./BotFace.tsx";
import { characterOf, type Character } from "./character.ts";
import { CharacterPicker } from "./CharacterPicker.tsx";
import { Icon } from "./Icon.tsx";
import { MemorySection } from "./MemorySection.tsx";
import { RoutinesSection } from "./RoutinesSection.tsx";
import { hasChanges, savedProfile, shownProfile, withEdit, type Profile, type ProfileEdits } from "./profileEdits.ts";
import { errorMessage } from "./session.tsx";
import { useIsPhone } from "./useIsPhone.ts";

const APPROVAL_LEVELS = [
  ["outside", "Shell commands and page changes"],
  ["everything", "Everything"],
  ["shell", "Shell commands only"],
  ["nothing", "Nothing"],
] as const;

function ProfileCard(props: { bot: Doc<"bots">; edits: ProfileEdits; onEditsChange: Dispatch<SetStateAction<ProfileEdits>> }) {
  const { bot, edits, onEditsChange } = props;
  const setProfile = useMutation(api.bots.setProfile);
  const [save, setSave] = useState<
    { kind: "idle" } | { kind: "pending" } | { kind: "saved" } | { kind: "failed"; message: string }
  >({ kind: "idle" });
  const saved = savedProfile(bot);
  const shown = shownProfile(saved, edits);
  const changed = hasChanges(edits);
  const saving = save.kind === "pending";

  function edit(field: keyof Profile, value: string) {
    onEditsChange((current) => withEdit({ saved, edits: current, field, value }));
    setSave({ kind: "idle" });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!changed || saving) {
      return;
    }
    setSave({ kind: "pending" });
    try {
      await setProfile({ botId: bot._id, ...shown });
      onEditsChange({});
      setSave({ kind: "saved" });
    } catch (error) {
      setSave({ kind: "failed", message: errorMessage(error) });
    }
  }

  return (
    <>
      <form className="card profile" onSubmit={(event) => void handleSubmit(event)}>
        <label className="profile-field">
          <span>Name</span>
          <input className="field" autoComplete="off" readOnly={saving} value={shown.name} onChange={(event) => edit("name", event.target.value)} />
        </label>
        <label className="profile-field">
          <span>Title</span>
          <input
            className="field"
            autoComplete="off"
            placeholder="What it does, in a few words"
            readOnly={saving}
            value={shown.title}
            onChange={(event) => edit("title", event.target.value)}
          />
        </label>
        <label className="profile-field">
          <span>Assignment</span>
          <textarea
            className="field profile-assignment"
            rows={6}
            placeholder="What it should do in every conversation"
            readOnly={saving}
            value={shown.assignment}
            onChange={(event) => edit("assignment", event.target.value)}
          />
        </label>
        <div className="confirm-actions">
          <button type="submit" className="btn btn-go" disabled={!changed || saving}>
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
          {save.kind === "saved" ? "Saved. " : ""}Only you can change this. A change reaches the bot at its next step.
        </p>
      )}
    </>
  );
}

function ApprovalSetting({ botId, level }: { botId: Id<"bots">; level: (typeof APPROVAL_LEVELS)[number][0] }) {
  const setLevel = useMutation(api.bots.setApprovalLevel);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <div className="card">
        <label className="card-row">
          <span>Ask before</span>
          <span className="select">
            <select
              value={level}
              onChange={(event) => {
                const next = event.target.value as typeof level;
                setProblem(null);
                setLevel({ botId, level: next }).catch((error: unknown) => setProblem(errorMessage(error)));
              }}
            >
              {APPROVAL_LEVELS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Icon name="chevron" />
          </span>
        </label>
      </div>
      {problem !== null && (
        <p className="error panel-note" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

function CharacterCard({ botId, character }: { botId: Id<"bots">; character: Character }) {
  const setCharacter = useMutation(api.bots.setCharacter);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <div className="card card-padded">
        <CharacterPicker
          character={character}
          onChange={(next) => {
            setProblem(null);
            setCharacter({ botId, ...next }).catch((error: unknown) => setProblem(errorMessage(error)));
          }}
        />
      </div>
      {problem !== null ? (
        <p className="error panel-note" role="alert">
          {problem}
        </p>
      ) : (
        <p className="panel-note">How this bot looks everywhere</p>
      )}
    </>
  );
}

// The confirmation can open below the fold of a short panel, and its buttons must not stay out of sight.
function revealOnMount(element: HTMLElement | null): void {
  element?.scrollIntoView({ block: "nearest" });
}

function DeleteBot({ botId, name }: { botId: Id<"bots">; name: string }) {
  const remove = useMutation(api.bots.remove);
  const navigate = useNavigate();
  const [step, setStep] = useState<
    { kind: "idle" } | { kind: "confirming" } | { kind: "pending" } | { kind: "failed"; message: string }
  >({ kind: "idle" });

  async function confirm() {
    setStep({ kind: "pending" });
    try {
      await remove({ botId });
      await navigate({ to: "/" });
    } catch (error) {
      setStep({ kind: "failed", message: errorMessage(error) });
    }
  }

  if (step.kind === "idle") {
    return (
      <div className="card">
        <button type="button" className="card-row danger-link" onClick={() => setStep({ kind: "confirming" })}>
          Delete bot
        </button>
      </div>
    );
  }
  return (
    <div className="card confirm" ref={revealOnMount}>
      <p>Delete {name}? Its conversation, memory, routines, files, and browser profile go for good. Logins it passed to other bots stay with them.</p>
      {step.kind === "failed" && (
        <p className="error" role="alert">
          {step.message}
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="btn btn-danger" disabled={step.kind === "pending"} onClick={() => void confirm()}>
          {step.kind === "pending" ? "Deleting" : "Delete"}
        </button>
        <button type="button" className="btn" disabled={step.kind === "pending"} onClick={() => setStep({ kind: "idle" })}>
          Keep
        </button>
      </div>
    </div>
  );
}

export function InfoPanel(props: {
  bot: Doc<"bots">;
  faceState: FaceState;
  revealRoutines: boolean;
  profileEdits: ProfileEdits;
  onProfileEditsChange: Dispatch<SetStateAction<ProfileEdits>>;
  onClose: () => void;
  onOpenScreen: () => void;
}) {
  const { bot, faceState, revealRoutines, profileEdits, onProfileEditsChange, onClose, onOpenScreen } = props;
  const isPhone = useIsPhone();
  const character = characterOf(bot);
  return (
    <aside className="info" aria-label={`About ${bot.name}`}>
      <button type="button" className="round info-close" aria-label={isPhone ? "Back" : "Close"} onClick={onClose}>
        <Icon name={isPhone ? "back" : "close"} />
      </button>
      <div className="info-who">
        <BotFace character={character} size={isPhone ? 84 : 60} state={faceState} />
        <div>
          <h2>{bot.name}</h2>
          {bot.title !== undefined && <p className="info-title">{bot.title}</p>}
        </div>
      </div>
      <h3 className="label">Computer</h3>
      <div className="card">
        <button type="button" className="card-row" onClick={onOpenScreen}>
          <span>
            {bot.name}'s screen
            <small>Watch it work, or take over</small>
          </span>
          <span className="thumb" />
        </button>
      </div>
      <h3 className="label">Profile</h3>
      <ProfileCard bot={bot} edits={profileEdits} onEditsChange={onProfileEditsChange} />
      <MemorySection botId={bot._id} botName={bot.name} />
      <RoutinesSection botId={bot._id} botName={bot.name} reveal={revealRoutines} />
      <h3 className="label">Approvals</h3>
      <ApprovalSetting botId={bot._id} level={bot.approvalLevel ?? "outside"} />
      <h3 className="label">Character</h3>
      <CharacterCard botId={bot._id} character={character} />
      <div className="info-gap" />
      <DeleteBot botId={bot._id} name={bot.name} />
    </aside>
  );
}
