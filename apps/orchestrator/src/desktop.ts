import type { MarkedElement, ScreenView, WindowRef } from "@bots/protocol";

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
