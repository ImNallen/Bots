import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import RFB from "@novnc/novnc";
import { useConvex, useMutation } from "convex/react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type Dispatch, type RefObject } from "react";
import { BotFace } from "./BotFace.tsx";
import type { Character } from "./character.ts";
import { Icon } from "./Icon.tsx";
import { KEY_KEYSYMS, isNamedKey, planTyping, type NamedKey } from "./keysyms.ts";
import {
  INITIAL_SCREEN_STATE,
  holdsScreen,
  screenReducer,
  streamFor,
  type ScreenEvent,
  type ScreenNotice,
  type ScreenState,
  type Stream,
} from "./screenState.ts";
import { useFloatingComputer } from "./useFloatingComputer.ts";
import type { ResizeEdge } from "./floatingComputer.ts";
import gripUrl from "./assets/ui/window-grip.svg";
import minimizeUrl from "./assets/ui/window-minimize.svg";
import expandUrl from "./assets/ui/window-expand.svg";
import closeUrl from "./assets/ui/window-close.svg";
import eyeUrl from "./assets/ui/window-eye.svg";
import resizeUrl from "./assets/ui/window-resize.svg";
import restoreUrl from "./assets/ui/window-restore.svg";
import { useHasCoarsePointer, useIsPhone } from "./useIsPhone.ts";

const RENEW_MS = 60_000;
// Matches .scr-mid in styles.css, so a stream's letterbox does not show.
const VIEW_BACKGROUND = "#141414";
const KEY_BAR = [
  ["Tab", "Tab"],
  ["Esc", "Escape"],
  ["←", "ArrowLeft"],
  ["↑", "ArrowUp"],
  ["↓", "ArrowDown"],
  ["→", "ArrowRight"],
  ["⌫", "Backspace"],
  ["Enter", "Enter"],
] as const;

