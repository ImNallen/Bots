import type { AimedInvocation, Box, DesktopInputRequest, Element, MarkedElement, ScreenView, WindowRef } from "@bots/protocol";

// The newest look of a run, as the screens row holds it.
export type StoredScreen = {
  toolCallId: string;
  view: Omit<ScreenView, "image">;
  image: { mediaType: "image/png" | "image/jpeg"; bytes: Uint8Array } | null;
};

// What the model reads for the newest look. imageUrl is a data URL, or null for a look whose picture was not kept or did not fit.
export type ShownScreen = { toolCallId: string; text: string; imageUrl: string | null };

export const OLDER_LOOK =
  "[Only the newest look's picture and marks are shown. A mark from an older look no longer works, so call desktop_look for new marks.]";

export function windowName(window: WindowRef): string {
  if (window.kind === "panel") {
    return "the panel";
  }
  return window.title === "" ? `${window.app}, a ${window.kind} with no title` : `${window.app} ${JSON.stringify(window.title)}`;
}

export function elementName(element: Pick<MarkedElement, "role" | "name">): string {
  return `${element.role} ${JSON.stringify(element.name)}`;
}

function markLine(mark: MarkedElement): string {
  const value = mark.value === undefined ? "" : ` = ${JSON.stringify(mark.value)}`;
  const states = mark.states.length === 0 ? "" : ` (${mark.states.join(", ")})`;
  return `[${mark.mark}] ${elementName(mark)}${value}${states}`;
}

// Names and values are page content, so each one is a JSON string, and a line break in one cannot start a line of its own.
export function screenText(view: Omit<ScreenView, "image">): string {
  const active = view.active === null ? null : view.windows[view.active];
  const lines = [`Screen ${view.width}x${view.height}. ${active === undefined || active === null ? "No window is active." : `Active window: ${windowName(active)}.`}`];
  const others = view.windows.filter((window, index) => index !== view.active && !view.marks.some((mark) => mark.win === index));
  if (others.length > 0) {
    lines.push(`Other windows, reached through their button on the panel: ${others.map(windowName).join(", ")}.`);
  }
  if (view.silent.includes("accessibility")) {
    lines.push("This desktop cannot list what is on the screen now, so this look has no marks. Use desktop_key, or try again later.");
  }
  const silentApps = view.silent.filter((app) => app !== "accessibility");
  if (silentApps.length > 0) {
    lines.push(`These apps did not answer in time, so their elements may be missing: ${silentApps.join(", ")}.`);
  }
  if (view.marks.length > 0) {
    lines.push("Marks from this look. Every look numbers them again.");
  }
  let window: number | null = null;
  for (const mark of view.marks) {
    if (mark.win !== window) {
      window = mark.win;
      const ref = view.windows[mark.win];
      lines.push(ref === undefined ? "An unknown window:" : `${ref.kind === "panel" ? "The panel" : windowName(ref)}:`);
    }
    lines.push(markLine(mark));
  }
  if (view.unlisted > 0) {
    lines.push(`${view.unlisted} more elements are not listed. Scroll or close something to reach them.`);
  }
  return lines.join("\n");
}

export function shownScreen(screen: StoredScreen | null): ShownScreen | undefined {
  if (screen === null) {
    return undefined;
  }
  const { toolCallId, view, image } = screen;
  return image === null
    ? { toolCallId, text: `${screenText(view)}\n[This look has no picture.]`, imageUrl: null }
    : { toolCallId, text: screenText(view), imageUrl: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}` };
}

export type Aimed = { kind: "ready"; tool: AimedInvocation } | { kind: "invalid"; reason: string };

const NO_LOOK = "Call desktop_look first. A mark comes from a look in this run.";

function markOf(view: Omit<ScreenView, "image">, mark: number): { window: WindowRef; element: Element } | null {
  const found = view.marks.find((entry) => entry.mark === mark);
  const window = found === undefined ? undefined : view.windows[found.win];
  if (found === undefined || window === undefined) {
    return null;
  }
  const { mark: _mark, win: _win, ...element } = found;
  return { window, element };
}

// A mark means the element that the run's newest look numbered, and nothing else can give it a meaning. The aim is what the owner
// approves, and computerd acts only if it finds that element again.
export function aimDesktopInput(args: { request: DesktopInputRequest; screen: StoredScreen | null }): Aimed {
  const { request, screen } = args;
  if (screen === null) {
    return { kind: "invalid", reason: NO_LOOK };
  }
  const { view } = screen;
  const active = view.active === null ? null : (view.windows[view.active] ?? null);
  const missing = (mark: number): Aimed => ({ kind: "invalid", reason: `There is no mark ${mark} in the newest look. Every look numbers the marks again, so use a mark from the newest one.` });
  switch (request.name) {
    case "desktop_click":
    case "desktop_scroll": {
      const aim = markOf(view, request.args.mark);
      return aim === null ? missing(request.args.mark) : { kind: "ready", tool: { ...request, aim } };
    }
    case "desktop_type": {
      if (request.args.mark !== undefined) {
        const aim = markOf(view, request.args.mark);
        return aim === null ? missing(request.args.mark) : { kind: "ready", tool: { ...request, aim } };
      }
      const focused = view.marks.find((mark) => mark.win === view.active && mark.states.includes("focused"));
      const element = focused === undefined ? null : (markOf(view, focused.mark)?.element ?? null);
      return { kind: "ready", tool: { ...request, aim: { window: active, element } } };
    }
    case "desktop_key":
      return { kind: "ready", tool: { ...request, aim: { window: active } } };
  }
}

function inWindow(window: WindowRef | null): string {
  return window === null ? "with no window active" : window.kind === "panel" ? "on the panel" : `in ${window.app}`;
}

// The card's words, and the box that the card outlines on the stored picture. A type card also shows the text in full, from the
// call's own arguments.
export function approvalDetail(tool: AimedInvocation): { subject: string; box?: Box } {
  switch (tool.name) {
    case "desktop_click": {
      const verb = { left: "Click", right: "Right-click", middle: "Middle-click", double: "Double-click" }[tool.args.button];
      return { subject: `${verb} ${elementName(tool.aim.element)} ${inWindow(tool.aim.window)}`, box: tool.aim.element.box };
    }
    case "desktop_scroll":
      return { subject: `Scroll ${tool.args.direction} ${tool.args.amount} over ${elementName(tool.aim.element)} ${inWindow(tool.aim.window)}`, box: tool.aim.element.box };
    case "desktop_key":
      return { subject: `Press ${tool.args.keys}${tool.args.times > 1 ? ` ${tool.args.times} times` : ""} ${inWindow(tool.aim.window)}` };
    case "desktop_type": {
      const enter = tool.args.submit ? ", then press Enter" : "";
      const { element, window } = tool.aim;
      if (element === null) {
        return { subject: `Type where the keyboard focus is ${inWindow(window)}${enter}` };
      }
      const into = tool.args.mark === undefined ? `${elementName(element)}, which has the keyboard focus,` : elementName(element);
      return { subject: `${tool.args.replace ? "Replace the text in" : "Type into"} ${into} ${inWindow(window)}${enter}`, box: element.box };
    }
  }
}
