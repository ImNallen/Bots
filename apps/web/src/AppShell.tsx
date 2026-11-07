import { api } from "@bots/convex";
import { Outlet, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { createContext, useContext, useRef, useState } from "react";
import { BotNavigation } from "./BotNavigation.tsx";
import { Icon } from "./Icon.tsx";
import { NewBotDialog } from "./NewBotDialog.tsx";
import { SignedIn } from "./session.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { useIsPhone } from "./useIsPhone.ts";

const SIDEBAR_WIDTH_KEY = "bots.sidebarWidth";
const MIN_SIDEBAR_WIDTH = 88;
const MAX_SIDEBAR_WIDTH = 400;
const DEFAULT_SIDEBAR_WIDTH = 264;

function readSidebarWidth() {
  try {
    const value = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(value) && value >= MIN_SIDEBAR_WIDTH && value <= MAX_SIDEBAR_WIDTH) return value;
  } catch {
    // The sidebar still resizes when storage is unavailable.
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

const OpenNewBot = createContext<() => void>(() => {});

export function useOpenNewBot(): () => void {
  return useContext(OpenNewBot);
}

function Sidebar(props: { email: string; onNewBot: () => void; onSettings: () => void }) {
  const { email, onNewBot, onSettings } = props;
  const rows = useQuery(api.bots.overview);
  const user = useQuery(api.users.current);
  const name = user?.displayName ?? email;
  const phone = useIsPhone();
  const [width, setWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const compact = !phone && width < 148;

  function resize(value: number) {
    const next = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(value)));
    setWidth(next);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    } catch {
      // The current choice still applies for this session.
    }
  }

  return (
    <aside className="side" data-compact={compact} data-resizing={resizing} style={phone ? undefined : { width }}>
      <div className="side-top">
        <button type="button" className="round" aria-label="New bot" onClick={onNewBot}>
          <Icon name="addBot" />
        </button>
      </div>
      <BotNavigation rows={user === undefined ? undefined : rows} highlightedIds={user?.highlightedBotIds ?? []} compact={compact} />
      <button type="button" className="me" aria-label={`Settings for ${email}`} title={compact ? `Settings for ${name}` : undefined} onClick={onSettings}>
        <span className="me-dot">{name.split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join("").toUpperCase()}</span>
        <span className="me-name">{name}</span>
        <span className="me-gear">
          <Icon name="accountDots" />
        </span>
      </button>
      {!phone && <div
        className="sidebar-resize"
        role="separator" aria-orientation="vertical" aria-label="Resize bot sidebar"
        aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH} aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          drag.current = { startX: event.clientX, startWidth: width };
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (drag.current !== null) resize(drag.current.startWidth + event.clientX - drag.current.startX);
        }}
        onPointerUp={(event) => {
          drag.current = null;
          setResizing(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          if (drag.current !== null) resize(drag.current.startWidth);
          drag.current = null;
          setResizing(false);
        }}
        onLostPointerCapture={() => { drag.current = null; setResizing(false); }}
        onDoubleClick={() => resize(DEFAULT_SIDEBAR_WIDTH)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 32 : 8;
          if (event.key === "ArrowLeft") resize(width - step);
          else if (event.key === "ArrowRight") resize(width + step);
          else if (event.key === "Home") resize(MIN_SIDEBAR_WIDTH);
          else if (event.key === "End") resize(MAX_SIDEBAR_WIDTH);
          else return;
          event.preventDefault();
        }}
      />}
    </aside>
  );
}

function Shell({ email }: { email: string }) {
  const { botId } = useParams({ strict: false });
  const showsContent = botId !== undefined;
  const [dialog, setDialog] = useState<"newBot" | "settings" | null>(null);
  const openNewBot = () => setDialog("newBot");
  const closeDialog = () => setDialog(null);
  return (
    <div className="app" data-view={showsContent ? "content" : "list"}>
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
