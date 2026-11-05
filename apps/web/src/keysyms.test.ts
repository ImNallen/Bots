import { describe, expect, it } from "vitest";
import { KEY_KEYSYMS, MAX_ADDED_KEYSYMS, planTyping } from "./keysyms.ts";

const NONE: ReadonlySet<number> = new Set();
const sent = (text: string) => {
  const plan = planTyping(text, NONE);
  return plan.kind === "send" ? plan.keysyms : plan.reason;
};

describe("planTyping", () => {
  it("sends printable ASCII as itself, and uses no free key", () => {
    const plan = planTyping("aZ9 !~", NONE);
    expect(plan).toEqual({ kind: "send", keysyms: [0x61, 0x5a, 0x39, 0x20, 0x21, 0x7e], added: NONE });
  });

  it("sends Latin-1 by code point, and the rest of Unicode with X's prefix, including past the BMP", () => {
    expect(sent("å€😀")).toEqual([0xe5, 0x010020ac, 0x0101f600]);
  });

  it("sends a line break and a tab as those keys, because their code points type nothing on a real VM", () => {
    expect(sent("a\nb\tc\r")).toEqual([0x61, KEY_KEYSYMS.Enter, 0x62, KEY_KEYSYMS.Tab, 0x63, KEY_KEYSYMS.Enter]);
  });

  it.each([
    ["a control character", "a\u0007b"],
    ["delete", "a\u007fb"],
    ["a C1 control", "a\u0085b"],
    ["a lone surrogate", "a\ud83db"],
  ])("refuses %s, and sends no part of the text", (_name, text) => {
    expect(planTyping(text, NONE)).toEqual({ kind: "refuse", reason: "no-key" });
  });

  it("counts each new character once, however often it repeats", () => {
    const first = planTyping("åäåäå", NONE);
    expect(first.kind === "send" && [...first.added]).toEqual([0xe5, 0xe4]);
    const second = planTyping("åö", first.kind === "send" ? first.added : NONE);
    expect(second.kind === "send" && [...second.added]).toEqual([0xe5, 0xe4, 0xf6]);
  });

  it("refuses the character past the limit, all or nothing, and leaves what was added as it was", () => {
    const fill = Array.from({ length: MAX_ADDED_KEYSYMS }, (_, index) => String.fromCodePoint(0x4e00 + index)).join("");
    const full = planTyping(fill, NONE);
    expect(full.kind === "send" && full.added.size).toBe(MAX_ADDED_KEYSYMS);
    const added = full.kind === "send" ? full.added : NONE;
    expect(planTyping(`ok${String.fromCodePoint(0x5000)}`, added)).toEqual({ kind: "refuse", reason: "keyboard-full" });
    expect(planTyping(`ok${fill}`, added).kind).toBe("send");
  });
});
