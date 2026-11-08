import { api } from "@bots/convex";
import type { Id } from "@bots/convex/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BotFace, type FaceState } from "./BotFace.tsx";
import type { Character } from "./character.ts";
import type { DisplayItem, ToolOutput } from "./conversation.ts";
import { allArgumentsRead, hasReadToEnd, linesBelow, linesBelowNote } from "./hiddenLines.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { errorMessage } from "./session.tsx";
import { MessageAttachments } from "./Attachments.tsx";

type Decision = "approved" | "denied";

const OPTIONS: readonly { decision: Decision; letter: string; label: string }[] = [
  { decision: "approved", letter: "A", label: "Approve" },
  { decision: "denied", letter: "B", label: "Deny" },
];

function outputNote({ exitCode, truncated }: ToolOutput): string {
  return [exitCode === undefined ? null : `Exit code ${exitCode}`, truncated ? "Truncated" : null]
    .filter((part) => part !== null)
    .join(", ");
}

export function ToolRow({ item }: { item: Extract<DisplayItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const { output } = item;
  const content = (
    <>
      <span>{item.name}</span>
      <Icon name={item.icon} />
      {item.summary !== "" && <code>{item.summary}</code>}
      {item.note !== null && <span>{item.note}</span>}
    </>
  );
  if (output === null) {
    return (
      <div className="tool" data-status={item.status}>
        {content}
      </div>
    );
  }
  const note = outputNote(output);
  return (
    <>
      <button
        type="button"
        className="tool"
        data-status={item.status}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {content}
      </button>
      {open && (
        <div className="out">
          {note !== "" && <div className="out-note">{note}</div>}
          {output.text === "" ? "(no output)" : output.text}
        </div>
      )}
    </>
  );
}

// A device can hide its scrollbars, and a bot can pad a command to push the dangerous part out of view, so the card says what is
// left. At the end the note keeps its room, because the answers below it must not move under a finger that is about to tap.
function ArgumentText(props: { text: string; index: number; onRead: (index: number) => void }) {
  const { text, index, onRead } = props;
  const box = useRef<HTMLPreElement>(null);
  // Undefined until measured, so nothing counts as read before the browser has laid it out.
  const [below, setBelow] = useState<number | null | undefined>(undefined);
  const measure = () => {
    const element = box.current;
    if (element !== null) {
      const { lineHeight, paddingBottom } = getComputedStyle(element);
      const { scrollHeight, clientHeight, scrollTop } = element;
      setBelow(
        linesBelow({
          scrollHeight,
          clientHeight,
          scrollTop,
          lineHeight: parseFloat(lineHeight),
          paddingBottom: parseFloat(paddingBottom),
        }),
      );
    }
  };
  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (box.current !== null) {
      observer.observe(box.current);
    }
    return () => observer.disconnect();
  }, [text]);
  const reachedEnd = below !== undefined && hasReadToEnd(below);
  const [read, setRead] = useState(false);
  useEffect(() => {
    if (reachedEnd) {
      setRead(true);
      onRead(index);
    }
  }, [reachedEnd, index, onRead]);
  return (
    <>
      <pre ref={box} tabIndex={typeof below === "number" ? 0 : undefined} onScroll={measure}>
        {text}
      </pre>
      {typeof below === "number" && (
        <p className="ask-more" data-end={below === 0}>
          {linesBelowNote(below, read)}
        </p>
      )}
    </>
  );
}

// The owner approves an action on their own logged-in desktop, and a role and a name do not identify an unnamed icon, so the card
// shows the look that the action was aimed from, with the target outlined.
function ScreenTarget({ approvalId }: { approvalId: Id<"approvals"> }) {
  const target = useQuery(api.screens.forApproval, { approvalId });
  const url = useMemo(() => (target ? URL.createObjectURL(new Blob([target.image.bytes], { type: target.image.mediaType })) : null), [target]);
  useEffect(() => () => {
    if (url !== null) URL.revokeObjectURL(url);
  }, [url]);
  if (!target || url === null) {
    return null;
  }
  const { box, width, height } = target;
  const percent = (value: number, of: number) => `${(value / of) * 100}%`;
  return (
    <figure className="ask-screen">
      <img src={url} alt="The screen when the bot chose this action" width={width} height={height} />
      {box !== null && (
        <span className="ask-target" style={{ left: percent(box.x, width), top: percent(box.y, height), width: percent(box.w, width), height: percent(box.h, height) }} aria-hidden="true" />
      )}
    </figure>
  );
}

