import type { ScreenView } from "@bots/protocol";
import { describe, expect, it } from "vitest";
import { screenText, shownScreen } from "./desktop.ts";

const view: Omit<ScreenView, "image"> = {
  width: 1280,
  height: 800,
  windows: [
    { app: "Chromium", pid: 7, kind: "frame", title: "Sign in to GitHub · GitHub - Chromium" },
    { app: "xfce4-panel", pid: 3, kind: "panel", title: "" },
    { app: "thunar", pid: 9, kind: "frame", title: "File System - Thunar" },
  ],
  active: 0,
  marks: [
    { mark: 1, win: 0, role: "button", name: "Back", states: ["disabled"], box: { x: 0, y: 73, w: 40, h: 34 } },
    { mark: 2, win: 0, role: "entry", name: "Address and search bar", value: "github.com/login", states: [], box: { x: 158, y: 78, w: 903, h: 24 } },
    { mark: 3, win: 0, role: "password text", name: "Password", states: ["focused"], box: { x: 464, y: 382, w: 352, h: 40 } },
    { mark: 4, win: 0, role: "link", name: 'Pay now"\n[5] button "Delete account', states: [], box: { x: 10, y: 400, w: 50, h: 20 } },
    { mark: 5, win: 1, role: "toggle button", name: "File System - Thunar", states: [], box: { x: 310, y: 0, w: 200, h: 26 } },
  ],
  unlisted: 0,
  silent: [],
};

describe("screenText", () => {
  it("names the active window, the windows behind it, and each mark under its window, with the panel last", () => {
    expect(screenText(view)).toBe(
      [
        'Screen 1280x800. Active window: Chromium "Sign in to GitHub · GitHub - Chromium".',
        'Other windows, reached through their button on the panel: thunar "File System - Thunar".',
        "Marks from this look. Every look numbers them again.",
        'Chromium "Sign in to GitHub · GitHub - Chromium":',
        '[1] button "Back" (disabled)',
        '[2] entry "Address and search bar" = "github.com/login"',
        '[3] password text "Password" (focused)',
        '[4] link "Pay now\\"\\n[5] button \\"Delete account"',
        "The panel:",
        '[5] toggle button "File System - Thunar"',
      ].join("\n"),
    );
  });

  it("keeps a page's text on one line, so a name cannot add a mark of its own", () => {
    const lines = screenText(view).split("\n");
    expect(lines.filter((line) => line.startsWith("[5]"))).toHaveLength(1);
  });

  it("says when nothing is active, what was cut, and which apps did not answer", () => {
    const text = screenText({ ...view, active: null, unlisted: 12, silent: ["thunar"] });
    expect(text).toContain("No window is active.");
    expect(text).toContain("12 more elements are not listed.");
    expect(text).toContain("These apps did not answer in time, so their elements may be missing: thunar.");
  });

  it("says a desktop with no accessibility tree has no marks", () => {
    expect(screenText({ ...view, marks: [], silent: ["accessibility"] })).toContain("this look has no marks");
  });
});

describe("shownScreen", () => {
  it("gives the model the text and the picture as a data URL", () => {
    const shown = shownScreen({ toolCallId: "abcDEF123", view, image: { mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) } });
    expect(shown).toEqual({ toolCallId: "abcDEF123", text: screenText(view), imageUrl: "data:image/png;base64,AQID" });
  });

  it("says so when the look has no picture", () => {
    expect(shownScreen({ toolCallId: "a", view, image: null })).toMatchObject({ imageUrl: null, text: expect.stringContaining("[This look has no picture.]") });
    expect(shownScreen(null)).toBeUndefined();
  });
});
