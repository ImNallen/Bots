export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;

const TEXT_EXTENSIONS = ["txt", "md", "csv", "tsv", "json", "js", "ts", "tsx", "jsx", "py", "css", "html", "yaml", "yml", "xml", "log", "sh", "sql", "rs", "go", "java", "c", "cpp", "h", "toml", "ini"];
export const ATTACHMENT_ACCEPT = ["image/png", "image/jpeg", "image/webp", "application/pdf", ...TEXT_EXTENSIONS.map((extension) => `.${extension}`)].join(",");
export type AttachmentContentType = "image/png" | "image/jpeg" | "image/webp" | "application/pdf" | "text/plain";

export function attachmentContentType(name: string, type: string): AttachmentContentType | null {
  const normalized = type.split(";")[0]?.trim().toLowerCase();
  if (normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp" || normalized === "application/pdf") return normalized;
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "pdf") return "application/pdf";
  return TEXT_EXTENSIONS.includes(extension) || normalized === "text/plain" ? "text/plain" : null;
}

export function attachmentProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.name.trim() === "" || file.name.length > 160 || /[\x00-\x1f\x7f/\\]/.test(file.name)) return "Choose a file with a name of 1–160 characters, without slashes or control characters.";
  const type = attachmentContentType(file.name, file.type);
  if (type === null) return "Choose a PNG, JPEG, WebP, PDF, or a text/code file.";
  if (!Number.isSafeInteger(file.size) || file.size < 1) return "This file is empty.";
  const limit = type === "text/plain" ? MAX_TEXT_ATTACHMENT_BYTES : MAX_ATTACHMENT_BYTES;
  return file.size > limit ? `${file.name} is too large. ${type === "text/plain" ? "Text/code files can be up to 256 KB" : "Images and PDFs can be up to 8 MB"}.` : null;
}

export function formatFileSize(size: number): string {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
