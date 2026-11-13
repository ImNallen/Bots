import { describe, expect, it } from "vitest";
import type { MistralMessage } from "./mistral.ts";
import { PDF_UNREADABLE, toOpenAiMessages } from "./together.ts";

describe("toOpenAiMessages", () => {
  it("keeps plain text messages as they are", () => {
    const messages: MistralMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(toOpenAiMessages(messages)).toEqual(messages);
  });

  it("gives a picture OpenAI's address object, in a user message and in a tool result", () => {
    const image = "data:image/png;base64,AAAA";
    const [user, tool] = toOpenAiMessages([
      { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: image }] },
      { role: "tool", tool_call_id: "abcdefghi", name: "desktop_look", content: [{ type: "text", text: "ok" }, { type: "image_url", image_url: image }] },
    ]);
    expect(user).toEqual({ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: image } }] });
    expect(tool).toEqual({
      role: "tool",
      tool_call_id: "abcdefghi",
      name: "desktop_look",
      content: [{ type: "text", text: "ok" }, { type: "image_url", image_url: { url: image } }],
    });
  });

  it("puts a note where a PDF was, because OpenAI's format has no PDF chunk", () => {
    const [user] = toOpenAiMessages([
      { role: "user", content: [{ type: "text", text: "Attached file: plan.pdf" }, { type: "document_url", document_url: "data:application/pdf;base64,AAAA" }] },
    ]);
    expect(user).toEqual({ role: "user", content: [{ type: "text", text: "Attached file: plan.pdf" }, { type: "text", text: PDF_UNREADABLE }] });
    expect(JSON.stringify(user)).not.toContain("application/pdf");
  });

  it("moves a thinking chunk into reasoning_content and keeps the text and the tool calls", () => {
    const toolCalls = [{ id: "abcdefghi", type: "function" as const, function: { name: "shell", arguments: "{\"command\":\"ls\"}" } }];
    const [assistant, silent] = toOpenAiMessages([
      { role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "List " }, { type: "text", text: "first." }] }, { type: "text", text: "Listing." }], tool_calls: toolCalls },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    expect(assistant).toEqual({ role: "assistant", content: "Listing.", reasoning_content: "List first.", tool_calls: toolCalls });
    expect(silent).toEqual({ role: "assistant", content: "Done." });
  });
});
