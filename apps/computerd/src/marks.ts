import {
  MAX_MARKS,
  type AimedInvocation,
  type Box,
  type DESKTOP_BUTTONS,
  type Element,
  type ElementState,
  type KeyCombo,
  type MarkedElement,
  type SCROLL_DIRECTIONS,
  type ScreenView,
  type WindowKind,
  type WindowRef,
} from "@bots/protocol";
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

export const MOVE_TOLERANCE_PX = 24;

export type Located = { kind: "at"; x: number; y: number; element: Element; window: WindowRef } | { kind: "focus"; window: WindowRef | null } | { kind: "stale"; why: string };

const sameWindow = (a: WindowRef | null, b: WindowRef | null): boolean =>
  a === null || b === null ? a === b : a.app === b.app && a.pid === b.pid && a.kind === b.kind;

function activeWindowOf(captured: Capture): WindowRef | null {
  const { view } = selectMarks(captured);
  return view.active === null ? null : (view.windows[view.active] ?? null);
}

function find(candidates: readonly Candidate[], aim: { window: WindowRef; element: Element }): Candidate | null {
  const target = centerOf(aim.element.box);
  const distance = (candidate: Candidate) => {
    const center = centerOf(candidate.element.box);
    return Math.hypot(center.x - target.x, center.y - target.y);
  };
  const matches = candidates
    .filter(({ window, element }) => sameWindow(window, aim.window) && element.role === aim.element.role && element.name === aim.element.name)
    .filter((candidate) => distance(candidate) <= MOVE_TOLERANCE_PX)
    .sort((a, b) => distance(a) - distance(b));
  return matches[0] ?? null;
}

// Finds what the owner approved in a fresh capture: the same app, process, window kind, role, and name, with its center within
// MOVE_TOLERANCE_PX of where the look showed it, and the nearest of several. A key and typing with no mark need the same active
// window, and typing needs the element that had the focus to have it still.
export function locate(captured: Capture, tool: AimedInvocation): Located {
  switch (tool.name) {
    case "desktop_click":
    case "desktop_scroll":
      return locateElement(captured, tool.aim);
    case "desktop_type":
      if (tool.args.mark !== undefined) {
        return tool.aim.window === null || tool.aim.element === null ? { kind: "stale", why: "the aim has no element" } : locateElement(captured, { window: tool.aim.window, element: tool.aim.element });
      }
      return locateFocus(captured, tool.aim);
    case "desktop_key":
      return locateFocus(captured, { window: tool.aim.window, element: null });
  }
}

function locateElement(captured: Capture, aim: { window: WindowRef; element: Element }): Located {
  const found = find(selectMarks(captured).candidates, aim);
  if (found === null) {
    return { kind: "stale", why: `${elementLabel(aim.element)} is not where the last look showed it` };
  }
  const { x, y } = centerOf(found.element.box);
  return { kind: "at", x, y, element: found.element, window: found.window };
}

function locateFocus(captured: Capture, aim: { window: WindowRef | null; element: Element | null }): Located {
  const active = activeWindowOf(captured);
  if (!sameWindow(active, aim.window)) {
    return { kind: "stale", why: `the active window is ${active === null ? "none" : `${active.app} ${JSON.stringify(active.title)}`} now, not the one the last look showed` };
  }
  if (aim.element !== null && aim.window !== null) {
    const found = find(selectMarks(captured).candidates, { window: aim.window, element: aim.element });
    if (found === null || !found.element.states.includes("focused")) {
      return { kind: "stale", why: `${elementLabel(aim.element)} no longer has the keyboard focus` };
    }
  }
  return { kind: "focus", window: active };
}

export type InputStep =
  | { kind: "move"; x: number; y: number }
  | { kind: "click"; button: 1 | 2 | 3; count: 1 | 2 }
  | { kind: "wheel"; button: 4 | 5 | 6 | 7; count: number }
  | { kind: "key"; combo: KeyCombo; times: number }
  | { kind: "type"; text: string };

const CLICKS: Readonly<Record<(typeof DESKTOP_BUTTONS)[number], Extract<InputStep, { kind: "click" }>>> = {
  left: { kind: "click", button: 1, count: 1 },
  middle: { kind: "click", button: 2, count: 1 },
  right: { kind: "click", button: 3, count: 1 },
  double: { kind: "click", button: 1, count: 2 },
};
const WHEEL: Readonly<Record<(typeof SCROLL_DIRECTIONS)[number], 4 | 5 | 6 | 7>> = { up: 4, down: 5, left: 6, right: 7 };
const SELECT_ALL = "ctrl+a" as KeyCombo;
const ENTER = "Return" as KeyCombo;

export function inputPlan(tool: AimedInvocation, located: Exclude<Located, { kind: "stale" }>): InputStep[] {
  const at = located.kind === "at" ? [{ kind: "move" as const, x: located.x, y: located.y }] : [];
  switch (tool.name) {
    case "desktop_click":
      return [...at, CLICKS[tool.args.button]];
    case "desktop_scroll":
      return [...at, { kind: "wheel", button: WHEEL[tool.args.direction], count: tool.args.amount }];
    case "desktop_key":
      return [{ kind: "key", combo: tool.args.keys, times: tool.args.times }];
    case "desktop_type":
      return [
        ...(located.kind === "at" ? [...at, CLICKS.left] : []),
        ...(tool.args.replace ? [{ kind: "key" as const, combo: SELECT_ALL, times: 1 }] : []),
        { kind: "type", text: tool.args.text },
        ...(tool.args.submit ? [{ kind: "key" as const, combo: ENTER, times: 1 }] : []),
      ];
  }
}

export function elementLabel(element: Pick<Element, "role" | "name">): string {
  return `${element.role} ${JSON.stringify(element.name)}`;
}

function windowLabel(window: WindowRef | null): string {
  return window === null ? "no window" : window.kind === "panel" ? "the panel" : window.app;
}

// Names, never mark numbers, because the numbers belong to a look that is now old. Typed text is counted, not repeated.
export function summaryOf(tool: AimedInvocation, located: Exclude<Located, { kind: "stale" }>): string {
  const target = located.kind === "at" ? `${elementLabel(located.element)} in ${windowLabel(located.window)}` : `where the keyboard focus is in ${windowLabel(located.window)}`;
  switch (tool.name) {
    case "desktop_click":
      return `${{ left: "Clicked", right: "Right-clicked", middle: "Middle-clicked", double: "Double-clicked" }[tool.args.button]} ${target}.`;
    case "desktop_scroll":
      return `Scrolled ${tool.args.direction} ${tool.args.amount} over ${target}.`;
    case "desktop_key":
      return `Pressed ${tool.args.keys}${tool.args.times > 1 ? ` ${tool.args.times} times` : ""} in ${windowLabel(located.window)}.`;
    case "desktop_type": {
      const replaced = tool.args.replace ? "Replaced the text and typed" : "Typed";
      return `${replaced} ${tool.args.text.length} characters ${located.kind === "at" ? `into ${target}` : target}${tool.args.submit ? ", then pressed Enter" : ""}.`;
    }
  }
}
