import { api } from "@bots/convex";
import type { Doc, Id } from "@bots/convex/dataModel";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { BotFace, type FaceState } from "./BotFace.tsx";
import { characterOf, type Character } from "./character.ts";
import { CharacterPicker } from "./CharacterPicker.tsx";
import { Icon } from "./Icon.tsx";
import { RoutinesSection } from "./RoutinesSection.tsx";
import { hasChanges, savedProfile, shownProfile, withEdit, type Profile, type ProfileEdits } from "./profileEdits.ts";
import { errorMessage } from "./session.tsx";

const APPROVAL_LEVELS = [
  ["outside", "Shell commands and page changes"],
  ["everything", "Everything"],
  ["shell", "Shell commands only"],
  ["nothing", "Nothing"],
] as const;

function ProfileCard(props: { bot: Doc<"bots">; edits: ProfileEdits; onEditsChange: Dispatch<SetStateAction<ProfileEdits>> }) {
  const { bot, edits, onEditsChange } = props;
  const setProfile = useMutation(api.bots.setIdentity);
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
      await setProfile({ botId: bot._id, name: shown.name, title: shown.title });
      onEditsChange({});
      setSave({ kind: "saved" });
    } catch (error) {
      setSave({ kind: "failed", message: errorMessage(error) });
    }
  }

  return (
    <>
      <form className="card profile" onSubmit={(event) => void handleSubmit(event)}>
        <h3>Profile</h3>
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
        <div className="confirm-actions profile-save">
          <small role="status">{save.kind === "saved" ? "Saved." : "Shown in your bot list."}</small>
          <button type="submit" className="btn btn-go" disabled={!changed || saving}>
            {saving ? "Saving" : "Save"}
          </button>
        </div>
      </form>
      {save.kind === "failed" ? (
        <p className="error panel-note" role="alert">
          {save.message}
        </p>
      ) : null}
    </>
  );
}

function ApprovalSetting({ botId, level }: { botId: Id<"bots">; level: (typeof APPROVAL_LEVELS)[number][0] }) {
  const setLevel = useMutation(api.bots.setApprovalLevel);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <>
      <label className="approval-setting">
        <span className="visually-hidden">Ask before</span>
        <span className="select">
          <select
            aria-label="Ask before"
            value={level}
            onChange={(event) => {
              const next = APPROVAL_LEVELS.find(([value]) => value === event.target.value)?.[0];
              if (next === undefined) return;
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
      <div className="delete-bot-footer">
        <div><h3>Delete {name}</h3><p>Remove this bot and its work.</p></div>
        <button type="button" className="btn" onClick={() => setStep({ kind: "confirming" })}>
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
  showRoutines: boolean;
  profileEdits: ProfileEdits;
  onProfileEditsChange: Dispatch<SetStateAction<ProfileEdits>>;
  onClose: () => void;
  onOpenScreen: () => void;
  onShowChat: () => void;
  onShowRoutines: () => void;
  onComposeRoutine: () => void;
}) {
  const { bot, faceState, showRoutines, profileEdits, onProfileEditsChange, onClose, onOpenScreen, onShowChat, onShowRoutines, onComposeRoutine } = props;
  const character = characterOf(bot);
  return (
    <aside className="info" data-routines={showRoutines} aria-label={`About ${bot.name}`}>
      <div className="info-head">
        <span>Bot details</span>
        <button type="button" className="round" aria-label="Close bot details" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="info-who">
        <BotFace character={character} size={showRoutines ? 48 : 64} state={faceState} />
        <div>
          <h2>{bot.name}</h2>
          {bot.title && <p className="info-title">{bot.title}</p>}
        </div>
      </div>
      <nav className="bot-destinations" aria-label="Bot views">
        <button type="button" aria-current={!showRoutines ? "page" : undefined} onClick={onShowChat}>Chat</button>
        <button type="button" aria-current={showRoutines ? "page" : undefined} onClick={onShowRoutines}>Routines</button>
        <button type="button" onClick={onOpenScreen}>Computer</button>
      </nav>
      {showRoutines ? <RoutinesSection botId={bot._id} botName={bot.name} onNewRoutine={onComposeRoutine} /> : <>
        <ProfileCard bot={bot} edits={profileEdits} onEditsChange={onProfileEditsChange} />
        <section className="info-card">
          <h3>Appearance</h3>
          <CharacterCard botId={bot._id} character={character} />
        </section>
        <section className="info-card">
          <h3>Approvals</h3>
          <ApprovalSetting botId={bot._id} level={bot.approvalLevel ?? "outside"} />
          <p className="panel-note">Choose when your bot asks before acting.</p>
        </section>
        <DeleteBot botId={bot._id} name={bot.name} />
      </>}
    </aside>
  );
}
