import { api } from "@bots/convex";
import type { Doc, Id } from "@bots/convex/dataModel";
import type { MistralUserChunk } from "./mistral.ts";
import type { Service } from "./service.ts";

type Attachment = NonNullable<Extract<Doc<"runEvents">["body"], { kind: "userMessage" }>["attachments"]>[number];
const MAX_PROMPT_FILES = 8;
const MAX_PROMPT_FILE_BYTES = 32 * 1024 * 1024;

export function attachmentChunks(file: Pick<Attachment, "name" | "contentType">, bytes: Uint8Array): MistralUserChunk[] {
  const label: MistralUserChunk = { type: "text", text: `Attached file: ${file.name}` };
  if (file.contentType === "text/plain") return [{ type: "text", text: `Attached file: ${file.name}\n\n${new TextDecoder("utf-8", { fatal: true }).decode(bytes)}` }];
  const data = `data:${file.contentType};base64,${Buffer.from(bytes).toString("base64")}`;
  return [label, file.contentType === "application/pdf" ? { type: "document_url", document_url: data } : { type: "image_url", image_url: data }];
}

export function filesForPrompt<T extends { id: string; size: number }>(files: readonly T[]): Set<T["id"]> {
  const selected = new Set<T["id"]>();
  let bytes = 0;
  for (const file of files.toReversed()) {
    if (selected.has(file.id)) continue;
    if (selected.size === MAX_PROMPT_FILES || bytes + file.size > MAX_PROMPT_FILE_BYTES) break;
    selected.add(file.id);
    bytes += file.size;
  }
  return selected;
}

export async function loadAttachmentInputs(args: {
  service: Service; botId: Id<"bots">; ownerId: Id<"users">; files: readonly Attachment[]; currentIds: readonly Id<"attachments">[]; signal: AbortSignal;
}): Promise<Map<string, MistralUserChunk[]>> {
  const selected = filesForPrompt(args.files);
  const chunks = new Map<string, MistralUserChunk[]>();
  for (const file of args.files) {
    if (chunks.has(file.id)) continue;
    if (!selected.has(file.id)) {
      chunks.set(file.id, [{ type: "text", text: `Earlier attachment: ${file.name}. Its contents are not included in this request. Ask the owner to attach it again if needed.` }]);
      continue;
    }
    try {
      const stored = await args.service.query(api.attachments.forModel, { id: file.id, botId: args.botId, ownerId: args.ownerId });
      if (stored?.url === null || stored === null) throw new Error("Attachment unavailable");
      const response = await fetch(stored.url, { signal: AbortSignal.any([args.signal, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new Error("Attachment download failed");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== stored.size) throw new Error("Incomplete attachment download");
      chunks.set(file.id, attachmentChunks(stored, bytes));
    } catch (error) {
      if (args.signal.aborted || args.currentIds.includes(file.id)) throw error;
      chunks.set(file.id, [{ type: "text", text: `Earlier attachment ${file.name} is unavailable. Ask the owner to attach it again if needed.` }]);
    }
  }
  return chunks;
}
