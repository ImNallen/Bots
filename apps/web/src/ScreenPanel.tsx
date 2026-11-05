import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import RFB from "@novnc/novnc";
import { useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from "react";

type ScreenState = "connecting" | "live" | "ended";

const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 800;
const RENEW_MS = 60_000;
const TAP_SLOP_PX = 10;
const TOUCH_SCROLL_FACTOR = 2;
const NAMED_KEYS = new Set(["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
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

function ScreenView({ botId, onState, children }: { botId: string; onState: (state: ScreenState) => void; children?: ReactNode }) {
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = target.current;
    if (element === null) {
      return undefined;
    }
    onState("connecting");
    const rfb = new RFB(element, socketUrl(`/screens/${encodeURIComponent(botId)}`), { shared: true });
    // This stays on during a take-over. Input goes through its own socket to one page, never through this stream.
    rfb.viewOnly = true;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    const onConnect = () => onState("live");
    const onDisconnect = () => onState("ended");
    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect);
    return () => {
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect);
      rfb.disconnect();
    };
  }, [botId, onState]);

  return (
    <div className="screen-view">
      <div ref={target} aria-label="This bot's screen" />
      {children}
    </div>
  );
}

type Send = (event: Record<string, unknown>) => void;

// While control is true the owner holds the screen. Leaving this state for any reason gives it back, so hiding the screen
// or leaving the page does not keep the bot waiting.
function useTakeover(args: { botId: Id<"bots">; control: boolean; onEnded: () => void }): Send | null {
  const { botId, control, onEnded } = args;
  const takeOver = useMutation(api.bots.takeOver);
  const release = useMutation(api.bots.releaseTakeover);
  const socket = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!control) {
      return undefined;
    }
    let cancelled = false;
    const renew = setInterval(() => {
      takeOver({ botId }).catch(() => {});
    }, RENEW_MS);
    takeOver({ botId }).then(
      () => {
        if (cancelled) {
          return;
        }
        const input = new WebSocket(socketUrl(`/screens/${encodeURIComponent(botId)}/input`));
        socket.current = input;
        input.addEventListener("open", () => setConnected(true));
        input.addEventListener("close", () => {
          if (!cancelled) {
            setConnected(false);
            onEnded();
          }
        });
      },
      () => onEnded(),
    );
    return () => {
      cancelled = true;
      clearInterval(renew);
      socket.current?.close();
      socket.current = null;
      setConnected(false);
      release({ botId }).catch(() => {});
    };
  }, [botId, control, onEnded, release, takeOver]);

  const send = useCallback<Send>((event) => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify(event));
    }
  }, []);
  return connected ? send : null;
}

function InputSurface({ send }: { send: Send }) {
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  function toScreen(event: { clientX: number; clientY: number; currentTarget: HTMLElement }) {
    const box = event.currentTarget.getBoundingClientRect();
    const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
    return {
      x: clamp(((event.clientX - box.left) / box.width) * SCREEN_WIDTH, SCREEN_WIDTH),
      y: clamp(((event.clientY - box.top) / box.height) * SCREEN_HEIGHT, SCREEN_HEIGHT),
    };
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, y: event.clientY, moved: false };
    // A touch is a tap or a scroll, and only its end can say which. A mouse button means a press now.
    if (event.pointerType === "mouse") {
      send({ kind: "pointer", action: "move", ...toScreen(event) });
      send({ kind: "pointer", action: "down", ...toScreen(event) });
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse") {
      send({ kind: "pointer", action: "move", ...toScreen(event) });
      return;
    }
    const begun = start.current;
    if (begun === null) {
      return;
    }
    const dx = begun.x - event.clientX;
    const dy = begun.y - event.clientY;
    if (!begun.moved && Math.hypot(dx, dy) < TAP_SLOP_PX) {
      return;
    }
    begun.moved = true;
    begun.x = event.clientX;
    begun.y = event.clientY;
    send({ kind: "scroll", ...toScreen(event), dx: dx * TOUCH_SCROLL_FACTOR, dy: dy * TOUCH_SCROLL_FACTOR });
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const begun = start.current;
    start.current = null;
    if (event.pointerType === "mouse") {
      send({ kind: "pointer", action: "up", ...toScreen(event) });
    } else if (begun !== null && !begun.moved) {
      send({ kind: "pointer", action: "move", ...toScreen(event) });
      send({ kind: "pointer", action: "down", ...toScreen(event) });
      send({ kind: "pointer", action: "up", ...toScreen(event) });
    }
  }

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    send({ kind: "scroll", ...toScreen(event), dx: event.deltaX, dy: event.deltaY });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (NAMED_KEYS.has(event.key)) {
      event.preventDefault();
      send({ kind: "key", key: event.key });
    } else if (event.key.length === 1) {
      event.preventDefault();
      send({ kind: "text", text: event.key });
    }
  }

  return (
    <div
      className="screen-input"
      role="application"
      aria-label="Control this screen"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
    />
  );
}

function TypingBox({ send }: { send: Send }) {
  const composing = useRef(false);

  function flush(element: HTMLInputElement) {
    if (element.value !== "") {
      send({ kind: "text", text: element.value });
      element.value = "";
    }
  }

  // A phone keyboard builds a word through composition, and changing the box during that garbles the word. So the text
  // goes to the page when the word is done. The box then empties, so a password never sits in it or in the chat.
  return (
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
        if (NAMED_KEYS.has(event.key)) {
          event.preventDefault();
          flush(event.currentTarget);
          send({ kind: "key", key: event.key });
        }
      }}
    />
  );
}

function TakeoverControls({ send, onGiveBack }: { send: Send; onGiveBack: () => void }) {
  const [url, setUrl] = useState("https://");

  function go(event: FormEvent) {
    event.preventDefault();
    if (URL.canParse(url) && /^https?:\/\//i.test(url)) {
      send({ kind: "navigate", url });
    }
  }

  return (
    <div className="screen-controls">
      <form className="screen-url" onSubmit={go}>
        <input
          aria-label="Address"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button type="submit">Go</button>
      </form>
      <TypingBox send={send} />
      <div className="screen-keys" role="group" aria-label="Keys">
        {KEY_BAR.map(([label, key]) => (
          <button key={key} type="button" aria-label={key} onClick={() => send({ kind: "key", key })}>
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
  const endControl = useCallback(() => setControl(false), []);
  const send = useTakeover({ botId, control: open && control, onEnded: endControl });

  return (
    <section className="screen-panel">
      <div className="screen-head">
        <button
          type="button"
          onClick={() => {
            setOpen((value) => !value);
            setControl(false);
          }}
        >
          {open ? "Hide screen" : "Watch screen"}
        </button>
        {open && !control && state === "live" && (
          <button type="button" onClick={() => setControl(true)}>
            Take over
          </button>
        )}
        {open && (
          <span className="screen-status" role="status">
            {control ? "You control this screen. The bot waits before its next tool." : STATUS[state]}
          </span>
        )}
        {open && state === "ended" && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        )}
      </div>
      {open && (
        <ScreenView key={attempt} botId={botId} onState={setState}>
          {send !== null && <InputSurface send={send} />}
        </ScreenView>
      )}
      {send !== null && <TakeoverControls send={send} onGiveBack={endControl} />}
    </section>
  );
}
