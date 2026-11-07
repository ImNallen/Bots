import { describe, expect, it } from "vitest";
import { attachmentContentType, attachmentProblem, MAX_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_BYTES } from "./attachmentFiles.js";

describe("attachment validation", () => {
  it("recognizes supported files when a browser omits the MIME type", () => {
    expect(attachmentContentType("Scan.PDF", "")).toBe("application/pdf");
    expect(attachmentContentType("photo.jpg", "application/octet-stream")).toBe("image/jpeg");
    expect(attachmentContentType("index.ts", "application/octet-stream")).toBe("text/plain");
    expect(attachmentContentType("app.exe", "application/octet-stream")).toBeNull();
    expect(attachmentContentType("vector.svg", "image/svg+xml")).toBeNull();
  });

  it("accepts the exact size limits and rejects the next byte", () => {
    for (const [name, type, size] of [["photo.png", "image/png", MAX_ATTACHMENT_BYTES], ["notes.txt", "text/plain", MAX_TEXT_ATTACHMENT_BYTES]] as const) {
      expect(attachmentProblem({ name, type, size })).toBeNull();
      expect(attachmentProblem({ name, type, size: size + 1 })).toMatch(/too large/);
    }
  });

  it.each(["../notes.txt", "folder/notes.txt", "folder\\notes.txt", "note\r\nname.txt", "", "x".repeat(161)])("rejects an unsafe name %j", (name) => {
    expect(attachmentProblem({ name, type: "text/plain", size: 1 })).toMatch(/name/);
  });

  it("rejects empty files and invalid sizes", () => {
    for (const size of [0, -1, 0.5, Infinity]) expect(attachmentProblem({ name: "notes.txt", type: "text/plain", size })).not.toBeNull();
  });
});
