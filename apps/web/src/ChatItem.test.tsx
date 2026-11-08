import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Character } from "./character.ts";
import { ChatItem } from "./ChatItem.tsx";
import type { DisplayItem } from "./conversation.ts";

// auth.tsx opens a real connection to Convex when it loads.
vi.mock("./auth.tsx", () => ({ useAuthFailure: () => null }));

const character: Character = { shape: "ball", color: "blue" };
const render = (item: DisplayItem) => renderToStaticMarkup(<ChatItem item={item} character={character} />);

describe("ChatItem", () => {
  it("never parses a user's message as markdown or HTML", () => {
    const html = render({ key: "u", kind: "user", text: "**bold** [a](https://e.example) ![i](https://e.example/i.png) <b>x</b>" });
    expect(html).toBe(
      '<div class="bub mine">**bold** [a](https://e.example) ![i](https://e.example/i.png) &lt;b&gt;x&lt;/b&gt;</div>',
    );
  });

  it("sends finished and streaming assistant text through the same renderer", () => {
    const markdown = "**bold** ![i](https://e.example/i.png)";
    for (const streaming of [false, true]) {
      const html = render({ key: "a", kind: "assistant", text: markdown, streaming });
      expect(html).toContain("<strong>bold</strong>");
      expect(html).not.toContain("<img");
    }
    expect(render({ key: "a", kind: "assistant", text: "hi", streaming: true })).toContain('aria-live="polite"');
  });

  it("labels a routine's report and gives it the same safety rules as other bot output", () => {
    const html = render({
      key: "r",
      kind: "report",
      text: '**found** <b>raw</b> ![i](https://e.example/i.png) [ok](https://e.example) [bad](javascript:alert(1))',
    });
    expect(html).toContain("Routine report");
    expect(html).toContain("<strong>found</strong>");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://e.example"');
    expect(html).not.toContain("javascript:");
  });

  it("marks a failed tool row, and only a tool row with output can be expanded", () => {
    const row = { key: "t", kind: "tool", name: "Ran a command", icon: "terminal", summary: "ls", note: "failed" } as const;
    const failed = render({ ...row, status: "failed", output: { text: "no", exitCode: 1, truncated: false } });
    expect(failed).toContain('data-status="failed"');
    expect(failed).toContain('aria-expanded="false"');
    expect(failed).not.toContain("Exit code 1");
    expect(render({ ...row, status: "running", output: null })).not.toContain("aria-expanded");
  });

  it("shows what stopped a run", () => {
    const html = render({ key: "f", kind: "failed", reason: "<b>No key</b>" });
    expect(html).toContain("The reply was interrupted");
    expect(html).toContain("&lt;b&gt;No key&lt;/b&gt;");
    expect(html).toContain("any partial reply are still here");
  });
});
