import { api } from "@bots/convex";
import type { Doc, Id } from "@bots/convex/dataModel";
import { useNavigate } from "@tanstack/react-router";
import { useMutation } from "convex/react";
import { useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { BotFace, type FaceState } from "./BotFace.tsx";
import { characterOf, DEFAULT_CHARACTER, type CharacterPatch } from "./character.ts";
import { CharacterPicker, CharacterPreview } from "./CharacterPicker.tsx";
import type { useCharacterMutation } from "./useCharacterMutation.ts";
import { Icon } from "./Icon.tsx";
import { SavedCommands } from "./SavedCommands.tsx";
import { RoutinesSection } from "./RoutinesSection.tsx";
import { hasChanges, savedProfile, shownProfile, withEdit, type Profile, type ProfileEdits } from "./profileEdits.ts";
import { errorMessage } from "./session.tsx";

const APPROVAL_LEVELS = [
  ["automatic", "Automatic"],
  ["outside", "Shell, desktop, and page changes"],
  ["everything", "Everything"],
  ["shell", "Shell and desktop only"],
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
      await setProfile({ botId: bot._id, name: shown.name });
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
        <button type="button" className="btn danger-link" onClick={() => setStep({ kind: "confirming" })}>
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
  characterSave: ReturnType<typeof useCharacterMutation>;
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
  const { bot, characterSave, faceState, showRoutines, profileEdits, onProfileEditsChange, onClose, onOpenScreen, onShowChat, onShowRoutines, onComposeRoutine } = props;
  const character = characterOf(bot);
  const { failure } = characterSave;
  const save = (patch: CharacterPatch) => characterSave.save({ botId: bot._id, ...patch });
  const [appearance, setAppearance] = useState(false);
  const appearanceEntry = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (appearance) back.current?.focus();
    else if (restoreFocus.current) {
      appearanceEntry.current?.focus();
      restoreFocus.current = false;
    }
  }, [appearance]);
  if (appearance && !showRoutines) {
    return (
      <aside className="info appearance-panel" aria-label={`Appearance for ${bot.name}`}>
        <div className="appearance-head">
          <button type="button" ref={back} className="appearance-back" onClick={() => { restoreFocus.current = true; setAppearance(false); }}><Icon name="back" />Bot details</button>
          <button type="button" className="round" aria-label="Close appearance" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="appearance-intro"><h2>Appearance</h2><p>A familiar face. A little more you.</p></div>
        <CharacterPreview character={character} name={bot.name} />
        <CharacterPicker character={character} onChange={save} />
        <p className="appearance-note">Your bot's look, everywhere.</p>
        <div className="appearance-footer"><p>Changes save automatically.</p><button type="button" onClick={() => save(DEFAULT_CHARACTER)}>Reset</button></div>
        {failure && <div className="appearance-error" role="alert"><p>Couldn't save appearance. {failure.message}</p><button type="button" className="btn" onClick={() => characterSave.save(failure.patch)}>Retry</button></div>}
      </aside>
    );
  }
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
        </div>
      </div>
      <nav className="bot-destinations" aria-label="Bot views">
        <button type="button" aria-current={!showRoutines ? "page" : undefined} onClick={onShowChat}>Chat</button>
        <button type="button" aria-current={showRoutines ? "page" : undefined} onClick={onShowRoutines}>Routines</button>
        <button type="button" onClick={onOpenScreen}>Computer</button>
      </nav>
      {showRoutines ? <RoutinesSection botId={bot._id} botName={bot.name} onNewRoutine={onComposeRoutine} /> : <>
        <ProfileCard bot={bot} edits={profileEdits} onEditsChange={onProfileEditsChange} />
        <button type="button" ref={appearanceEntry} className="appearance-entry info-card" onClick={() => setAppearance(true)}>
          <BotFace character={character} size={40} /><span><strong>Appearance</strong><small>Choose a color and shape</small></span><Icon name="chevron" />
        </button>
        {failure && <div className="appearance-error" role="alert"><p>Couldn't save appearance. {failure.message}</p><button type="button" className="btn" onClick={() => characterSave.save(failure.patch)}>Retry</button></div>}
        <section className="info-card">
          <h3>Approvals</h3>
          <ApprovalSetting botId={bot._id} level={bot.approvalLevel ?? "automatic"} />
          <SavedCommands botId={bot._id} />
          <p className="panel-note">Choose when your bot asks before acting. Automatic, the default, runs routine steps and asks only before actions that send, delete, or run something unknown.</p>
        </section>
        <DeleteBot botId={bot._id} name={bot.name} />
      </>}
    </aside>
  );
}
