import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import RFB from "@novnc/novnc";
import { useConvex, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { KEY_KEYSYMS, isNamedKey, planTyping, type NamedKey } from "./keysyms.ts";

type ScreenState = "connecting" | "live" | "ended";
type StreamMode = "watch" | "control";

const RENEW_MS = 60_000;
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

function ScreenView(props: {
  botId: string;
  mode: StreamMode;
  onState: (state: ScreenState) => void;
  onScreen: (screen: RFB | null) => void;
}) {
  const { botId, mode, onState, onScreen } = props;
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = target.current;
    if (element === null) {
      return undefined;
    }
    onState("connecting");
    const path = `/screens/${encodeURIComponent(botId)}${mode === "control" ? "/input" : ""}`;
    const rfb = new RFB(element, socketUrl(path), { shared: true });
    rfb.viewOnly = mode === "watch";
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    const onConnect = () => {
      onState("live");
      onScreen(rfb);
      if (mode === "control") {
        // So a real keyboard reaches the desktop at once, and a shortcut does not reach this page instead.
        rfb.focus({ preventScroll: true });
      }
    };
    const onDisconnect = () => {
      onScreen(null);
      onState("ended");
    };
    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect);
    return () => {
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect);
      onScreen(null);
      rfb.disconnect();
    };
  }, [botId, mode, onState, onScreen]);

  return (
    <div className={mode === "control" ? "screen-view screen-view-control" : "screen-view"}>
      <div ref={target} aria-label="This bot's screen" />
    </div>
  );
}

// While wanted is true the owner holds the screen. Leaving this state for any reason gives it back, so hiding the screen or
// leaving the page does not keep the bot waiting.
function useTakeover(args: { botId: Id<"bots">; wanted: boolean; onEnded: () => void }) {
  const { botId, wanted, onEnded } = args;
  const convex = useConvex();
  const takeOver = useMutation(api.bots.takeOver);
  const release = useMutation(api.bots.releaseTakeover);
  const [granted, setGranted] = useState(false);
  const until = useRef(0);
  const replaced = useRef(false);

  useEffect(() => {
    if (!wanted) {
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
    takeOver({ botId }).then((value) => {
      until.current = value;
      if (!cancelled) {
        setGranted(true);
      }
    }, onEnded);
    return () => {
      cancelled = true;
      clearInterval(renew);
      setGranted(false);
      if (!replaced.current) {
        release({ botId }).catch(() => {});
      }
    };
  }, [botId, wanted, onEnded, release, takeOver]);

  // A newer tab of this owner ends this stream by taking over. It renewed the take-over before that, so a value that is not ours
  // says so, and giving back now would take the screen from that tab.
  const streamEnded = useCallback(() => {
    convex
      .query(api.bots.get, { botId })
      .then((bot) => {
        const current = bot?.takeoverUntil ?? 0;
        replaced.current = current !== 0 && current !== until.current;
      })
      .catch(() => {})
      .finally(onEnded);
  }, [botId, convex, onEnded]);

  return { granted, streamEnded };
}

const REFUSALS = {
  "no-key": "That character has no key on the screen, so nothing was sent. It is still in this box.",
  "keyboard-full": "The screen's keyboard has no room for another new character, so nothing was sent. Give back and take over again to type it.",
} as const;

function TypingBox({ screen }: { screen: RFB }) {
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
      screen.sendKey(keysym, null);
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
        className="screen-typing"
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
            event.preventDefault();
            flush(event.currentTarget);
            screen.sendKey(KEY_KEYSYMS[event.key], null);
          }
        }}
      />
      {refusal !== null && (
        <p className="screen-refusal" role="alert">
          {REFUSALS[refusal]}
        </p>
      )}
    </>
  );
}

function TakeoverControls({ screen, onGiveBack }: { screen: RFB; onGiveBack: () => void }) {
  return (
    <div className="screen-controls">
      <TypingBox screen={screen} />
      <div className="screen-keys" role="group" aria-label="Keys">
        {KEY_BAR.map(([label, key]: readonly [string, NamedKey]) => (
          <button key={key} type="button" aria-label={key} onClick={() => screen.sendKey(KEY_KEYSYMS[key], null)}>
            {label}
          </button>
        ))}
      </div>
      <div>
        <button type="button" onClick={onGiveBack}>
          Give back to the bot
        </button>
      </div>
    </div>
  );
}

const STATUS: Record<ScreenState, string> = {
  connecting: "Connecting to the screen.",
  live: "Live. You are watching, and the bot keeps working.",
  ended: "The screen is not connected. The computer may be starting.",
};

export function ScreenPanel({ botId }: { botId: Id<"bots"> }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ScreenState>("connecting");
  const [control, setControl] = useState(false);
  const [screen, setScreen] = useState<RFB | null>(null);
  const [takeoverEnded, setTakeoverEnded] = useState(false);
  const endControl = useCallback(() => setControl(false), []);
  const { granted, streamEnded } = useTakeover({ botId, wanted: open && control, onEnded: endControl });
  const mode: StreamMode = granted ? "control" : "watch";

  const onState = useCallback(
    (next: ScreenState) => {
      setState(next);
      // Only the stream can end a take-over here. Giving back removes the listener first.
      if (mode === "control" && next === "ended") {
        setTakeoverEnded(true);
        streamEnded();
      }
    },
    [mode, streamEnded],
  );

  return (
    <section className="screen-panel">
      <div className="screen-head">
        <button
          type="button"
          onClick={() => {
            setOpen((value) => !value);
            setControl(false);
            setTakeoverEnded(false);
          }}
        >
          {open ? "Hide screen" : "Watch screen"}
        </button>
        {open && !control && state === "live" && (
          <button
            type="button"
            onClick={() => {
              setTakeoverEnded(false);
              setControl(true);
            }}
          >
            Take over
          </button>
        )}
        {open && (
          <span className="screen-status" role="status">
            {mode === "control" && state === "live"
              ? "You control this screen. The bot waits before its next tool."
              : takeoverEnded && state === "live"
                ? "Your take-over ended. You are watching, and the bot keeps working."
                : STATUS[state]}
          </span>
        )}
        {open && mode === "watch" && state === "ended" && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        )}
      </div>
      {open && <ScreenView key={`${attempt}-${mode}`} botId={botId} mode={mode} onState={onState} onScreen={setScreen} />}
      {mode === "control" && screen !== null && <TakeoverControls screen={screen} onGiveBack={endControl} />}
    </section>
  );
}
