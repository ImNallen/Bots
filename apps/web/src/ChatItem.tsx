import { api } from "@bots/convex";
import { useMutation } from "convex/react";
import { useRef, useState } from "react";
import { BotFace, QueuedDots } from "./BotFace.tsx";
import type { Character } from "./character.ts";
import type { DisplayItem, ToolOutput } from "./conversation.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { errorMessage } from "./session.tsx";

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

function ToolRow({ item }: { item: Extract<DisplayItem, { kind: "tool" }> }) {
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

function ApprovalCard({ item }: { item: Extract<DisplayItem, { kind: "approval" }> }) {
  const decide = useMutation(api.approvals.decide);
  const [sent, setSent] = useState<Decision | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
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
      <h3>{item.title}</h3>
      {item.arguments.map((argument, index) => (
        <div className="ask-argument" key={argument.label ?? index}>
          {argument.label !== null && <span className="ask-label">{argument.label}</span>}
          <pre>{argument.value}</pre>
        </div>
      ))}
      <div className="opts">
        {OPTIONS.map(({ decision, letter, label }) => (
          <button
            key={decision}
            type="button"
            className="opt"
            data-on={sent === decision}
            disabled={sent !== null}
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

function StatusLine({ item, character }: { item: Extract<DisplayItem, { kind: "status" }>; character: Character }) {
  return (
    <div className="live" role="status">
      {item.mode === "tool" ? <BotFace character={character} size={22} state="working" /> : <QueuedDots />}
      {item.mode === "queued" ? <span>{item.text}</span> : <b>{item.text}</b>}
    </div>
  );
}

export function ChatItem({ item, character }: { item: DisplayItem; character: Character }) {
  switch (item.kind) {
    case "time":
      return <div className="when">{item.label}</div>;
    case "user":
      return <div className="bub mine">{item.text}</div>;
    case "assistant":
      return (
        <div className="bub" aria-live={item.streaming ? "polite" : undefined}>
          <Markdown text={item.text} />
        </div>
      );
    case "reasoning":
      return (
        <details className="reasoning">
          <summary>Reasoning</summary>
          <p>{item.text}</p>
        </details>
      );
    case "tool":
      return <ToolRow item={item} />;
    case "approval":
      return <ApprovalCard item={item} />;
    case "denied":
      return <div className="system-line">{item.text}</div>;
    case "failed":
      return (
        <div className="err" role="alert">
          {item.reason}
        </div>
      );
    case "stopped":
      return <div className="system-line">Stopped</div>;
    case "status":
      return <StatusLine item={item} character={character} />;
  }
}
