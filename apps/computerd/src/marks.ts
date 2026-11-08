import { MAX_MARKS, type Box, type Element, type ElementState, type MarkedElement, type ScreenView, type WindowKind, type WindowRef } from "@bots/protocol";
import { z } from "zod";

export const PANEL_APP = "xfce4-panel";

// What the helper reports, so it walks only these roles and any node that takes focus.
export const INTERACTIVE_ROLES = [
  "button",
  "push button",
  "toggle button",
  "check box",
  "radio button",
  "menu item",
  "check menu item",
  "radio menu item",
  "menu",
  "combo box",
  "text",
  "entry",
  "password text",
  "link",
  "page tab",
  "list item",
  "tree item",
  "table cell",
  "icon",
  "spin button",
  "slider",
  "tool bar item",
  "terminal",
] as const;

// A node that takes focus counts unless it only holds other nodes.
const CONTAINER_ROLES: ReadonlySet<string> = new Set([
  "application",
  "document frame",
  "document web",
  "directory pane",
  "embedded",
  "filler",
  "form",
  "frame",
  "grouping",
  "internal frame",
  "landmark",
  "layered pane",
  "list",
  "list box",
  "menu bar",
  "page tab list",
  "panel",
  "redundant object",
  "root pane",
  "scroll pane",
  "section",
  "split pane",
  "table",
  "tool bar",
  "tree",
  "tree table",
  "unknown",
  "viewport",
  "window",
]);

// A node with no name is listed only when it takes focus or is something a person presses, such as an icon button.
const NAMELESS_ROLES: ReadonlySet<string> = new Set(["button", "push button", "toggle button", "check box", "radio button", "icon", "terminal"]);
const VALUE_ROLES: ReadonlySet<string> = new Set(["entry", "text", "combo box", "spin button", "slider"]);
const KINDS: Readonly<Record<string, WindowKind>> = {
  dialog: "dialog",
  alert: "dialog",
  "file chooser": "dialog",
  "color chooser": "dialog",
  "font chooser": "dialog",
  window: "popup",
  menu: "popup",
  "popup menu": "popup",
};
// Lower comes first in the list. A popup is what the bot or the owner just opened, and the panel reaches every other window.
const KIND_ORDER: Readonly<Record<WindowKind, number>> = { popup: 0, dialog: 2, frame: 3, panel: 4 };
const ACTIVE_ORDER = 1;
const SILENT_ACCESSIBILITY = "accessibility";

const label = (max: number) => z.string().max(max);
const pid = z.number().int().min(1);
const anyBox = z.strictObject({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });

// The helper runs as browser, whose processes render web pages, so what it prints is parsed like any other input from outside.
export const capture = z.strictObject({
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  bus: z.enum(["ok", "missing", "failed"]),
  apps: z.array(z.strictObject({ app: label(40), pid, silent: z.boolean() })).max(64),
  windows: z
    .array(
      z.strictObject({
        win: z.number().int().min(0),
        app: label(40),
        pid,
        role: label(32),
        title: label(120),
        box: anyBox,
        active: z.boolean(),
        modal: z.boolean(),
      }),
    )
    .max(128),
  nodes: z
    .array(
      z.strictObject({
        win: z.number().int().min(0),
        role: label(32),
        name: label(120),
        value: label(100).nullable(),
        states: z.array(label(32)).max(24),
        focusable: z.boolean(),
        box: anyBox,
        // The open menu that this node is in, as an index into menus.
        menu: z.number().int().min(0).nullable().default(null),
      }),
    )
    .max(4000),
  // Where each menu covers its own window. A closed menu has an empty box.
  menus: z.array(z.strictObject({ win: z.number().int().min(0), box: anyBox })).max(4000).default([]),
});
export type Capture = z.infer<typeof capture>;
type CapturedWindow = Capture["windows"][number];

export type Candidate = { window: WindowRef; element: Element };
export type Selection = { view: Omit<ScreenView, "image">; candidates: Candidate[] };

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

export function centerOf(box: Box): { x: number; y: number } {
  return { x: box.x + Math.floor(box.w / 2), y: box.y + Math.floor(box.h / 2) };
}

function contains(box: Box, point: { x: number; y: number }): boolean {
  return point.x >= box.x && point.x < box.x + box.w && point.y >= box.y && point.y < box.y + box.h;
}

function kindOf(window: CapturedWindow): WindowKind {
  return window.app === PANEL_APP ? "panel" : (KINDS[window.role] ?? "frame");
}

function statesOf(states: readonly string[]): ElementState[] {
  const has = new Set(states);
  const listed: ElementState[] = ["focused", "checked", "pressed", "selected", "expanded"].filter((state) => has.has(state)) as ElementState[];
  return has.has("enabled") ? listed : [...listed, "disabled"];
}

