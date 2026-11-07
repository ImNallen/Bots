import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { Link, useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { FACE_STATES, useShownActivity } from "./activity.ts";
import { BotFace } from "./BotFace.tsx";
import { ChatItem } from "./ChatItem.tsx";
import { characterOf, tintOf, type Character } from "./character.ts";
import { composerView, heldRunEnded, type HeldSend } from "./composerState.ts";
import { conversationItems } from "./conversation.ts";
import { Icon } from "./Icon.tsx";
import { InfoPanel } from "./InfoPanel.tsx";
import type { ProfileEdits } from "./profileEdits.ts";
import { browserTimeZone } from "./routines.ts";
import { ScreenPanel } from "./ScreenPanel.tsx";
import { NotFoundNotice, ProblemNotice, errorMessage } from "./session.tsx";
import { useIsPhone } from "./useIsPhone.ts";

const STICK_TO_BOTTOM_PX = 80;
const NO_ROW = { activity: { kind: "idle" }, takeoverUntil: null } as const;

function fitToContent(field: HTMLTextAreaElement | null) {
  if (field !== null) {
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }
}

function Composer(props: { botId: Id<"bots">; threadId: Id<"threads">; botName: string }) {
  const { botId, threadId, botName } = props;
  const send = useMutation(api.threads.send);
  const requestCancel = useMutation(api.runs.requestCancel);
  const activeRun = useQuery(api.threads.activeRun, { botId }) ?? null;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [held, setHeld] = useState<HeldSend>(null);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const view = composerView({ activeRun, held, botName });

  useLayoutEffect(() => fitToContent(field.current), [text]);
  useEffect(() => {
    const refit = () => fitToContent(field.current);
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, []);

  async function deliver() {
    setSending(true);
    setError(null);
    try {
      await send({ threadId, text });
      setText("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSending(false);
    }
  }

  const activeRunId = activeRun?._id ?? null;
  useEffect(() => {
    if (heldRunEnded(held, activeRunId)) {
      setHeld(null);
      void deliver();
    }
  }, [held, activeRunId]);

  async function stopThenSend(runId: Id<"runs">) {
    setError(null);
    setHeld({ runId });
    try {
      await requestCancel({ runId });
    } catch (failure) {
      setHeld(null);
      setError(errorMessage(failure));
    }
  }

  async function submit() {
    if (text.trim() === "" || sending || !view.sendOffered) {
      return;
    }
    await (activeRun === null ? deliver() : stopThenSend(activeRun._id));
  }

  async function stop(runId: Id<"runs">) {
    setError(null);
    try {
      await requestCancel({ runId });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <label htmlFor="message" className="visually-hidden">
        Message
      </label>
      <div className="composer-row">
        <textarea
          id="message"
          ref={field}
          rows={1}
          value={text}
          disabled={view.fieldDisabled}
          readOnly={sending || held !== null}
          placeholder={view.placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {view.stop === "stopping" && (
          <button type="button" className="send send-stopping" disabled>
            Stopping
          </button>
        )}
        {view.stop === "offered" && activeRun !== null && (
          <button type="button" className="send send-stop" aria-label="Stop" onClick={() => void stop(activeRun._id)}>
            <Icon name="stop" />
          </button>
        )}
        {view.sendOffered && (
          <button type="submit" className="send" aria-label={sending ? "Sending" : "Send"} disabled={sending || text.trim() === ""}>
            <Icon name="up" />
          </button>
        )}
      </div>
      {view.note !== null && (
        <p className="composer-note" role="status">
          {view.note}
        </p>
      )}
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// The pane stays pinned to the newest output until the reader scrolls up, and returning to the bottom pins it again. Watching
// sizes rather than data also catches the composer growing, a phone's keyboard opening, and an error appearing in a card.
function useStickToBottom(mounted: boolean) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (stick.current) {
        element.scrollTop = element.scrollHeight;
      }
    });
    observer.observe(element);
    for (const child of element.children) {
      observer.observe(child);
    }
    return () => observer.disconnect();
  }, [mounted]);
  // A scroll event can arrive after new content did, so only moving up counts as leaving the bottom. Growth alone must not.
  const onScroll = () => {
    const element = scroller.current;
    if (element === null) {
      return;
    }
    const nearBottom = element.scrollHeight - element.clientHeight - element.scrollTop < STICK_TO_BOTTOM_PX;
    stick.current = nearBottom || (stick.current && element.scrollTop >= lastTop.current);
    lastTop.current = element.scrollTop;
  };
  return { scroller, onScroll };
}

function Conversation(props: { botId: Id<"bots">; threadId: Id<"threads">; botName: string; character: Character }) {
  const { botId, threadId, botName, character } = props;
  const timeline = useQuery(api.threads.timeline, { threadId });
  const pending = useQuery(api.approvals.pendingForThread, { threadId });
  const user = useQuery(api.users.current);
  const { scroller, onScroll } = useStickToBottom(timeline !== undefined);
  if (timeline === undefined) {
    return (
      <p className="session-status" role="status">
        Loading the conversation.
      </p>
    );
  }
  const items = conversationItems({
    timeline,
    pending: pending ?? [],
    now: Date.now(),
    locale: navigator.language,
    timeZone: user?.timeZone ?? browserTimeZone(),
  });
  return (
    <>
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <section className="conversation" aria-label="Conversation">
          {timeline.omittedOlder && <div className="system-line">Older messages are not shown.</div>}
          {timeline.runs.length === 0 && (
            <div className="start">
              <BotFace character={character} size={64} />
              <strong>{botName}</strong>
              <span>Send a message to start.</span>
            </div>
          )}
          {items.map((item) => (
            <ChatItem key={item.key} item={item} character={character} />
          ))}
        </section>
      </div>
      <div className="dock">
        <Composer botId={botId} threadId={threadId} botName={botName} />
      </div>
    </>
  );
}

function BotThread(props: { botId: Id<"bots">; botName: string; character: Character }) {
  const { botId, botName, character } = props;
  const ensureThread = useMutation(api.threads.ensureForBot);
  const [thread, setThread] = useState<
    { kind: "pending" } | { kind: "ready"; threadId: Id<"threads"> } | { kind: "failed"; message: string }
  >({ kind: "pending" });

  useEffect(() => {
    let cancelled = false;
    ensureThread({ botId }).then(
      (threadId) => {
        if (!cancelled) {
          setThread({ kind: "ready", threadId });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setThread({ kind: "failed", message: errorMessage(error) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [botId, ensureThread]);

  switch (thread.kind) {
    case "pending":
      return (
        <p className="session-status" role="status">
          Opening the conversation.
        </p>
      );
    case "failed":
      return <ProblemNotice title="Could not open the conversation" message={thread.message} />;
    case "ready":
      return <Conversation botId={botId} threadId={thread.threadId} botName={botName} character={character} />;
  }
}

function BotChat({ botId }: { botId: string }) {
  const bot = useQuery(api.bots.get, { botId });
  const rows = useQuery(api.bots.overview);
  const { info, screen, routines } = useSearch({ from: "/app/bots/$botId" });
  const navigate = useNavigate();
  const router = useRouter();
  const isPhone = useIsPhone();
  const [profileEdits, setProfileEdits] = useState<ProfileEdits>({});
  const activity = useShownActivity(rows?.find((row) => row._id === botId) ?? NO_ROW).kind;
  if (bot === undefined) {
    return (
      <p className="session-status" role="status">
        Loading the bot.
      </p>
    );
  }
  if (bot === null) {
    return <NotFoundNotice title="Bot not found" />;
  }
  const params = { botId };
  const character = characterOf(bot);
  // The badge belongs in the list, where it marks one bot among many.
  const faceState = activity === "needsApproval" ? "idle" : FACE_STATES[activity];

  // On a phone the panel is a page of its own, so it takes a history entry and the back gesture leaves it.
  const openInfo = () => void navigate({ to: "/bots/$botId", params, search: { info: true }, replace: !isPhone });
  const closeInfo = () => {
    if (isPhone && router.history.canGoBack()) {
      router.history.back();
    } else {
      void navigate({ to: "/bots/$botId", params, search: {}, replace: true });
    }
  };

  // A history entry at every width, because a browser's back action should leave the view and not the bot.
  const openScreen = () => void navigate({ to: "/bots/$botId", params, search: (previous) => ({ ...previous, screen: true }) });
  const closeScreen = () => {
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      void navigate({ to: "/bots/$botId", params, search: ({ info: wasInfo }) => (wasInfo === true ? { info: true } : {}), replace: true });
    }
  };

  return (
    <div className="tint bot-page" {...tintOf(character.color)}>
      <div className="chat" inert={isPhone && info === true}>
        <header className="chat-head">
          <Link to="/" className="round chat-back" aria-label="Your bots">
            <Icon name="back" />
          </Link>
          <button
            type="button"
            className="pill"
            aria-expanded={info === true}
            aria-label={`About ${bot.name}`}
            onClick={info === true ? closeInfo : openInfo}
          >
            <BotFace character={character} size={isPhone ? 26 : 20} state={faceState} />
            <span className="pill-who">
              <span>{bot.name}</span>
              {bot.title !== undefined && <small>{bot.title}</small>}
            </span>
          </button>
          {isPhone ? (
            <button type="button" className="round chat-screen" aria-label={`${bot.name}'s screen`} onClick={openScreen}>
              <Icon name="screen" />
            </button>
          ) : (
            <button type="button" className="pill pill-plain chat-screen" onClick={openScreen}>
              Screen
            </button>
          )}
        </header>
        <BotThread botId={bot._id} botName={bot.name} character={character} />
      </div>
      {info === true && (
        <InfoPanel
          bot={bot}
          faceState={faceState}
          revealRoutines={routines === true}
          profileEdits={profileEdits}
          onProfileEditsChange={setProfileEdits}
          onClose={closeInfo}
          onOpenScreen={openScreen}
        />
      )}
      {screen === true && <ScreenPanel botId={bot._id} botName={bot.name} onClose={closeScreen} />}
    </div>
  );
}

export function BotPage() {
  const { botId } = useParams({ from: "/app/bots/$botId" });
  // Keyed, so a draft, a confirmation, or a take-over of one bot never carries over to the next.
  return <BotChat key={botId} botId={botId} />;
}
