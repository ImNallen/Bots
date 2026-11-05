import RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";

type ScreenState = "connecting" | "live" | "ended";

function ScreenView({ botId, onState }: { botId: string; onState: (state: ScreenState) => void }) {
  const target = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = target.current;
    if (element === null) {
      return undefined;
    }
    onState("connecting");
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const rfb = new RFB(element, `${scheme}://${window.location.host}/screens/${encodeURIComponent(botId)}`, { shared: true });
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

  return <div ref={target} className="screen-view" aria-label="This bot's screen" />;
}

const STATUS: Record<ScreenState, string> = {
  connecting: "Connecting to the screen.",
  live: "Live. You are watching, and the bot keeps working.",
  ended: "The screen is not connected. The computer may be starting.",
};

export function ScreenPanel({ botId }: { botId: string }) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ScreenState>("connecting");

  return (
    <section className="screen-panel">
      <div className="screen-head">
        <button type="button" onClick={() => setOpen((value) => !value)}>
          {open ? "Hide screen" : "Watch screen"}
        </button>
        {open && (
          <span className="screen-status" role="status">
            {STATUS[state]}
          </span>
        )}
        {open && state === "ended" && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        )}
      </div>
      {open && <ScreenView key={attempt} botId={botId} onState={setState} />}
    </section>
  );
}
