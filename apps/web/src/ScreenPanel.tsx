import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import RFB from "@novnc/novnc";
import { useConvex, useMutation } from "convex/react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type Dispatch, type RefObject } from "react";
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
import { useHasCoarsePointer, useIsPhone } from "./useIsPhone.ts";

const RENEW_MS = 60_000;
// Matches .screen in styles.css, so a stream's letterbox does not show.
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
function useFitVisibleArea(view: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const visible = window.visualViewport;
    const element = view.current;
    if (visible === null || element === null) {
      return undefined;
    }
    const fit = () => {
      const zoomed = visible.scale > 1.01;
      element.style.top = zoomed ? "" : `${visible.offsetTop}px`;
      element.style.height = zoomed ? "" : `${visible.height}px`;
    };
    fit();
    visible.addEventListener("resize", fit);
    visible.addEventListener("scroll", fit);
    return () => {
      visible.removeEventListener("resize", fit);
      visible.removeEventListener("scroll", fit);
    };
  }, [view]);
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

function ControlPill({ state, dispatch }: { state: ScreenState; dispatch: Dispatch<ScreenEvent> }) {
  switch (state.kind) {
    case "watching":
    case "requesting":
      return (
        <div className="seg-big">
          <span>
            <Icon name="eye" />
            Watching
          </span>
          <button type="button" disabled={state.kind === "requesting"} onClick={() => dispatch({ type: "takeControl" })}>
            Take control
          </button>
        </div>
      );
    case "joining":
    case "controlling":
      return (
        <div className="seg-big">
          <span>You have control</span>
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
      return "The bot waits before its next tool";
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

export function ScreenPanel({ botId, botName, onClose }: { botId: Id<"bots">; botName: string; onClose: () => void }) {
  const [state, dispatch] = useReducer(screenReducer, INITIAL_SCREEN_STATE);
  useTakeover(botId, state, dispatch);
  const isPhone = useIsPhone();
  // Not the phone's width, because a phone on its side and a tablet are wider than that and still have no real keyboard.
  const hasTouchKeyboard = useHasCoarsePointer();
  const view = useRef<HTMLElement>(null);
  const [opener] = useState(() => document.activeElement);
  useFitVisibleArea(view);

  useEffect(() => {
    view.current?.focus({ preventScroll: true });
    return () => {
      if (opener instanceof HTMLElement) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [opener]);

  // During a take-over, Escape belongs to the desktop.
  const holding = holdsScreen(state);
  useEffect(() => {
    if (holding) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [holding, onClose]);

  const compact = isPhone || hasTouchKeyboard;
  const mode = streamFor(state);
  return (
    <section ref={view} className="screen" role="dialog" aria-modal="true" aria-label={`${botName}'s screen`} tabIndex={-1} data-compact={compact}>
      <div className="scr-top">
        <button type="button" className="scr-x" aria-label="Close the screen" onClick={onClose}>
          <Icon name={compact ? "back" : "shrink"} />
        </button>
        <span className="scr-state" role="status">
          {topLine(state)}
        </span>
      </div>
      <div className="scr-mid">
        {mode !== null && <ScreenStream key={mode} botId={botId} mode={mode} dispatch={dispatch} />}
        <Message state={state} dispatch={dispatch} />
      </div>
      <div className="scr-low">
        {state.kind === "controlling" && hasTouchKeyboard && <TouchControls stream={state.stream} />}
        <ControlPill state={state} dispatch={dispatch} />
      </div>
    </section>
  );
}
