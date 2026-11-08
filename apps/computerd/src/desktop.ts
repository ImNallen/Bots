import type { Slot } from "./desktops.ts";

export const HAND_PATH = "/opt/bots-computerd/current/apps/computerd/desktop/hand.py";

// The sudoers file names exactly this command, and desktop-files.test.ts pins the two together.
export function handArgv(slot: Slot): string[] {
  return ["-n", "-u", "browser", "--", "/usr/bin/python3", "-I", HAND_PATH, String(slot)];
}
