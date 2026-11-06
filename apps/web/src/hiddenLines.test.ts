import { describe, expect, it } from "vitest";
import { linesBelow, linesBelowNote } from "./hiddenLines.ts";

// 40 lines of 18px with 7px of padding above and below, in a box that shows 344px, like a card at 860 tall.
const fortyLines = { scrollHeight: 734, clientHeight: 344, scrollTop: 0, lineHeight: 18, paddingBottom: 7 };

describe("linesBelow", () => {
  it("is null when all of the text fits", () => {
    expect(linesBelow({ ...fortyLines, scrollHeight: 344 })).toBeNull();
  });

  it("is null when only the box's bottom padding is out of view", () => {
    expect(linesBelow({ ...fortyLines, scrollHeight: 350 })).toBeNull();
  });

  it("counts every line below the box, and a line cut in half counts", () => {
    // The box shows the top padding and 18.72 lines, so lines 19 to 40 are not fully readable.
    expect(linesBelow(fortyLines)).toBe(22);
  });

  it("falls as the person scrolls and reaches zero at the very end", () => {
    expect(linesBelow({ ...fortyLines, scrollTop: 18 })).toBe(21);
    expect(linesBelow({ ...fortyLines, scrollTop: 360 })).toBe(2);
    expect(linesBelow({ ...fortyLines, scrollTop: 390 })).toBe(0);
  });

  it("reaches zero when the end of the text is in view but the box's bottom padding is not", () => {
    expect(linesBelow({ ...fortyLines, scrollTop: 383 })).toBe(0);
  });

  it("still shows one line when a single line remains", () => {
    expect(linesBelow({ ...fortyLines, scrollTop: 370 })).toBe(1);
  });

  it("reaches zero when a fractional scroll position stops just short of a rounded height", () => {
    expect(linesBelow({ scrollHeight: 794, clientHeight: 344, scrollTop: 442.5, lineHeight: 19.5, paddingBottom: 7 })).toBe(0);
  });
});

describe("linesBelowNote", () => {
  it("says how many lines are hidden and what to do", () => {
    expect(linesBelowNote(12)).toBe("12 more lines below. Scroll to read all of it before you answer.");
    expect(linesBelowNote(1)).toBe("1 more line below. Scroll to read all of it before you answer.");
  });
});
