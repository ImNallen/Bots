import { readFileSync } from "node:fs";
import { MAX_MARKS, type ScreenView } from "@bots/protocol";
import { describe, expect, it } from "vitest";
import type { AimedInvocation, KeyCombo } from "@bots/protocol";
import { capture, centerOf, inputPlan, locate, selectMarks, summaryOf, type Capture } from "./marks.ts";

// Captures that hand.py made on a real VM, with Xfce, Chromium, Thunar, and a terminal on one display.
function recorded(name: string): Capture {
  return capture.parse(JSON.parse(readFileSync(new URL(`fixtures/desktop/${name}.json`, import.meta.url), "utf8")));
}

const look = (name: string) => selectMarks(recorded(name)).view;
const appsOf = (view: Omit<ScreenView, "image">) => new Set(view.marks.map((mark) => view.windows[mark.win]?.app));
const named = (view: Omit<ScreenView, "image">, role: string, name: string) => view.marks.find((mark) => mark.role === role && mark.name === name);
const activeOf = (view: Omit<ScreenView, "image">) => (view.active === null ? null : view.windows[view.active]);

describe("selectMarks on captures from a real desktop", () => {
  it("lists Chromium and the panel, and nothing of the windows behind Chromium", () => {
    const view = look("chromium-over-others");
    expect(appsOf(view)).toEqual(new Set(["Chromium", "xfce4-panel"]));
    expect(activeOf(view)).toMatchObject({ app: "Chromium", kind: "frame", title: "Sign in to GitHub · GitHub - Chromium" });
    expect(named(view, "entry", "Address and search bar")).toMatchObject({ value: "github.com/login" });
    expect(named(view, "button", "Sign in")).toBeDefined();
    expect(named(view, "button", "Back")?.states).toContain("disabled");
    expect(named(view, "toggle button", "File System - Thunar")).toBeDefined();
  });

  it("never gives a password field a value", () => {
    const password = named(look("chromium-over-others"), "password text", "Password");
    expect(password).toBeDefined();
    expect(password).not.toHaveProperty("value");
  });

  it("names the other windows that a panel button reaches", () => {
    const view = look("chromium-over-others");
    const others = view.windows.filter((window, index) => index !== view.active && window.kind === "frame" && window.app !== "Chromium");
    expect(others.map((window) => window.title).sort()).toEqual(["File System - Thunar", "Terminal - browser@bots-user-950: /"]);
  });

  it("puts an open menu first, and drops the page under it", () => {
    const captured = recorded("menu-over-links");
    const view = selectMarks(captured).view;
    expect(activeOf(view)).toMatchObject({ app: "Chromium", kind: "frame", title: "" });
    expect(view.marks[0]).toMatchObject({ role: "menu item", name: "New tab Ctrl+T", win: view.active });
    const menu = captured.windows.find((window) => window.active && window.app === "Chromium")?.box;
    const inMenu = ({ x, y }: { x: number; y: number }) => menu !== undefined && x >= menu.x && x < menu.x + menu.w && y >= menu.y && y < menu.y + menu.h;
    const page = view.marks.filter((mark) => mark.win !== view.active && view.windows[mark.win]?.kind !== "panel");
    expect(page.filter((mark) => inMenu(centerOf(mark.box)))).toEqual([]);
    expect(captured.nodes.some((node) => node.win === 5 && inMenu(centerOf(node.box)))).toBe(true);
    expect(named(view, "link", "link number 0")).toBeDefined();
  });

  it("drops what a menu bar's open menu covers inside the same window", () => {
    const captured = recorded("thunar-menu");
    const view = selectMarks(captured).view;
    const open = captured.menus.find((menu) => menu.box.w > 0);
    expect(open).toBeDefined();
    const inMenu = ({ x, y }: { x: number; y: number }) => open !== undefined && x >= open.box.x && x < open.box.x + open.box.w && y >= open.box.y && y < open.box.y + open.box.h;
    expect(named(view, "menu item", "New Window")).toBeDefined();
    expect(new Set(view.marks.filter((mark) => inMenu(centerOf(mark.box))).map((mark) => mark.role))).toEqual(new Set(["menu item", "menu"]));
    expect(named(view, "button", "Back")).toBeUndefined();
    expect(captured.nodes.some((node) => node.role !== "menu item" && inMenu(centerOf(node.box)))).toBe(true);
  });

  it("lists a file chooser and the panel, and none of the page that opened it", () => {
    const view = look("file-chooser");
    expect(activeOf(view)).toMatchObject({ app: "xdg-desktop-portal-gtk", kind: "dialog", title: "Open File" });
    expect(appsOf(view)).toEqual(new Set(["xdg-desktop-portal-gtk", "xfce4-panel"]));
    expect(view.marks.some((mark) => mark.role === "table cell")).toBe(true);
  });

  it("lists the terminal when it is active, and drops Chromium", () => {
    const view = look("terminal-active");
    expect(activeOf(view)).toMatchObject({ app: "xfce4-terminal", kind: "frame" });
    expect(appsOf(view)).toEqual(new Set(["xfce4-terminal", "xfce4-panel"]));
    expect(view.marks.some((mark) => mark.role === "terminal")).toBe(true);
  });

  it("lists the desktop when it is shown", () => {
    const view = look("desktop-shown");
    expect(activeOf(view)).toMatchObject({ app: "xfdesktop", title: "Desktop" });
    expect(appsOf(view).has("Chromium")).toBe(false);
  });

  it("lists only the panel when the active window has no accessibility tree", () => {
    const view = look("inaccessible-dialog");
    expect(view.active).toBeNull();
    expect(appsOf(view)).toEqual(new Set(["xfce4-panel"]));
  });

  it("stops at MAX_MARKS on a page with 2,000 links and counts the rest", () => {
    const { view, candidates } = selectMarks(recorded("many-links"));
    expect(view.marks).toHaveLength(MAX_MARKS);
    expect(view.unlisted).toBe(candidates.length - MAX_MARKS);
    expect(view.unlisted).toBeGreaterThan(0);
    expect(view.marks.map((mark) => mark.mark)).toEqual(Array.from({ length: MAX_MARKS }, (_, index) => index + 1));
  });

  it.each(["chromium-over-others", "chromium-menu", "menu-over-links", "thunar-menu", "file-chooser", "terminal-active", "desktop-shown", "many-links"])(
    "keeps every mark of %s on the screen, and drops the panel that hides below it",
    (name) => {
      const view = look(name);
      for (const mark of view.marks) {
        expect(mark.box.x).toBeGreaterThanOrEqual(0);
        expect(mark.box.y).toBeGreaterThanOrEqual(0);
        expect(mark.box.x + mark.box.w).toBeLessThanOrEqual(view.width);
        expect(mark.box.y + mark.box.h).toBeLessThanOrEqual(view.height);
      }
      expect(view.windows.length).toBeLessThanOrEqual(32);
    },
  );

  it("says the accessibility tree is missing when the desktop has no bus", () => {
    const view = selectMarks({ ...recorded("chromium-over-others"), bus: "missing", apps: [], windows: [], nodes: [] }).view;
    expect(view).toMatchObject({ marks: [], active: null, silent: ["accessibility"] });
  });

  it("names an app that did not answer in time", () => {
    const captured = recorded("chromium-over-others");
    const view = selectMarks({ ...captured, apps: captured.apps.map((app) => ({ ...app, silent: app.app === "thunar" })) }).view;
    expect(view.silent).toEqual(["thunar"]);
  });

  it("refuses a helper's answer with a name past its limit", () => {
    const captured = recorded("chromium-over-others");
    const node = { ...captured.nodes[0], name: "x".repeat(121) };
    expect(capture.safeParse({ ...captured, nodes: [node] }).success).toBe(false);
  });
});

