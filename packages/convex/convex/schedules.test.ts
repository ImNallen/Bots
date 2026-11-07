import { describe, expect, it } from "vitest";
import { instructionProblem } from "./schedules.js";

describe("instructionProblem", () => {
  it("accepts up to 2,000 characters of plain text, with line breaks", () => {
    expect(instructionProblem(`Read the news.\n${"x ".repeat(992)}`)).toBeNull();
    expect(instructionProblem("y ".repeat(1000))).toBeNull();
  });

  it("uses the same rules as a note", () => {
    expect(instructionProblem("")).toBe("empty");
    expect(instructionProblem("z ".repeat(1001))).toBe("tooLong");
    expect(instructionProblem("a‮b")).toBe("characters");
    expect(instructionProblem("my password=hunter2")).toBe("secret");
  });
});
