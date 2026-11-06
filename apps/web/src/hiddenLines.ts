export type ScrollBox = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  lineHeight: number;
  paddingBottom: number;
};

// A browser rounds scrollHeight and clientHeight but not scrollTop, so the last line could otherwise never reach zero.
const ROUNDING_PX = 1;

// Counts rendered lines, because one long line that wraps hides as much as many short ones. A line that shows only in part
// counts as hidden. The result is null when all of the text fits, and 0 when the person has scrolled to the end of it.
export function linesBelow(box: ScrollBox): number | null {
  const textBelowFold = box.scrollHeight - box.paddingBottom - box.clientHeight - ROUNDING_PX;
  if (textBelowFold <= 0) {
    return null;
  }
  return Math.max(0, Math.ceil((textBelowFold - box.scrollTop) / box.lineHeight));
}

export function linesBelowNote(count: number): string {
  return `${count} more ${count === 1 ? "line" : "lines"} below. Scroll to read all of it before you answer.`;
}