describe("locate, on a fresh capture from a real desktop", () => {
  const chromium = { app: "Chromium", pid: 5092, kind: "frame" as const, title: "anything, because a title is not part of a window's identity" };
  const signIn = { role: "button", name: "Sign in", states: [], box: { x: 464, y: 438, w: 352, h: 40 } };
  const click = (aim: { window: typeof chromium; element: typeof signIn }): AimedInvocation => ({ name: "desktop_click", args: { mark: 1, button: "left" }, aim });
  const key = (window: typeof chromium | null): AimedInvocation => ({ name: "desktop_key", args: { keys: "ctrl+l" as KeyCombo, times: 1 }, aim: { window } });
  const shifted = (dy: number) => ({ ...signIn, box: { ...signIn.box, y: signIn.box.y + dy } });
  const now = recorded("chromium-over-others");

  it("finds the approved element at its center", () => {
    expect(locate(now, click({ window: chromium, element: signIn }))).toMatchObject({ kind: "at", x: 640, y: 458 });
  });

  it("follows an element that moved up to 24 px, and refuses one that moved further", () => {
    expect(locate(now, click({ window: chromium, element: shifted(-24) }))).toMatchObject({ kind: "at", x: 640, y: 458 });
    expect(locate(now, click({ window: chromium, element: shifted(-25) })).kind).toBe("stale");
  });

  it("refuses an element that was renamed, or that another app or process shows", () => {
    expect(locate(now, click({ window: chromium, element: { ...signIn, name: "Sign up" } })).kind).toBe("stale");
    expect(locate(now, click({ window: { ...chromium, app: "thunar" }, element: signIn })).kind).toBe("stale");
    expect(locate(now, click({ window: { ...chromium, pid: 1 }, element: signIn })).kind).toBe("stale");
  });

  it("never finds an element that another window now covers", () => {
    const thunarBack = { role: "button", name: "Back", states: [], box: { x: 9, y: 85, w: 37, h: 35 } };
    expect(locate(recorded("terminal-active"), click({ window: chromium, element: signIn })).kind).toBe("stale");
    expect(locate(now, click({ window: { ...chromium, app: "thunar", pid: 5258, title: "File System - Thunar" }, element: thunarBack })).kind).toBe("stale");
  });

  it("sends a key only to the window the look showed as active", () => {
    expect(locate(now, key(chromium))).toMatchObject({ kind: "focus", window: { app: "Chromium" } });
    expect(locate(recorded("terminal-active"), key(chromium))).toMatchObject({ kind: "stale", why: expect.stringContaining("xfce4-terminal") });
    expect(locate(recorded("file-chooser"), key(chromium)).kind).toBe("stale");
    expect(locate(recorded("inaccessible-dialog"), key(null))).toMatchObject({ kind: "focus", window: null });
  });

  it("types where the focus is only while the focused field still has it", () => {
    const username = { role: "entry", name: "Username or email address", value: "", states: ["focused" as const], box: { x: 464, y: 301, w: 352, h: 40 } };
    const type = (element: typeof username | null): AimedInvocation => ({ name: "desktop_type", args: { text: "ada", replace: false, submit: false }, aim: { window: chromium, element } });
    expect(locate(now, type(username)).kind).toBe("focus");
    expect(locate(now, type({ ...username, name: "Password" })).kind).toBe("stale");
    expect(locate(now, type(null)).kind).toBe("focus");
  });
});

