import { api } from "@bots/convex";
import { Link, Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { createContext, useContext, useState } from "react";
import { FACE_STATES, subLineOf, type BotRow } from "./activity.ts";
import { BotFace, QueuedDots } from "./BotFace.tsx";
import { characterOf } from "./character.ts";
import { Icon } from "./Icon.tsx";
import { NewBotDialog } from "./NewBotDialog.tsx";
import { SignedIn } from "./session.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { useIsPhone } from "./useIsPhone.ts";

const OpenNewBot = createContext<() => void>(() => {});

export function useOpenNewBot(): () => void {
  return useContext(OpenNewBot);
}

function BotRowLink({ row }: { row: BotRow }) {
  const isPhone = useIsPhone();
  const { text, tone } = subLineOf(row);
  const queued = row.activity.kind === "queued";
  return (
    <Link className="row" to="/bots/$botId" params={{ botId: row._id }} search={true}>
      <BotFace character={characterOf(row)} size={isPhone ? 44 : 32} state={FACE_STATES[row.activity.kind]} />
      <span className="row-text">
        <span className="row-name">{row.name}</span>
        {(text !== null || queued) && (
          <span className="row-sub" data-tone={tone}>
            {queued && <QueuedDots />}
            {queued && <span className="visually-hidden">Waiting to start. </span>}
            <span className="row-sub-text">{text}</span>
          </span>
        )}
      </span>
    </Link>
  );
}

function Sidebar(props: { email: string; onNewBot: () => void; onSettings: () => void }) {
  const { email, onNewBot, onSettings } = props;
  const rows = useQuery(api.bots.overview);
  return (
    <aside className="side">
      <div className="side-top">
        <h1 className="side-title">Bots</h1>
        <button type="button" className="round" aria-label="New bot" onClick={onNewBot}>
          <Icon name="plus" />
        </button>
      </div>
      <nav className="rows" aria-label="Your bots">
        {rows === undefined && (
          <p className="rows-note" role="status">
            Loading bots.
          </p>
        )}
        {rows?.length === 0 && <p className="rows-note">No bots yet.</p>}
        {rows?.map((row) => <BotRowLink key={row._id} row={row} />)}
      </nav>
      <button type="button" className="me" aria-label={`Settings for ${email}`} onClick={onSettings}>
        <span className="me-dot">{email.charAt(0).toUpperCase()}</span>
        <span className="me-name">{email}</span>
        <span className="me-gear">
          <Icon name="gear" />
        </span>
      </button>
    </aside>
  );
}

function Shell({ email }: { email: string }) {
  const { botId } = useParams({ strict: false });
  const [dialog, setDialog] = useState<"newBot" | "settings" | null>(null);
  const openNewBot = () => setDialog("newBot");
  const closeDialog = () => setDialog(null);
  return (
    <div className="app" data-view={botId === undefined ? "list" : "bot"}>
      <Sidebar email={email} onNewBot={openNewBot} onSettings={() => setDialog("settings")} />
      <main className="content">
        <OpenNewBot.Provider value={openNewBot}>
          <Outlet />
        </OpenNewBot.Provider>
      </main>
      {dialog === "newBot" && <NewBotDialog onClose={closeDialog} />}
      {dialog === "settings" && <SettingsDialog email={email} onClose={closeDialog} />}
    </div>
  );
}

export function AppShell() {
  return <SignedIn>{({ email }) => <Shell email={email} />}</SignedIn>;
}
