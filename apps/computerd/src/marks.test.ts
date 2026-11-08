import { readFileSync } from "node:fs";
import { MAX_MARKS, type ScreenView } from "@bots/protocol";
import { describe, expect, it } from "vitest";
import { capture, centerOf, selectMarks, type Capture } from "./marks.ts";

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
