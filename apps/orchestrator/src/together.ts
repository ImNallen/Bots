import type { MistralMessage } from "./mistral.ts";

// Together takes OpenAI's chat format, which differs from Mistral's in three places that Bots uses: a picture's address is an
// object, reasoning is a field of the assistant message, and there is no PDF chunk. A picture inside a tool result works there, as
// a probe on 2026-11-13 showed for thinkingmachines/Inkling-2-Small, so the newest look keeps its place in the history.
type OpenAiPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type OpenAiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAiPart[] }
  | { role: "assistant"; content: string; reasoning_content?: string; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string | OpenAiPart[] };

export const PDF_UNREADABLE =
  "This PDF is not included, because the current model cannot read PDF files. Ask the owner to paste its text, or to switch to Mistral in Settings.";

type Chunk =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: string }
  | { type: "document_url"; document_url: string };

function part(chunk: Chunk): OpenAiPart {
  switch (chunk.type) {
    case "text":
      return chunk;
    case "image_url":
      return { type: "image_url", image_url: { url: chunk.image_url } };
    case "document_url":
      return { type: "text", text: PDF_UNREADABLE };
  }
}

function parts(content: string | readonly Chunk[]): string | OpenAiPart[] {
  return typeof content === "string" ? content : content.map(part);
}

export function toOpenAiMessages(messages: readonly MistralMessage[]): OpenAiMessage[] {
  return messages.map((message): OpenAiMessage => {
    switch (message.role) {
      case "system":
        return message;
      case "user":
        return { role: "user", content: parts(message.content) };
      case "tool":
        return { role: "tool", tool_call_id: message.tool_call_id, name: message.name, content: parts(message.content) };
      case "assistant": {
        const toolCalls = message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls };
        if (typeof message.content === "string") {
          return { role: "assistant", content: message.content, ...toolCalls };
        }
        const text = message.content.flatMap((chunk) => (chunk.type === "text" ? [chunk.text] : [])).join("");
        const reasoning = message.content
          .flatMap((chunk) => (chunk.type === "thinking" ? chunk.thinking.map((inner) => inner.text) : []))
          .join("");
        // Together's guide asks for reasoning to come back under the key it went out on, and Inkling streams it as reasoning_content.
        return { role: "assistant", content: text, ...(reasoning === "" ? {} : { reasoning_content: reasoning }), ...toolCalls };
      }
    }
  });
}
