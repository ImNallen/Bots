import { api } from "@bots/convex";
import type { Doc, Id } from "@bots/convex/dataModel";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ScreenPanel } from "./ScreenPanel.tsx";
import { ProblemNotice, SignedIn, errorMessage } from "./session.tsx";

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

function ApprovalButtons({ approvalId }: { approvalId: Id<"approvals"> }) {
  const decide = useMutation(api.approvals.decide);
  const [problem, setProblem] = useState<string | null>(null);
  const answer = (decision: "approved" | "denied") => {
    decide({ approvalId, decision }).catch((error: unknown) => setProblem(errorMessage(error)));
  };
  return (
    <div className="tool-approval" role="group" aria-label="This call needs your approval">
      <button type="button" onClick={() => answer("approved")}>
        Approve
      </button>
      <button type="button" className="secondary" onClick={() => answer("denied")}>
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
      {waiting && <ApprovalButtons approvalId={approvalId} />}
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
        <p className="muted" role="status">
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
          rows={2}
          value={text}
          disabled={activeRun !== undefined}
          placeholder={activeRun !== undefined ? "The bot is working." : "Message the bot"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {activeRun === undefined ? (
          <button type="submit" disabled={sending || text.trim() === ""}>
            {sending ? "Sending" : "Send"}
          </button>
        ) : (
          <button
            type="button"
            className="button-secondary"
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

// The page stays pinned to the newest output until the reader scrolls up, and returning to the bottom pins it again.
function useStickToBottom(content: unknown): void {
  const stick = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      const { scrollHeight, clientHeight, scrollTop } = document.documentElement;
      stick.current = scrollHeight - clientHeight - scrollTop < STICK_TO_BOTTOM_PX;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (stick.current) {
      window.scrollTo(0, document.documentElement.scrollHeight);
    }
  }, [content]);
}

function Conversation({ threadId }: { threadId: Id<"threads"> }) {
  const timeline = useQuery(api.threads.timeline, { threadId });
  const pending = useQuery(api.approvals.pendingForThread, { threadId });
  const approvals = new Map((pending ?? []).map((row) => [`${row.runId}:${row.toolCallId}`, row._id]));
  useStickToBottom(timeline);
  if (timeline === undefined) {
    return <p role="status">Loading the conversation.</p>;
  }
  const activeRun = timeline.runs.find(isActive);
  return (
    <>
      <section className="conversation" aria-label="Conversation">
        {timeline.omittedOlder && <p className="muted">Older messages are not shown.</p>}
        {timeline.runs.length === 0 && <p className="muted">Send a message to start.</p>}
        {timeline.runs.map((run) => (
          <RunView key={run._id} run={run} approvals={approvals} />
        ))}
      </section>
      <Composer threadId={threadId} activeRun={activeRun} />
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
      return <p role="status">Opening the conversation.</p>;
    case "failed":
      return <ProblemNotice title="Could not open the conversation" message={thread.message} />;
    case "ready":
      return <Conversation threadId={thread.threadId} />;
  }
}

const APPROVAL_LEVELS = [
  ["outside", "Ask before shell commands and browser actions that change something"],
  ["everything", "Ask before everything"],
  ["shell", "Ask before shell commands only"],
  ["nothing", "Never ask"],
] as const;

function ApprovalSetting({ botId, level }: { botId: Id<"bots">; level: (typeof APPROVAL_LEVELS)[number][0] }) {
  const setLevel = useMutation(api.bots.setApprovalLevel);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <label className="approval-setting">
      <span>Approvals</span>
      <select
        value={level}
        onChange={(event) => {
          const next = event.target.value as typeof level;
          setProblem(null);
          setLevel({ botId, level: next }).catch((error: unknown) => setProblem(errorMessage(error)));
        }}
      >
        {APPROVAL_LEVELS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {problem !== null && (
        <span className="error" role="alert">
          {problem}
        </span>
      )}
    </label>
  );
}

function BotChat({ botId }: { botId: string }) {
  const bot = useQuery(api.bots.get, { botId });
  if (bot === undefined) {
    return <p role="status">Loading the bot.</p>;
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
  return (
    <>
      <nav className="bot-nav">
        <Link to="/">Your bots</Link>
        <h2>{bot.name}</h2>
      </nav>
      <ApprovalSetting botId={bot._id} level={bot.approvalLevel ?? "outside"} />
      <ScreenPanel botId={bot._id} />
      <BotThread botId={bot._id} />
    </>
  );
}

export function BotPage() {
  const { botId } = useParams({ from: "/bots/$botId" });
  return <SignedIn>{() => <BotChat botId={botId} />}</SignedIn>;
}
