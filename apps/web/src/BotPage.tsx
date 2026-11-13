import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { Link, useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { faceStateFor, useShownActivity } from "./activity.ts";
import { BotFace } from "./BotFace.tsx";
import { ChatFeed } from "./ChatFeed.tsx";
import { StopReplyButton } from "./StopReplyButton.tsx";
import { characterOf, tintOf, type Character } from "./character.ts";
import { composerView, heldRunEnded, type HeldSend } from "./composerState.ts";
import { conversationItems, isActive } from "./conversation.ts";
import { Icon } from "./Icon.tsx";
import { InfoPanel } from "./InfoPanel.tsx";
import type { ProfileEdits } from "./profileEdits.ts";
import { browserTimeZone } from "./routines.ts";
import { ScreenPanel } from "./ScreenPanel.tsx";
import { NotFoundNotice, ProblemNotice, errorMessage } from "./session.tsx";
import { useIsPhone } from "./useIsPhone.ts";
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS } from "@bots/convex/attachmentFiles";
import { AttachmentDrafts, useDraftAttachments } from "./Attachments.tsx";
import { useVoiceInput } from "./useVoiceInput.ts";
import { appendTranscript } from "./voiceAudio.ts";
import { VoiceInput } from "./VoiceInput.tsx";
import computerUrl from "./assets/ui/window-computer.svg";

