// What a person's text becomes on the input stream. x11vnc reports nothing back, so a character it cannot type disappears with no
// error, and a password would then be wrong with nothing to show why. So the page decides here, and refuses before it sends.

export const KEY_KEYSYMS = {
  Enter: 0xff0d,
  Tab: 0xff09,
  Escape: 0xff1b,
  Backspace: 0xff08,
  ArrowUp: 0xff52,
  ArrowDown: 0xff54,
  ArrowLeft: 0xff51,
  ArrowRight: 0xff53,
} as const;

export type NamedKey = keyof typeof KEY_KEYSYMS;

export function isNamedKey(key: string): key is NamedKey {
  return Object.hasOwn(KEY_KEYSYMS, key);
}

// A character outside the display's US keyboard needs a free key, and x11vnc has only a few until it exits. A real VM typed 17 or
// 18 different ones in a session and dropped the rest silently. Any number of repeats of those worked, at any speed.
export const MAX_ADDED_KEYSYMS = 16;

const onDisplayKeyboard = (codePoint: number) => codePoint >= 0x20 && codePoint <= 0x7e;

function keysymOf(character: string): number | null {
  if (character === "\n" || character === "\r") {
    return KEY_KEYSYMS.Enter;
  }
  if (character === "\t") {
    return KEY_KEYSYMS.Tab;
  }
  const codePoint = character.codePointAt(0) as number;
  const control = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
  const loneSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  if (control || loneSurrogate) {
    return null;
  }
  // X names Latin-1 by its code point and the rest of Unicode with this prefix.
  return codePoint <= 0xff ? codePoint : (0x01000000 | codePoint) >>> 0;
}

export type Typing =
  | { kind: "send"; keysyms: number[]; added: ReadonlySet<number> }
  | { kind: "refuse"; reason: "no-key" | "keyboard-full" };

// All or nothing, so a refused text leaves no part of itself on the screen. `added` is what this stream's x11vnc has already added.
export function planTyping(text: string, added: ReadonlySet<number>): Typing {
  const keysyms: number[] = [];
  const nowAdded = new Set(added);
  for (const character of text) {
    const keysym = keysymOf(character);
    if (keysym === null) {
      return { kind: "refuse", reason: "no-key" };
    }
    keysyms.push(keysym);
    if (!onDisplayKeyboard(character.codePointAt(0) as number) && keysym !== KEY_KEYSYMS.Enter && keysym !== KEY_KEYSYMS.Tab) {
      nowAdded.add(keysym);
    }
  }
  return nowAdded.size > MAX_ADDED_KEYSYMS ? { kind: "refuse", reason: "keyboard-full" } : { kind: "send", keysyms, added: nowAdded };
}
