import type { Character } from "./character.ts";
import type { DisplayItem } from "./conversation.ts";
import { ChatItem, ToolRow } from "./ChatItem.tsx";

type ToolItem = Extract<DisplayItem, { kind: "tool" }>;
type FeedItem = Exclude<DisplayItem, ToolItem> | { kind: "tools"; key: string; items: ToolItem[] };

export function groupToolItems(items: readonly DisplayItem[]): FeedItem[] {
  const groups: FeedItem[] = [];
  for (const item of items) {
    if (item.kind !== "tool") { groups.push(item); continue; }
    const previous = groups.at(-1);
    if (previous?.kind === "tools") previous.items.push(item);
    else groups.push({ kind: "tools", key: item.key, items: [item] });
  }
  return groups;
}

export function ChatFeed({ items, character, botName, onRetry, completedReplyKey }: {
  items: readonly DisplayItem[];
  character: Character;
  botName: string;
  onRetry?: (text: string) => Promise<void>;
  completedReplyKey?: string;
}) {
  const lastUser = items.findLastIndex((item) => item.kind === "user");
  const prompt = items[lastUser];
  const latestReply = items.findLast((item) => item.kind === "assistant" || item.kind === "failed" || item.kind === "stopped");
  return groupToolItems(items).map((item) => {
    if (item.kind === "tools") {
      const failed = item.items.filter((tool) => tool.status === "failed").length;
      const running = item.items.some((tool) => tool.status === "running");
      return <details key={item.key} className="tool-details">
        <summary>{running ? "Activity" : "Completed activity"} · {item.items.length} {item.items.length === 1 ? "action" : "actions"}{failed > 0 && ` · ${failed} failed`}</summary>
        <div className="tool-steps">{item.items.map((tool) => <ToolRow key={tool.key} item={tool} />)}</div>
      </details>;
    }
    const canRetry = onRetry && item === latestReply && prompt?.kind === "user";
    return <ChatItem key={item.key} item={item} character={character} botName={botName} completed={item.key === completedReplyKey}
      onRetry={canRetry ? () => onRetry(prompt.text || "Please try responding to my last message again.") : undefined} />;
  });
}
