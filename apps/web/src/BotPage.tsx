import { api } from "@bots/convex";
import type { Doc, Id } from "@bots/convex/dataModel";
import { Link, useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { FACE_STATES } from "./activity.ts";
import { BotFace, QueuedDots } from "./BotFace.tsx";
import { characterOf, tintOf } from "./character.ts";
import { Icon } from "./Icon.tsx";
import { InfoPanel } from "./InfoPanel.tsx";
import { ScreenPanel } from "./ScreenPanel.tsx";
import { ProblemNotice, errorMessage } from "./session.tsx";
import { useIsPhone } from "./useIsPhone.ts";

type Timeline = FunctionReturnType<typeof api.threads.timeline>;
type TimelineRun = Timeline["runs"][number];
type EventBody = Doc<"runEvents">["body"];
type AssistantTurn = Extract<EventBody, { kind: "assistantTurn" }>;
type ToolResult = Extract<EventBody, { kind: "toolResult" }>;

const STICK_TO_BOTTOM_PX = 80;

function isActive(run: TimelineRun): boolean {
  return run.state.kind === "queued" || run.state.kind === "running";
}

function argumentsSummary(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const first = Object.values(parsed).find((value) => typeof value === "string");
      if (first !== undefined) {
        return first;
      }
    }
  } catch {
    // A malformed call shows as it arrived, because the model has to correct exactly this text.
  }
  return raw;
}

// A person can only approve what they can read, so this shows every argument in full. A single string shows as it is, so a
// shell command keeps its line breaks.
function fullArguments(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const values = Object.values(parsed);
      if (values.length === 1 && typeof values[0] === "string") {
        return values[0];
      }
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // A malformed call shows as it arrived.
  }
  return raw;
}

function ApprovalButtons({ approvalId }: { approvalId: Id<"approvals"> }) {
  const decide = useMutation(api.approvals.decide);
  const [problem, setProblem] = useState<string | null>(null);
  const answer = (decision: "approved" | "denied") => {
    decide({ approvalId, decision }).catch((error: unknown) => setProblem(errorMessage(error)));
  };
  return (
    <div className="tool-approval" role="group" aria-label="This call needs your approval">
      <button type="button" className="btn btn-go" onClick={() => answer("approved")}>
        Approve
      </button>
      <button type="button" className="btn" onClick={() => answer("denied")}>
        Deny
      </button>
      {problem !== null && (
        <span className="error" role="alert">
          {problem}
        </span>
      )}
    </div>
  );
}

