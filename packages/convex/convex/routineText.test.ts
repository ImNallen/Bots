import { describe, expect, it } from "vitest";
import { parseRoutineText, routineTitle } from "./routineText.js";

const TEXT = { title: "News", summary: "Tells you the news each morning.", steps: ["Reads the news.", "Writes a short summary."], instruction: "Read the news and report." };

describe("parseRoutineText", () => {
  it("trims every field and keeps the rest", () => {
    expect(parseRoutineText({ ...TEXT, title: "  News  ", steps: [" Reads. "] })).toEqual({ kind: "ok", text: { ...TEXT, steps: ["Reads."] } });
  });

  it("checks only the fields an update names", () => {
    expect(parseRoutineText({ title: "Evening news" })).toEqual({ kind: "ok", text: { title: "Evening news" } });
  });

  it("holds each field to its length", () => {
    expect(parseRoutineText({ title: `${"News ".repeat(11)}Today` }).kind).toBe("ok");
    expect(parseRoutineText({ title: "x".repeat(61) })).toEqual({ kind: "refused", reason: expect.stringMatching(/title cannot be longer than 60/) });
    expect(parseRoutineText({ summary: "x".repeat(201) })).toEqual({ kind: "refused", reason: expect.stringMatching(/description cannot be longer than 200/) });
    expect(parseRoutineText({ steps: ["x".repeat(201)] })).toEqual({ kind: "refused", reason: expect.stringMatching(/step cannot be longer than 200/) });
    expect(parseRoutineText({ instruction: "y ".repeat(1000) }).kind).toBe("ok");
    expect(parseRoutineText({ instruction: "z ".repeat(1001) })).toEqual({ kind: "refused", reason: expect.stringMatching(/instruction cannot be longer than 2,000/) });
  });

  it("needs 1 to 6 steps, and no empty field", () => {
    expect(parseRoutineText({ steps: [] })).toEqual({ kind: "refused", reason: "A routine has 1 to 6 steps." });
    expect(parseRoutineText({ steps: Array.from({ length: 7 }, () => "Reads.") })).toEqual({ kind: "refused", reason: "A routine has 1 to 6 steps." });
    expect(parseRoutineText({ steps: ["Reads.", "  "] })).toEqual({ kind: "refused", reason: "A routine's step cannot be empty." });
    expect(parseRoutineText({ title: " " })).toEqual({ kind: "refused", reason: "A routine's title cannot be empty." });
  });

  it("keeps the owner's lines to one line, and lets an instruction have many", () => {
    expect(parseRoutineText({ title: "News\nnow" })).toEqual({ kind: "refused", reason: expect.stringMatching(/invisible or control characters or line breaks/) });
    expect(parseRoutineText({ instruction: "Read the news.\nReport." }).kind).toBe("ok");
  });

  it("uses the same character and secret rules as a note", () => {
    expect(parseRoutineText({ title: "a‮b" })).toMatchObject({ kind: "refused", reason: expect.stringMatching(/invisible or control/) });
    expect(parseRoutineText({ instruction: "a​b" })).toMatchObject({ kind: "refused", reason: expect.stringMatching(/invisible or control/) });
    expect(parseRoutineText({ steps: ["my password=hunter2"] })).toMatchObject({ kind: "refused", reason: expect.stringMatching(/password, key, token/) });
  });
});

describe("routineTitle", () => {
  it("is the title when there is one", () => {
    expect(routineTitle({ title: "News", instruction: "Read the news." })).toBe("News");
  });

  it("is the start of an older routine's instruction, on one line, cut with an ellipsis", () => {
    expect(routineTitle({ instruction: "Read\n\n the news." })).toBe("Read the news.");
    const cut = routineTitle({ instruction: `${"word ".repeat(30)}end` });
    expect([...cut]).toHaveLength(60);
    expect(cut.endsWith("…")).toBe(true);
    expect(routineTitle({ instruction: "😀".repeat(70) })).toBe(`${"😀".repeat(59)}…`);
  });
});
