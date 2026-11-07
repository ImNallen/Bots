import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "@bots/convex/dataModel";
import { NoteText, noteAuthor } from "./MemorySection.tsx";

vi.mock("./auth.tsx", () => ({ useAuthFailure: () => null }));

const now = new Date(2026, 10, 6, 15, 0).getTime();
const note = (text: string, by: "owner" | "bot" = "bot") => ({ _id: "n1" as Id<"memories">, text, by, createdAt: now });
const render = (text: string, by?: "owner" | "bot") =>
  renderToStaticMarkup(<NoteText note={note(text, by)} botName="Ada" now={now} locale="en-US" />);

describe("noteAuthor", () => {
  it("names who wrote a note", () => {
    expect(noteAuthor("owner", "Ada")).toBe("You");
    expect(noteAuthor("bot", "Ada")).toBe("Ada");
  });
});

describe("NoteText", () => {
  it("never parses a note as markdown or HTML", () => {
    const html = render("**bold** [a](https://e.example) ![i](https://e.example/i.png) <img src=x onerror=y>");
    expect(html).toContain("**bold** [a](https://e.example) ![i](https://e.example/i.png) &lt;img src=x onerror=y&gt;");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<img");
  });

  it("says who wrote it and when", () => {
    expect(render("x", "owner")).toContain("You, Today 3:00");
    expect(render("x", "bot")).toContain("Ada, Today 3:00");
  });
});