function ToolCallView(props: {
  call: AssistantTurn["toolCalls"][number];
  result: ToolResult | undefined;
  active: boolean;
  approvalId: Id<"approvals"> | undefined;
}) {
  const { call, result, active, approvalId } = props;
  const waiting = result === undefined && approvalId !== undefined;
  const status = result?.outcome ?? (waiting ? "needs approval" : active ? "running" : "no result");
  return (
    <div className="tool-call" data-outcome={status}>
      <div className="tool-call-head">
        <code className="tool-call-name">{call.name}</code>
        <code className="tool-call-args">{argumentsSummary(call.arguments)}</code>
        <span className="tool-call-status" role="status">
          {status}
        </span>
      </div>
      {waiting && (
        <>
          <pre className="tool-approval-args" aria-label="What this call will do">
            {fullArguments(call.arguments)}
          </pre>
          <ApprovalButtons approvalId={approvalId} />
        </>
      )}
      {result !== undefined && (
        <details>
          <summary>
            Output
            {result.exitCode !== undefined && `, exit code ${result.exitCode}`}
            {result.truncated && ", truncated"}
          </summary>
          <pre>{result.output === "" ? "(no output)" : result.output}</pre>
        </details>
      )}
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  return (
    <details className="reasoning">
      <summary>Reasoning</summary>
      <p className="message-text">{text}</p>
    </details>
  );
}

function RunView({ run, approvals }: { run: TimelineRun; approvals: Map<string, Id<"approvals">> }) {
  const active = isActive(run);
  const results = new Map(
    run.events
      .map((event) => event.body)
      .filter((body) => body.kind === "toolResult")
      .map((body) => [body.toolCallId, body]),
  );
  return (
    <>
      {run.events.map((event) => {
        const { body } = event;
        switch (body.kind) {
          case "userMessage":
            return (
              <p key={event._id} className="message message-user message-text">
                {body.text}
              </p>
            );
          case "assistantTurn":
            return (
              <div key={event._id} className="message message-assistant">
                {body.reasoning !== undefined && <Reasoning text={body.reasoning} />}
                {body.text !== "" && <p className="message-text">{body.text}</p>}
                {body.toolCalls.map((call) => (
                  <ToolCallView
                    key={call.id}
                    call={call}
                    result={results.get(call.id)}
                    active={active}
                    approvalId={approvals.get(`${run._id}:${call.id}`)}
                  />
                ))}
              </div>
            );
          case "toolResult":
            return null;
        }
      })}
      {run.stream !== null && (
        <div className="message message-assistant message-streaming" aria-live="polite">
          {run.stream.reasoning !== undefined && <Reasoning text={run.stream.reasoning} />}
          {run.stream.text === "" ? (
            <p className="muted">Thinking</p>
          ) : (
            <p className="message-text">{run.stream.text}</p>
          )}
        </div>
      )}
      {run.state.kind === "queued" && (
        <p className="muted run-waiting" role="status">
          <QueuedDots />
          Waiting to start.
        </p>
      )}
      {run.state.kind === "failed" && (
        <p className="error run-failure" role="alert">
          {run.state.reason}
        </p>
      )}
      {run.state.kind === "cancelled" && <p className="muted">Stopped.</p>}
    </>
  );
}

function Composer(props: { threadId: Id<"threads">; activeRun: TimelineRun | undefined }) {
  const { threadId, activeRun } = props;
  const send = useMutation(api.threads.send);
  const requestCancel = useMutation(api.runs.requestCancel);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <label htmlFor="message" className="visually-hidden">
        Message
      </label>
      <div className="composer-row">
        <textarea
          id="message"
          rows={1}
          value={text}
          disabled={activeRun !== undefined}
          placeholder={activeRun !== undefined ? "The bot is working." : "Message the bot"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {activeRun === undefined ? (
          <button type="submit" className="btn btn-go" disabled={sending || text.trim() === ""}>
            {sending ? "Sending" : "Send"}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={activeRun.cancelRequested}
            onClick={() => void stop(activeRun._id)}
          >
            {activeRun.cancelRequested ? "Stopping" : "Stop"}
          </button>
        )}
      </div>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// The pane stays pinned to the newest output until the reader scrolls up, and returning to the bottom pins it again.
function useStickToBottom(timeline: unknown, approvals: unknown) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && stick.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [timeline, approvals]);
  const onScroll = () => {
    const element = scroller.current;
    if (element !== null) {
      stick.current = element.scrollHeight - element.clientHeight - element.scrollTop < STICK_TO_BOTTOM_PX;
    }
  };
  return { scroller, onScroll };
}

function Conversation({ threadId, botId }: { threadId: Id<"threads">; botId: Id<"bots"> }) {
  const timeline = useQuery(api.threads.timeline, { threadId });
  const pending = useQuery(api.approvals.pendingForThread, { threadId });
  const approvals = new Map((pending ?? []).map((row) => [`${row.runId}:${row.toolCallId}`, row._id]));
  const { scroller, onScroll } = useStickToBottom(timeline, pending);
  if (timeline === undefined) {
    return (
      <p className="session-status" role="status">
        Loading the conversation.
      </p>
    );
  }
  const activeRun = timeline.runs.find(isActive);
  return (
    <>
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <ScreenPanel botId={botId} />
        <section className="conversation" aria-label="Conversation">
          {timeline.omittedOlder && <p className="muted">Older messages are not shown.</p>}
          {timeline.runs.length === 0 && <p className="muted">Send a message to start.</p>}
          {timeline.runs.map((run) => (
            <RunView key={run._id} run={run} approvals={approvals} />
          ))}
        </section>
      </div>
      <div className="dock">
        <Composer threadId={threadId} activeRun={activeRun} />
      </div>
    </>
  );
}

function BotThread({ botId }: { botId: Id<"bots"> }) {
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
      return <Conversation threadId={thread.threadId} botId={botId} />;
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
        <BotThread botId={bot._id} />
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