function ApprovalCard({ item }: { item: Extract<DisplayItem, { kind: "approval" }> }) {
  const decide = useMutation(api.approvals.decide);
  const [sent, setSent] = useState<Decision | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Scrolling back up does not take away what the person has already read.
  const [read, setRead] = useState<ReadonlySet<number>>(new Set());
  const markRead = useCallback((index: number) => {
    setRead((current) => (current.has(index) ? current : new Set(current).add(index)));
  }, []);
  // Set before the next render, so a second click in the same instant still finds it.
  const sending = useRef(false);
  const answer = (decision: Decision) => {
    if (sending.current) {
      return;
    }
    sending.current = true;
    setSent(decision);
    setProblem(null);
    // On success the call stops being pending and this card goes away.
    decide({ approvalId: item.approvalId, decision }).catch((error: unknown) => {
      sending.current = false;
      setSent(null);
      setProblem(errorMessage(error));
    });
  };
  return (
    <section className="ask" data-done={sent !== null} aria-label="This call needs your approval">
      <h3>{sent === "approved" ? "Approved · Continuing" : sent === "denied" ? "Skipped · Nothing was run" : item.title}</h3>
      {item.arguments.map((argument, index) => (
        <div className="ask-argument" key={argument.label ?? index}>
          {argument.label !== null && <span className="ask-label">{argument.label}</span>}
          <ArgumentText text={argument.value} index={index} onRead={markRead} />
        </div>
      ))}
      {item.picture && <ScreenTarget approvalId={item.approvalId} />}
      <div className="opts">
        {OPTIONS.map(({ decision, letter, label }) => (
          <button
            key={decision}
            type="button"
            className="opt"
            data-on={sent === decision}
            // A bot can pad a command to push its dangerous part out of view, so nobody approves text they have not reached.
            disabled={sent !== null || (decision === "approved" && !allArgumentsRead(item.arguments.length, read))}
            onClick={() => answer(decision)}
          >
            <i aria-hidden="true">{letter}</i>
            {label}
          </button>
        ))}
      </div>
      {problem !== null && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

export function BotAuthor({ character, botName, state = "idle" }: { character: Character; botName: string; state?: FaceState }) {
  return <div className="assistant-author"><BotFace character={character} size={24} state={state} /><span>{botName}</span></div>;
}

function ReplyActions({ text, onRetry }: { text?: string; onRetry?: () => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const copy = async () => {
    if (text === undefined) return;
    try { await navigator.clipboard.writeText(text); setCopied(true); setProblem(null); }
    catch { setProblem("Could not copy. Select the reply to copy it."); }
  };
  const retry = async () => {
    if (!onRetry || busy) return;
    setBusy(true); setProblem(null);
    try { await onRetry(); } catch (error) { setProblem(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <>
    <div className="reply-actions">
      {text !== undefined && <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>}
      {onRetry && <button type="button" disabled={busy} onClick={() => void retry()}>{busy ? "Retrying…" : "Retry"}</button>}
    </div>
    {problem && <p className="error" role="alert">{problem}</p>}
  </>;
}

function StatusLine({ item, character, botName }: { item: Extract<DisplayItem, { kind: "status" }>; character: Character; botName: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (item.mode === "queued") return;
    const timer = window.setTimeout(() => setSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [item.text, item.mode]);
  const label = item.mode === "thinking" ? "Thinking…" : item.text;
  return <div className="assistant-message">
    <BotAuthor character={character} botName={botName} state={item.mode === "tool" ? "working" : item.mode === "thinking" ? "thinking" : "idle"} />
    <div className="live" role="status"><span className="activity-dot" aria-hidden="true" /><span>{slow ? "Still working…" : label}</span>{slow && <small>{label} · You can stop at any time</small>}</div>
  </div>;
}

export function ChatItem({ item, character, botName = "Bot", onRetry, completed = false }: { item: DisplayItem; character: Character; botName?: string; onRetry?: () => Promise<void>; completed?: boolean }) {
  switch (item.kind) {
    case "time":
      return <div className="when">{item.label}</div>;
    case "user":
      return <div className="bub mine">{item.attachments?.length ? <MessageAttachments items={item.attachments} /> : null}{item.text}</div>;
    case "assistant":
      return (
        <article className="assistant-message">
          <BotAuthor character={character} botName={botName} state={item.streaming ? "working" : completed ? "success" : "idle"} />
          <div className="bub" aria-live={item.streaming ? "polite" : undefined}><Markdown text={item.text} /></div>
          {!item.streaming && <ReplyActions text={item.text} onRetry={onRetry} />}
        </article>
      );
    case "report":
      return (
        <div className="bub report">
          <p className="report-label">Routine report</p>
          <Markdown text={item.text} />
        </div>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "approval":
      return <div className="assistant-message"><BotAuthor character={character} botName={botName} state="needsApproval" /><ApprovalCard item={item} /></div>;
    case "denied":
      return <div className="system-line">{item.text}</div>;
    case "failed":
      return <section className="chat-recovery" role="alert"><h3>The reply was interrupted</h3><p>{item.reason}</p><p>Your message and any partial reply are still here.</p>{onRetry && <ReplyActions onRetry={onRetry} />}</section>;
    case "stopped":
      return <section className="chat-recovery"><h3>You stopped this reply</h3><p>Any text already written stays in the conversation.</p>{onRetry && <ReplyActions onRetry={onRetry} />}</section>;
    case "status":
      return <StatusLine item={item} character={character} botName={botName} />;
  }
}
