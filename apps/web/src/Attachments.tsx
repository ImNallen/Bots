import { api } from "@bots/convex";
import { attachmentContentType, attachmentProblem, formatFileSize, MAX_ATTACHMENTS } from "@bots/convex/attachmentFiles";
import type { Doc, Id } from "@bots/convex/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useConvex, useMutation } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { errorMessage } from "./session.tsx";

type ReadyAttachment = NonNullable<FunctionReturnType<typeof api.attachments.draft>>;
export type DraftAttachment = { key: string; file: File; preview: string | null } & (
  | { kind: "uploading" }
  | { kind: "ready"; attachment: ReadyAttachment }
  | { kind: "failed"; message: string }
);
type MessageAttachment = NonNullable<Extract<Doc<"runEvents">["body"], { kind: "userMessage" }>["attachments"]>[number];

export function useDraftAttachments(botId: Id<"bots">) {
  const client = useConvex();
  const discard = useMutation(api.attachments.discard);
  const [items, setItems] = useState<DraftAttachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const resources = useRef(new Map<string, { preview: string | null; controller: AbortController }>());

  useEffect(() => () => {
    for (const resource of resources.current.values()) {
      resource.controller.abort();
      if (resource.preview !== null) URL.revokeObjectURL(resource.preview);
    }
    resources.current.clear();
  }, []);

  async function upload(item: Pick<DraftAttachment, "key" | "file" | "preview">) {
    const controller = new AbortController();
    resources.current.set(item.key, { preview: item.preview, controller });
    setItems((current) => current.map((entry) => entry.key === item.key ? { ...item, kind: "uploading" } : entry));
    try {
      const response = await fetch(`/api/attachments/${botId}`, {
        method: "POST", body: item.file, signal: controller.signal,
        headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(item.file.name), "X-File-Type": attachmentContentType(item.file.name, item.file.type) ?? "" },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : "The file could not be uploaded. Try again.");
      if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") throw new Error("The upload returned an unexpected response. Try again.");
      const attachment = await client.query(api.attachments.draft, { id: body.id, botId });
      if (attachment === null) throw new Error("This attachment is unavailable. Upload it again.");
      if (controller.signal.aborted) { void discard({ id: attachment.id }).catch(() => {}); return; }
      setItems((current) => current.map((entry) => entry.key === item.key ? { ...item, kind: "ready", attachment } : entry));
    } catch (error) {
      if (!controller.signal.aborted) setItems((current) => current.map((entry) => entry.key === item.key ? { ...item, kind: "failed", message: errorMessage(error) } : entry));
    }
  }

  function add(files: Iterable<File>) {
    setProblem(null);
    for (const file of files) {
      if (resources.current.size >= MAX_ATTACHMENTS) { setProblem("Attach up to four files per message."); break; }
      const problem = attachmentProblem(file);
      if (problem !== null) { setProblem(problem); continue; }
      const item = { key: crypto.randomUUID(), file, preview: attachmentContentType(file.name, file.type)?.startsWith("image/") ? URL.createObjectURL(file) : null };
      setItems((current) => [...current, { ...item, kind: "uploading" }]);
      void upload(item);
    }
  }

  function release(key: string) {
    const resource = resources.current.get(key);
    if (resource === undefined) return;
    resource.controller.abort();
    if (resource.preview !== null) URL.revokeObjectURL(resource.preview);
    resources.current.delete(key);
  }

  function remove(item: DraftAttachment) {
    release(item.key);
    if (item.kind === "ready") {
      void discard({ id: item.attachment.id }).catch(() => {});
    }
    setItems((current) => current.filter((entry) => entry.key !== item.key));
    setProblem(null);
  }

  function sent() {
    for (const key of resources.current.keys()) release(key);
    setItems([]);
    setProblem(null);
  }

  return { items, problem, add, remove, retry: upload, sent,
    ready: items.every((item) => item.kind === "ready"),
    ids: items.flatMap((item) => item.kind === "ready" ? [item.attachment.id] : []),
  };
}

export function AttachmentDrafts({ items, disabled, onRemove, onRetry }: {
  items: DraftAttachment[]; disabled: boolean; onRemove: (item: DraftAttachment) => void; onRetry: (item: DraftAttachment) => void;
}) {
  if (items.length === 0) return null;
  return <ul className="attachment-drafts" aria-label="Attachments">
    {items.map((item) => <li key={item.key} className="attachment-draft" data-state={item.kind}>
      {item.preview === null ? <span className="attachment-file-icon"><Icon name="file" /></span> : <img src={item.preview} alt="" />}
      <span className="attachment-label"><strong title={item.file.name}>{item.file.name}</strong>
        <small role={item.kind === "failed" ? "alert" : "status"}>{item.kind === "uploading" ? "Uploading…" : item.kind === "failed" ? item.message : formatFileSize(item.attachment.size)}</small>
        {item.kind === "failed" && <button type="button" className="attachment-retry" disabled={disabled} onClick={() => onRetry(item)}>Retry upload</button>}
      </span>
      <button type="button" className="attachment-remove" disabled={disabled} aria-label={`Remove ${item.file.name}`} onClick={() => onRemove(item)}><Icon name="close" /></button>
    </li>)}
  </ul>;
}

export function MessageAttachments({ items }: { items: readonly MessageAttachment[] }) {
  return <div className="message-attachments" aria-label="Attached files">{items.map((file) => <a key={file.id} className="message-attachment" href={`/api/attachments/${file.id}`} download={file.name}>
    {file.contentType.startsWith("image/") ? <img src={`/api/attachments/${file.id}?preview=1`} alt={file.name} loading="lazy" /> : <span className="attachment-file-icon"><Icon name="file" /></span>}
    <span className="attachment-label"><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span>
  </a>)}</div>;
}