const ScreenCoversChat = createContext(false);

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
  const fileInput = useRef<HTMLInputElement>(null);
  const attachments = useDraftAttachments(botId);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const view = composerView({ activeRun, held, botName });
  const search = useSearch({ from: "/app/bots/$botId" });
  const screenCoversChat = useContext(ScreenCoversChat);
  const isPhone = useIsPhone();
  const key = useQuery(api.credentials.status, {});
  const voice = useVoiceInput({ botId, onTranscript: (transcript) => setText((current) => appendTranscript(current, transcript)), visible: !screenCoversChat && (!isPhone || (search.info !== true && search.routines !== true)) });
  const locked = view.fieldDisabled || sending || held !== null;
  const canSend = (text.trim() !== "" || attachments.ids.length > 0) && attachments.ready && !voice.pending;
  const voiceActive = voice.state.kind !== "idle" && voice.state.kind !== "review";
  const voiceHint = !voice.supported ? "Voice input needs HTTPS and a browser with microphone support." : !key?.configured ? "Add a Mistral key in Settings to use voice input." : "Record a message";

  useLayoutEffect(() => fitToContent(field.current), [text, voice.state.kind]);
  useEffect(() => {
    const refit = () => fitToContent(field.current);
    window.addEventListener("resize", refit);
    return () => window.removeEventListener("resize", refit);
  }, []);

  async function deliver() {
    setSending(true);
    setError(null);
    try {
      await send({ threadId, text, ...(attachments.ids.length === 0 ? {} : { attachmentIds: attachments.ids }) });
      setText("");
      voice.cancel();
      attachments.sent();
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
    if (!canSend || sending || !view.sendOffered) {
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
    <form className="composer" onSubmit={handleSubmit} data-file-drag={draggingFiles} data-voice={voiceActive ? "active" : voice.state.kind === "review" ? "review" : undefined}
      onDragOver={(event) => {
        if (!locked && !voice.pending && event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDraggingFiles(true); }
      }}
      onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDraggingFiles(false); }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault(); setDraggingFiles(false);
        if (!locked && !voice.pending) attachments.add(event.dataTransfer.files);
      }}
    >
      <label htmlFor="message" className="visually-hidden">
        Message
      </label>
      <div className="composer-row">
        <AttachmentDrafts items={attachments.items} disabled={locked || voice.pending} onRemove={attachments.remove} onRetry={(item) => void attachments.retry(item)} />
        <textarea
          id="message"
          ref={field}
          rows={1}
          value={text}
          disabled={view.fieldDisabled}
          readOnly={sending || held !== null}
          placeholder={view.placeholder}
          onChange={(event) => { setText(event.target.value); if (voice.state.kind === "review") voice.cancel(); }}
          onKeyDown={handleKeyDown}
          onPaste={(event) => {
            if (!locked && !voice.pending && event.clipboardData.files.length > 0) { event.preventDefault(); attachments.add(event.clipboardData.files); }
          }}
        />
        {voice.state.kind !== "idle" && voice.state.kind !== "review" && <VoiceInput state={voice.state} onCancel={voice.cancel} onFinish={voice.finish} onRetry={voice.retry} retryDisabled={locked || !key?.configured} />}
        {!voiceActive && <div className="composer-toolbar">
          <input ref={fileInput} className="visually-hidden" type="file" accept={ATTACHMENT_ACCEPT} multiple tabIndex={-1} aria-label="Choose attachments" disabled={locked || voice.pending}
            onChange={(event) => { if (event.target.files !== null) attachments.add(event.target.files); event.target.value = ""; }} />
          <button type="button" className="round composer-attach" aria-label="Attach files" title="Attach images, PDFs, or text/code files" disabled={locked || voice.pending || attachments.items.length >= MAX_ATTACHMENTS} onClick={() => fileInput.current?.click()}>
            <Icon name="attachment" />
          </button>
          <button type="button" className="round composer-mic" aria-label="Start voice input" title={voiceHint} disabled={locked || voice.pending || !voice.supported || !key?.configured} onClick={() => void voice.start()}>
            <Icon name="mic" />
          </button>
          {voice.state.kind === "review" && <span className="voice-added" role="status"><span aria-hidden="true">✓</span><span>Added to draft</span></span>}
          <div className="composer-send">
        {view.stop !== "none" && activeRun !== null && (
          <StopReplyButton stopping={view.stop === "stopping"} onStop={() => void stop(activeRun._id)} />
        )}
        {view.sendOffered && (
          <button type="submit" className={voice.state.kind === "review" ? "send voice-action voice-primary" : "send"} aria-label={sending ? "Sending" : "Send"} disabled={sending || !canSend}>
            {voice.state.kind === "review" ? "Send" : <Icon name="up" />}
          </button>
        )}
          </div>
        </div>}
      </div>
      {attachments.problem !== null && <p className="error composer-note" role="alert">{attachments.problem}</p>}
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
  const send = useMutation(api.threads.send);
  const latestRun = timeline?.runs.at(-1);
  const previousRun = useRef<{ id: string; active: boolean } | null>(null);
  const [completedRun, setCompletedRun] = useState<string | null>(null);
  useEffect(() => {
    const completed = latestRun?.state.kind === "done" && previousRun.current?.id === latestRun._id && previousRun.current.active;
    previousRun.current = latestRun ? { id: latestRun._id, active: isActive(latestRun) } : null;
    setCompletedRun(completed && latestRun ? latestRun._id : null);
    if (!completed) return;
    const timer = window.setTimeout(() => setCompletedRun(null), 1200);
    return () => window.clearTimeout(timer);
  }, [latestRun?._id, latestRun?.state.kind]);
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
  const completedReply = completedRun === latestRun?._id
    ? latestRun.events.findLast(({ body }) => body.kind === "assistantTurn" && body.text.trim() !== "")
    : undefined;
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
          <ChatFeed items={items} character={character} botName={botName} completedReplyKey={completedReply ? `${completedReply._id}:text` : undefined}
            onRetry={latestRun && !isActive(latestRun) ? async (text) => { await send({ threadId, text }); } : undefined} />
        </section>
      </div>
      <div className="dock">
        <Composer botId={botId} threadId={threadId} botName={botName} />
        <p className="composer-disclaimer">{botName} can make mistakes. Review anything important.</p>
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
  const chat = useRef<HTMLDivElement>(null);
  const [screenCoversChat, setScreenCoversChat] = useState(false);
  const [screenRequest, setScreenRequest] = useState(0);
  const [profileEdits, setProfileEdits] = useState<ProfileEdits>({});
  const activity = useShownActivity(rows?.find((row) => row._id === botId) ?? NO_ROW);
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
  const faceState = faceStateFor(activity);

  // On a phone, opening the drawer takes a history entry so Back dismisses it.
  const openInfo = () => void navigate({ to: "/bots/$botId", params, search: (previous) => ({ ...previous, info: true }), replace: !isPhone });
  const closeInfo = () => {
    if (isPhone && router.history.canGoBack()) {
      router.history.back();
    } else {
      void navigate({ to: "/bots/$botId", params, search: screen === true ? { screen: true } : {}, replace: true });
    }
  };

  // A history entry at every width, because a browser's back action should leave the view and not the bot.
  const openScreen = () => {
    setScreenRequest((value) => value + 1);
    if (screen !== true) void navigate({ to: "/bots/$botId", params, search: (previous) => ({ ...previous, screen: true }) });
  };
  const closeScreen = () => {
    if (router.history.canGoBack()) {
      router.history.back();
    } else {
      void navigate({ to: "/bots/$botId", params, search: ({ info: wasInfo, routines: wasRoutines }) => ({ ...(wasInfo === true && { info: true }), ...(wasRoutines === true && { routines: true }) }), replace: true });
    }
  };

  return (
    <ScreenCoversChat.Provider value={screen === true && screenCoversChat}>
      <div className="tint bot-page" {...tintOf(character.color)}>
        <div className="chat" ref={chat} inert={isPhone && (info === true || routines === true)}>
          <header className="chat-head">
            <Link to="/" className="round chat-back" aria-label="Your bots">
              <Icon name="menu" />
            </Link>
            <button
              type="button"
              className="pill"
              aria-expanded={info === true || routines === true}
              aria-label={`About ${bot.name}`}
              onClick={info === true || routines === true ? closeInfo : openInfo}
            >
              <BotFace character={character} size={32} state={faceState} />
              <span className="pill-who">
                <span>{bot.name}</span>
              </span>
            </button>
            <button type="button" className="chat-computer" onClick={openScreen} aria-label="Open computer" aria-expanded={screen === true}>
              <span className="window-icon" style={{ maskImage: `url("${computerUrl}")` }} aria-hidden="true" />Computer
            </button>
          </header>
          <div className="chat-body">
            <BotThread botId={bot._id} botName={bot.name} character={character} />
          </div>
        </div>
        {(info === true || routines === true) && (
          <InfoPanel
            bot={bot}
            faceState={faceState}
            showRoutines={routines === true}
            profileEdits={profileEdits}
            onProfileEditsChange={setProfileEdits}
            onClose={closeInfo}
            onOpenScreen={openScreen}
            onShowChat={() => void navigate({ to: "/bots/$botId", params, search: { ...(screen === true && { screen: true }), ...(!isPhone && { info: true }) }, replace: true })}
            onComposeRoutine={() => {
              void navigate({ to: "/bots/$botId", params, search: screen === true ? { screen: true } : {}, replace: true });
              requestAnimationFrame(() => document.getElementById("message")?.focus());
            }}
            onShowRoutines={() => void navigate({ to: "/bots/$botId", params, search: (previous) => ({ ...previous, info: true, routines: true }), replace: true })}
          />
        )}
        {screen === true && <ScreenPanel botId={bot._id} botName={bot.name} character={character} chat={chat} openRequest={screenRequest} onCoverChange={setScreenCoversChat} onClose={closeScreen} />}
      </div>
    </ScreenCoversChat.Provider>
  );
}

export function BotPage() {
  const { botId } = useParams({ from: "/app/bots/$botId" });
  // Keyed, so a draft, a confirmation, or a take-over of one bot never carries over to the next.
  return <BotChat key={botId} botId={botId} />;
}
