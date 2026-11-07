import { describe, expect, it } from "vitest";
import { attachmentChunks, filesForPrompt } from "./attachment-inputs.ts";
import { fileContentProblem } from "./attachments.ts";

describe("attachment model inputs", () => {
  it("sends UTF-8 contents and the file name together", () => {
    expect(attachmentChunks({ name: "plan.md", contentType: "text/plain" }, new TextEncoder().encode("Meet at 10.\nCafé"))).toEqual([{ type: "text", text: "Attached file: plan.md\n\nMeet at 10.\nCafé" }]);
  });
  it("uses the provider's image and document data chunks", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(attachmentChunks({ name: "photo.png", contentType: "image/png" }, bytes)).toContainEqual({ type: "image_url", image_url: "data:image/png;base64,AQID" });
    expect(attachmentChunks({ name: "scan.pdf", contentType: "application/pdf" }, bytes)).toContainEqual({ type: "document_url", document_url: "data:application/pdf;base64,AQID" });
  });
  it("retains the four largest current files within the bounded request budget", () => {
    const files = Array.from({ length: 10 }, (_, id) => ({ id: String(id), size: 8 * 1024 * 1024 }));
    expect([...filesForPrompt(files)]).toEqual(["9", "8", "7", "6"]);
    expect(filesForPrompt(files.map((file) => ({ ...file, size: 1024 }))).size).toBe(8);
  });
});

describe("file content validation", () => {
  it("refuses binary data renamed as text and malformed UTF-8", () => {
    expect(fileContentProblem(new Uint8Array([65, 0, 66]), "text/plain")).toMatch(/binary/);
    expect(fileContentProblem(new Uint8Array([255]), "text/plain")).toMatch(/UTF-8/);
  });
  it("checks binary signatures before storing a file", () => {
    const text = new TextEncoder().encode("<html>not an image</html>");
    for (const type of ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const) expect(fileContentProblem(text, type)).not.toBeNull();
    expect(fileContentProblem(new TextEncoder().encode("%PDF-1.4"), "application/pdf")).toBeNull();
  });
});
