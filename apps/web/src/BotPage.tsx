import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { Link, useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { FACE_STATES } from "./activity.ts";
import { BotFace } from "./BotFace.tsx";
import { ChatItem } from "./ChatItem.tsx";
import { characterOf, tintOf, type Character } from "./character.ts";
import { conversationItems, isActive, type Timeline } from "./conversation.ts";
import { Icon } from "./Icon.tsx";
import { InfoPanel } from "./InfoPanel.tsx";
import { ScreenPanel } from "./ScreenPanel.tsx";
import { ProblemNotice, errorMessage } from "./session.tsx";
import { useIsPhone } from "./useIsPhone.ts";

const STICK_TO_BOTTOM_PX = 80;

function fitToContent(field: HTMLTextAreaElement | null) {
  if (field !== null) {
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }
}

function Composer(props: { threadId: Id<"threads">; activeRun: Timeline["runs"][number] | undefined; botName: string }) {
  const { threadId, activeRun, botName } = props;
  const send = useMutation(api.threads.send);
  const requestCancel = useMutation(api.runs.requestCancel);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => fitToContent(field.current), [text]);
  useEffect(() => {
    const refit = () => fitToContent(field.current);
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, []);

  async function submit() {
    if (text.trim() === "" || sending || activeRun !== undefined) {
      return;
    }
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

  function action() {
    if (activeRun === undefined) {
      return (
        <button type="submit" className="send" aria-label={sending ? "Sending" : "Send"} disabled={sending || text.trim() === ""}>
          <Icon name="up" />
        </button>
      );
    }
    if (activeRun.cancelRequested) {
      return (
        <button type="button" className="send send-stopping" disabled>
          Stopping
        </button>
      );
    }
    return (
      <button type="button" className="send send-stop" aria-label="Stop" onClick={() => void stop(activeRun._id)}>
        <Icon name="stop" />
      </button>
    );
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
          disabled={activeRun !== undefined}
          placeholder={activeRun !== undefined ? `${botName} is working` : `Message ${botName}`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {action()}
      </div>
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

function Conversation(props: { threadId: Id<"threads">; botId: Id<"bots">; botName: string; character: Character }) {
  const { threadId, botId, botName, character } = props;
  const timeline = useQuery(api.threads.timeline, { threadId });
  const pending = useQuery(api.approvals.pendingForThread, { threadId });
  const { scroller, onScroll } = useStickToBottom(timeline !== undefined);
  if (timeline === undefined) {
    return (
      <p className="session-status" role="status">
        Loading the conversation.
      </p>
    );
  }
  const items = conversationItems({ timeline, pending: pending ?? [], now: Date.now(), locale: navigator.language });
  return (
    <>
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <ScreenPanel botId={botId} />
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
        <Composer threadId={threadId} activeRun={timeline.runs.find(isActive)} botName={botName} />
      </div>
    </>
  );
}

function BotThread(props: { botId: Id<"bots">; botName: string; character: Character }) {
  const { botId } = props;
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
      return <Conversation threadId={thread.threadId} {...props} />;
  }
}

function BotChat({ botId }: { botId: string }) {
  const bot = useQuery(api.bots.get, { botId });
  const rows = useQuery(api.bots.overview);
  const { info } = useSearch({ from: "/app/bots/$botId" });
  const navigate = useNavigate();
  const router = useRouter();
  const isPhone = useIsPhone();
  if (bot === undefined) {
    return (
      <p className="session-status" role="status">
        Loading the bot.
      </p>
    );
  }
  if (bot === null) {
    return (
      <section className="notice">
        <h2>Bot not found</h2>
        <p>
          <Link to="/">Go to your bots</Link>
        </p>
      </section>
    );
  }
  const params = { botId };
  const character = characterOf(bot);
  const activity = rows?.find((row) => row._id === bot._id)?.activity.kind ?? "idle";
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

  // The chat stays mounted behind a phone's info page, because unmounting it would give back a take-over.
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
            <span>{bot.name}</span>
          </button>
        </header>
        <BotThread botId={bot._id} botName={bot.name} character={character} />
      </div>
      {info === true && <InfoPanel bot={bot} faceState={faceState} onClose={closeInfo} />}
    </div>
  );
}

export function BotPage() {
  const { botId } = useParams({ from: "/app/bots/$botId" });
  // Keyed, so a draft, a confirmation, or a take-over of one bot never carries over to the next.
  return <BotChat key={botId} botId={botId} />;
}