describe("inputPlan and summaryOf", () => {
  const window = { app: "Chromium", pid: 7, kind: "frame" as const, title: "t" };
  const element = { role: "entry", name: "Address and search bar", states: [], box: { x: 0, y: 0, w: 10, h: 10 } };
  const at = { kind: "at" as const, x: 5, y: 6, element, window };
  const focus = { kind: "focus" as const, window };

  it("clicks, double-clicks, and right-clicks at the element's center", () => {
    const click = (button: "left" | "double" | "right"): AimedInvocation => ({ name: "desktop_click", args: { mark: 1, button }, aim: { window, element } });
    expect(inputPlan(click("left"), at)).toEqual([{ kind: "move", x: 5, y: 6 }, { kind: "click", button: 1, count: 1 }]);
    expect(inputPlan(click("double"), at)).toEqual([{ kind: "move", x: 5, y: 6 }, { kind: "click", button: 1, count: 2 }]);
    expect(inputPlan(click("right"), at)).toEqual([{ kind: "move", x: 5, y: 6 }, { kind: "click", button: 3, count: 1 }]);
    expect(summaryOf(click("double"), at)).toBe('Double-clicked entry "Address and search bar" in Chromium.');
  });

  it("clicks a mark before typing, selects all to replace, and presses Enter to submit", () => {
    const typed: AimedInvocation = { name: "desktop_type", args: { mark: 1, text: "example.com", replace: true, submit: true }, aim: { window, element } };
    expect(inputPlan(typed, at)).toEqual([
      { kind: "move", x: 5, y: 6 },
      { kind: "click", button: 1, count: 1 },
      { kind: "key", combo: "ctrl+a", times: 1 },
      { kind: "type", text: "example.com" },
      { kind: "key", combo: "Return", times: 1 },
    ]);
    expect(summaryOf(typed, at)).toBe('Replaced the text and typed 11 characters into entry "Address and search bar" in Chromium, then pressed Enter.');
  });

  it("types where the focus is with no mark, presses keys, and turns the wheel", () => {
    const typed: AimedInvocation = { name: "desktop_type", args: { text: "ls", replace: false, submit: false }, aim: { window, element: null } };
    expect(inputPlan(typed, focus)).toEqual([{ kind: "type", text: "ls" }]);
    expect(summaryOf(typed, focus)).toBe("Typed 2 characters where the keyboard focus is in Chromium.");
    const pressed: AimedInvocation = { name: "desktop_key", args: { keys: "Tab" as KeyCombo, times: 3 }, aim: { window } };
    expect(inputPlan(pressed, focus)).toEqual([{ kind: "key", combo: "Tab", times: 3 }]);
    expect(summaryOf(pressed, focus)).toBe("Pressed Tab 3 times in Chromium.");
    const scrolled: AimedInvocation = { name: "desktop_scroll", args: { mark: 1, direction: "down", amount: 3 }, aim: { window, element } };
    expect(inputPlan(scrolled, at)).toEqual([{ kind: "move", x: 5, y: 6 }, { kind: "wheel", button: 5, count: 3 }]);
  });
});