function socketUrl(path: string): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${path}`;
}

function ScreenStream(props: { botId: string; mode: "watch" | "control"; dispatch: Dispatch<ScreenEvent> }) {
  const { botId, mode, dispatch } = props;
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = target.current;
    if (element === null) {
      return undefined;
    }
    const path = `/screens/${encodeURIComponent(botId)}${mode === "control" ? "/input" : ""}`;
    const rfb = new RFB(element, socketUrl(path), { shared: true });
    rfb.viewOnly = mode === "watch";
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = VIEW_BACKGROUND;
    const onConnect = () => {
      dispatch({ type: "connected", stream: rfb });
      if (mode === "control") {
        // So a real keyboard reaches the desktop at once, and a shortcut does not reach this page instead.
        rfb.focus({ preventScroll: true });
      }
    };
    const onDisconnect = () => dispatch({ type: "disconnected" });
    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect);
    return () => {
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect);
      rfb.disconnect();
    };
  }, [botId, mode, dispatch]);

  return <div className="scr-stream" ref={target} aria-label="This bot's screen" />;
}

// While the state holds the screen, the owner has it. Leaving those states for any reason gives it back, and so does closing the
// view or leaving the page, so none of them keeps the bot waiting.
function useTakeover(botId: Id<"bots">, state: ScreenState, dispatch: Dispatch<ScreenEvent>) {
  const convex = useConvex();
  const takeOver = useMutation(api.bots.takeOver);
  const release = useMutation(api.bots.releaseTakeover);
  const until = useRef(0);
  const replaced = useRef(false);
  const holding = holdsScreen(state);
  const lost = state.kind === "lost";

  useEffect(() => {
    if (!holding) {
      return undefined;
    }
    let cancelled = false;
    replaced.current = false;
    const renew = setInterval(() => {
      takeOver({ botId }).then(
        (value) => {
          until.current = value;
        },
        () => {},
      );
    }, RENEW_MS);
    takeOver({ botId }).then(
      (value) => {
        until.current = value;
        if (!cancelled) {
          dispatch({ type: "granted" });
        }
      },
      () => {
        if (!cancelled) {
          dispatch({ type: "refused" });
        }
      },
    );
    return () => {
      cancelled = true;
      clearInterval(renew);
      if (!replaced.current) {
        release({ botId }).catch(() => {});
      }
    };
  }, [botId, holding, dispatch, release, takeOver]);

  // A newer tab of this owner ends this stream by taking over. It renewed the take-over before that, so a value that is not ours
  // says so, and giving back now would take the screen from that tab.
  useEffect(() => {
    if (lost) {
      convex
        .query(api.bots.get, { botId })
        .then((bot) => {
          const current = bot?.takeoverUntil ?? 0;
          replaced.current = current !== 0 && current !== until.current;
        })
        .catch(() => {})
        .finally(() => dispatch({ type: "settled" }));
    }
  }, [botId, convex, dispatch, lost]);
}

// A phone's keyboard covers the page without resizing it, so the view follows the part that stays visible. A pinch also shrinks that
// part, and the view must not shrink with it.
function useFitVisibleArea(enabled: boolean) {
  const [area, setArea] = useState<{ top: number; height: number } | undefined>();
  useLayoutEffect(() => {
    const visible = window.visualViewport;
    if (!enabled || visible === null) return;
    const fit = () => setArea(visible.scale > 1.01 ? undefined : { top: visible.offsetTop, height: visible.height });
    fit();
    visible.addEventListener("resize", fit);
    visible.addEventListener("scroll", fit);
    return () => { visible.removeEventListener("resize", fit); visible.removeEventListener("scroll", fit); };
  }, [enabled]);
  return enabled ? area : undefined;
}

const WINDOW_ICONS = { grip: gripUrl, minimize: minimizeUrl, expand: expandUrl, close: closeUrl, eye: eyeUrl, resize: resizeUrl, restore: restoreUrl };
function WindowIcon({ name }: { name: keyof typeof WINDOW_ICONS }) {
  return <span className="window-icon" style={{ maskImage: `url("${WINDOW_ICONS[name]}")` }} aria-hidden="true" />;
}

const REFUSALS = {
  "no-key": "That character has no key on the screen, so nothing was sent. It is still in this box.",
  "keyboard-full": "The screen's keyboard has no room for another new character, so nothing was sent. Give back and take over again to type it.",
} as const;

function TypingBox({ stream }: { stream: Stream }) {
  const composing = useRef(false);
  const added = useRef<ReadonlySet<number>>(new Set());
  const [refusal, setRefusal] = useState<keyof typeof REFUSALS | null>(null);

  function flush(element: HTMLInputElement) {
    if (element.value === "") {
      setRefusal(null);
      return;
    }
    const plan = planTyping(element.value, added.current);
    if (plan.kind === "refuse") {
      setRefusal(plan.reason);
      return;
    }
    for (const keysym of plan.keysyms) {
      stream.sendKey(keysym, null);
    }
    added.current = plan.added;
    setRefusal(null);
    element.value = "";
  }

  // A phone keyboard builds a word through composition, and changing the box during that garbles the word. So the text
  // goes to the page when the word is done. The box then empties, so a password never sits in it or in the chat.
  return (
    <>
      <input
        aria-label="Type on the screen"
        placeholder="Tap here to type on the screen"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          flush(event.currentTarget);
        }}
        onInput={(event) => {
          if (!composing.current) {
            flush(event.currentTarget);
          }
        }}
        onKeyDown={(event) => {
          // During composition these keys choose or confirm a word for the keyboard, and they are not meant for the page.
          if (isNamedKey(event.key) && !composing.current && !event.nativeEvent.isComposing) {
            flush(event.currentTarget);
            // Text that was refused stays in the box. These keys then edit it here, so a person can remove the character that
            // was refused, and none of them reach the screen, because an Enter there could submit a form without that text.
            if (event.currentTarget.value === "") {
              event.preventDefault();
              stream.sendKey(KEY_KEYSYMS[event.key], null);
            } else if (event.key === "Enter") {
              event.preventDefault();
            }
          }
        }}
      />
      {refusal !== null && (
        <p className="scr-refusal" role="alert">
          {REFUSALS[refusal]}
        </p>
      )}
    </>
  );
}

function TouchControls({ stream }: { stream: Stream }) {
  return (
    <div className="typing">
      <TypingBox stream={stream} />
      {/* A key must not take focus from the box, because a phone would then close its keyboard. */}
      <div className="keys" role="group" aria-label="Keys" onMouseDown={(event) => event.preventDefault()}>
        {KEY_BAR.map(([label, key]: readonly [string, NamedKey]) => (
          <button key={key} type="button" aria-label={key} onClick={() => stream.sendKey(KEY_KEYSYMS[key], null)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ControlPill({ state, dispatch, floating = false }: { state: ScreenState; dispatch: Dispatch<ScreenEvent>; floating?: boolean }) {
  switch (state.kind) {
    case "watching":
    case "requesting":
      return (
        <div className="seg-big">
          <span>
            {floating ? <WindowIcon name="eye" /> : <Icon name="eye" />}
            {floating ? "Watching · Live" : "Watching"}
          </span>
          <button type="button" disabled={state.kind === "requesting"} onClick={() => dispatch({ type: "takeControl" })}>
            {state.kind === "requesting" ? "Taking control…" : "Take control"}
          </button>
        </div>
      );
    case "joining":
    case "controlling":
      return (
        <div className="seg-big">
          <span><Icon name="pointer" />You have control</span>
          <button type="button" onClick={() => dispatch({ type: "giveBack" })}>
            Give back
          </button>
        </div>
      );
    case "connecting":
    case "ended":
    case "lost":
      return null;
  }
}

const NOTICES: Record<ScreenNotice, string> = {
  takeoverEnded: "Your take-over ended. You are watching, and the bot keeps working.",
  takeoverRefused: "Could not take control. You are watching, and the bot keeps working.",
};

function topLine(state: ScreenState): string | null {
  switch (state.kind) {
    case "joining":
    case "controlling":
      return "The bot waits before its next action.";
    case "connecting":
    case "watching":
      return state.notice === null ? null : NOTICES[state.notice];
    case "ended":
    case "requesting":
    case "lost":
      return null;
  }
}

function Message({ state, dispatch }: { state: ScreenState; dispatch: Dispatch<ScreenEvent> }) {
  switch (state.kind) {
    case "connecting":
    case "joining":
    case "lost":
      return (
        <p className="scr-note" role="status">
          Connecting to the screen.
        </p>
      );
    case "ended":
      return (
        <div className="scr-note">
          <p role="status">The screen is not connected. The computer may be starting.</p>
          <button type="button" className="scr-retry" onClick={() => dispatch({ type: "retry" })}>
            Try again
          </button>
        </div>
      );
    case "watching":
    case "requesting":
    case "controlling":
      return null;
  }
}

export function ScreenPanel({ botId, botName, character, chat, openRequest, onClose, onCoverChange }: {
  botId: Id<"bots">; botName: string; character: Character; chat: RefObject<HTMLElement | null>;
  openRequest: number; onClose: () => void; onCoverChange: (covered: boolean) => void;
}) {
  const [state, dispatch] = useReducer(screenReducer, INITIAL_SCREEN_STATE);
  useTakeover(botId, state, dispatch);
  const isPhone = useIsPhone();
  const hasTouchKeyboard = useHasCoarsePointer();
  const [presentation, setPresentation] = useState<"window" | "minimized" | "fullscreen">("window");
  const geometry = useFloatingComputer(chat, presentation === "minimized");
  const fullScreen = isPhone || hasTouchKeyboard || (geometry.ready && !geometry.fits) || presentation === "fullscreen";
  const minimized = !fullScreen && presentation === "minimized";
  const view = useRef<HTMLElement>(null);
  const [opener] = useState(() => document.activeElement);
  const visibleArea = useFitVisibleArea(fullScreen && (isPhone || hasTouchKeyboard));
  const holding = holdsScreen(state);

  useEffect(() => { setPresentation("window"); }, [openRequest]);
  useLayoutEffect(() => { onCoverChange(fullScreen); }, [fullScreen, onCoverChange]);
  useLayoutEffect(() => {
    const target = minimized ? view.current?.querySelector<HTMLButtonElement>('[aria-label="Restore computer window"]')
      : holding ? view.current?.querySelector<HTMLCanvasElement>(".scr-stream canvas") : view.current;
    target?.focus({ preventScroll: true });
  }, [fullScreen, minimized, holding]);
  useEffect(() => {
    view.current?.focus({ preventScroll: true });
    return () => { if (opener instanceof HTMLElement) opener.focus({ preventScroll: true }); };
  }, [opener]);
  useEffect(() => {
    if (holding) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (fullScreen || (event.target instanceof Node && view.current?.contains(event.target)))) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [holding, fullScreen, onClose]);

  function minimize() {
    if (holding) dispatch({ type: "giveBack" });
    setPresentation("minimized");
  }
  const compact = isPhone || hasTouchKeyboard;
  const mode = streamFor(state);
  const edges: ResizeEdge[] = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];
  const pointer = { onPointerMove: geometry.pointerMove, onPointerUp: geometry.pointerEnd, onPointerCancel: geometry.pointerEnd, onLostPointerCapture: geometry.pointerEnd };
  return (
    <section ref={view} className="screen" role={fullScreen ? "dialog" : "region"} aria-modal={fullScreen ? true : undefined}
      aria-label={`${botName}'s screen`} tabIndex={-1} data-compact={compact}
      data-presentation={fullScreen ? "fullscreen" : minimized ? "minimized" : "floating"} data-dragging={geometry.dragging}
      style={fullScreen ? visibleArea : { left: geometry.rect.x, top: geometry.rect.y, width: geometry.rect.width, height: geometry.rect.height }}>
      {fullScreen ? <div className="scr-top" key="header">
        <button type="button" className="scr-x" aria-label="Close the screen" onClick={onClose}><Icon name="back" /></button>
        <BotFace character={character} size={compact ? 30 : 36} state={holding ? "held" : "idle"} />
        <div className="scr-identity"><h2>{botName}’s computer</h2><small>Live screen</small></div>
        <span className="scr-connection">{state.kind === "ended" ? "Disconnected" : state.kind === "watching" || state.kind === "controlling" || state.kind === "requesting" ? <><Icon name="check" /> Connected</> : "Connecting…"}</span>
        {!compact && geometry.fits && <button type="button" className="scr-x" aria-label="Return to floating view" onClick={() => setPresentation("window")}><Icon name="shrink" /></button>}
      </div> : <div className="window-header" key="header">
        <div className="window-drag" role="button" tabIndex={0} aria-label="Move computer window" aria-describedby="computer-window-help"
          onPointerDown={(event) => geometry.pointerDown(event, { kind: "move" })} {...pointer}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPresentation(minimized ? "window" : "fullscreen"); }
            else geometry.moveKey(event);
          }} onDoubleClick={() => setPresentation(minimized ? "window" : "fullscreen")}>
          {!minimized && <WindowIcon name="grip" />}
          <BotFace character={character} size={24} state={holding ? "held" : "idle"} />
          <h2>{botName}’s computer</h2>
        </div>
        {minimized ? <button type="button" className="window-button" aria-label="Restore computer window" onClick={() => setPresentation("window")}><WindowIcon name="restore" /></button> : <>
          <button type="button" className="window-button" aria-label="Minimize computer window" disabled={state.kind === "requesting" || state.kind === "lost"} onClick={minimize}><WindowIcon name="minimize" /></button>
          <button type="button" className="window-button" aria-label="Open full screen" onClick={() => setPresentation("fullscreen")}><WindowIcon name="expand" /></button>
        </>}
        <button type="button" className="window-button" aria-label="Close the screen" onClick={onClose}><WindowIcon name="close" /></button>
        <span className="visually-hidden" id="computer-window-help">Drag to move, or use arrow keys. {minimized ? "Press Enter or double-click to restore." : "Press Enter or double-click for full screen."}</span>
      </div>}
      <p key="status" className={fullScreen ? "scr-state" : "visually-hidden"} role="status">{topLine(state) ?? "Watch your bot work. Take over whenever you need."}</p>
      <div className="scr-mid" key="stream" hidden={minimized}>
        {mode !== null && <ScreenStream key={mode} botId={botId} mode={mode} dispatch={dispatch} />}
        <Message state={state} dispatch={dispatch} />
      </div>
      <div className="scr-low" key="controls" hidden={minimized}>
        {state.kind === "controlling" && hasTouchKeyboard && <TouchControls stream={state.stream} />}
        <ControlPill state={state} dispatch={dispatch} floating={!fullScreen} />
        <p className="scr-hint">{holding ? compact ? "Leaving this view gives control back." : "Use your mouse and keyboard. Give back when you’re ready." : compact ? "Pinch to zoom. Rotate for a larger view." : "Take control to click, type, or sign in."}</p>
      </div>
      {!fullScreen && !minimized && edges.map((edge) => <div key={edge} className="window-resize" data-edge={edge}
        role={edge === "se" ? "slider" : undefined} tabIndex={edge === "se" ? 0 : undefined}
        aria-label={edge === "se" ? "Resize computer window" : undefined} aria-valuemin={edge === "se" ? 384 : undefined}
        aria-valuemax={edge === "se" ? Math.floor(geometry.maxWidth) : undefined} aria-valuenow={edge === "se" ? Math.round(geometry.rect.width) : undefined}
        onPointerDown={(event) => geometry.pointerDown(event, { kind: "resize", edge })} {...pointer} onKeyDown={geometry.resizeKey}>
        {edge === "se" && <WindowIcon name="resize" />}
      </div>)}
    </section>
  );
}
