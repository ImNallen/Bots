import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatFeed, groupToolItems } from "./ChatFeed.tsx";
import { BotFace } from "./BotFace.tsx";
import { faceStateFor } from "./activity.ts";
import type { DisplayItem } from "./conversation.ts";

vi.mock("./auth.tsx", () => ({ useAuthFailure: () => null }));

const character = { shape: "ball", color: "green" } as const;
const tool: DisplayItem = { kind: "tool", key: "t1", name: "Read a file", icon: "file", summary: "notes.md", status: "finished", note: null, output: { text: "hello", exitCode: undefined, truncated: false } };

describe("chat feedback", () => {
  it("keeps tool disclosures in reading order without hiding a request for approval", () => {
    const items: DisplayItem[] = [tool, { ...tool, key: "t2" }, { kind: "denied", key: "decision", text: "Skipped" }, { ...tool, key: "t3" }];
    expect(groupToolItems(items).map((item) => item.kind)).toEqual(["tools", "denied", "tools"]);
    expect(items).toHaveLength(4);
  });

  it("starts completed tool activity collapsed with the real action count", () => {
    const html = renderToStaticMarkup(<ChatFeed items={[tool, { ...tool, key: "t2" }]} character={character} botName="Atlas" />);
    expect(html).toContain("Completed activity");
    expect(html).toContain("2 actions");
    expect(html).not.toContain("<details open");
    expect(html).toContain("notes.md");
  });

  it("pairs an immediate thinking cue with the named bot and its thinking expression", () => {
    const html = renderToStaticMarkup(<ChatFeed items={[{ kind: "status", key: "live", mode: "thinking", text: "Thinking" }]} character={character} botName="Atlas" />);
    expect(html).toContain('data-state="thinking"');
    expect(html).toContain("Thinking…");
    expect(html).toContain("Atlas");
    expect(html).toContain('role="status"');
  });

  it("uses actual activity and preserves the approval and error expressions", () => {
    expect(faceStateFor({ kind: "running", tool: null })).toBe("thinking");
    expect(faceStateFor({ kind: "running", tool: "read_file" })).toBe("working");
    expect(faceStateFor({ kind: "needsApproval" })).toBe("needsApproval");
    expect(faceStateFor({ kind: "failed" })).toBe("error");
    expect(renderToStaticMarkup(<BotFace character={character} size={32} state="success" />)).toContain("<image href=");
  });
});