function listable(node: Capture["nodes"][number]): boolean {
  const interactive = (INTERACTIVE_ROLES as readonly string[]).includes(node.role) || (node.focusable && !CONTAINER_ROLES.has(node.role));
  return interactive && (node.name !== "" || node.focusable || NAMELESS_ROLES.has(node.role));
}

// The rule that keeps a mark off a window that something covers:
// 1. The active window is the newest window marked active that lies on the screen. The window manager keeps one off it.
// 2. The listed windows are the panel's and those of the active window's process. With no active window, only the panel's.
// 3. A modal dialog that is active hides the other frames and dialogs of its process.
// 4. A node is dropped when its center lies outside its own window or the screen, or inside the panel, or inside a popup or the
//    active window that is not its own window. A popup sits over its process's other windows, and the active window over the rest.
//    A node is also dropped inside an open menu of its own window that it is not part of, because GTK opens a menu bar's menu
//    inside the window.
// 5. Popups come first, then the active window, then dialogs, then frames, then the panel, each in the order the tree gives.
export function selectMarks(captured: Capture): Selection {
  const screen: Box = { x: 0, y: 0, w: captured.width, h: captured.height };
  const onScreen = captured.windows.filter((window) => intersect(window.box, screen) !== null && window.box.w > 0 && window.box.h > 0);
  const active = onScreen.findLast((window) => window.active && kindOf(window) !== "panel") ?? null;
  const modal = active !== null && active.modal && kindOf(active) === "dialog";
  const listed = onScreen.filter((window) => {
    if (kindOf(window) === "panel") {
      return true;
    }
    if (active === null || window.pid !== active.pid) {
      return false;
    }
    return window === active || kindOf(window) === "popup" || !modal;
  });
  const covers = (window: CapturedWindow): Box[] =>
    kindOf(window) === "panel"
      ? []
      : listed
          .filter((other) => other !== window && (kindOf(other) === "panel" || kindOf(other) === "popup" || (other === active && kindOf(window) !== "popup")))
          .map((other) => other.box);
  const rank = (window: CapturedWindow): number => (window === active && kindOf(window) !== "popup" ? ACTIVE_ORDER : KIND_ORDER[kindOf(window)]);
  const ordered = listed.map((window, index) => ({ window, index })).sort((a, b) => rank(a.window) - rank(b.window) || a.index - b.index);

  const refs = new Map<CapturedWindow, WindowRef>();
  const refOf = (window: CapturedWindow): WindowRef => {
    let ref = refs.get(window);
    if (ref === undefined) {
      ref = { app: window.app, pid: window.pid, kind: kindOf(window), title: window.title };
      refs.set(window, ref);
    }
    return ref;
  };
  const candidates: Candidate[] = [];
  for (const { window } of ordered) {
    const over = covers(window);
    const visible = intersect(window.box, screen);
    for (const node of captured.nodes) {
      if (captured.windows[node.win] !== window || !listable(node) || visible === null) {
        continue;
      }
      const shown = intersect(node.box, visible);
      if (shown === null || !contains(shown, centerOf(node.box)) || over.some((box) => contains(box, centerOf(shown)))) {
        continue;
      }
      const menus = captured.menus.filter((menu, index) => menu.win === node.win && index !== node.menu && menu.box.w > 0 && menu.box.h > 0);
      if (menus.some((menu) => contains(menu.box, centerOf(shown)))) {
        continue;
      }
      const value = VALUE_ROLES.has(node.role) && node.value !== null ? { value: node.value } : {};
      candidates.push({ window: refOf(window), element: { role: node.role, name: node.name, ...value, states: statesOf(node.states), box: shown } });
    }
  }

  const marked = candidates.slice(0, MAX_MARKS);
  const panelButtons = new Set(candidates.filter(({ window }) => window.kind === "panel").map(({ element }) => element.name));
  const others = onScreen.filter((window) => !listed.includes(window) && window.title !== "" && panelButtons.has(window.title));
  const windows: WindowRef[] = [];
  const indexOf = (ref: WindowRef): number => {
    const at = windows.indexOf(ref);
    return at >= 0 ? at : windows.push(ref) - 1;
  };
  const marks: MarkedElement[] = marked.map((candidate, at) => ({ ...candidate.element, mark: at + 1, win: indexOf(candidate.window) }));
  const activeIndex = active === null ? null : indexOf(refOf(active));
  for (const window of others) {
    if (windows.length < 32) {
      indexOf(refOf(window));
    }
  }
  const silent = captured.bus === "ok" ? captured.apps.filter((app) => app.silent).map((app) => app.app) : [SILENT_ACCESSIBILITY];
  return {
    view: {
      width: captured.width,
      height: captured.height,
      windows,
      active: activeIndex,
      marks,
      unlisted: candidates.length - marked.length,
      silent: [...new Set(silent)].slice(0, 16),
    },
    candidates,
  };
}
