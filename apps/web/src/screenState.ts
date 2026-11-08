// The computer viewer exists only while it is open, so closing it needs no state here: leaving the page ends both streams and
// gives the screen back.

export type Stream = { sendKey(keysym: number, code: string | null): void };

export type ScreenNotice = "takeoverEnded" | "takeoverRefused";

export type ScreenState =
  | { kind: "connecting"; notice: ScreenNotice | null }
  | { kind: "watching"; notice: ScreenNotice | null }
  | { kind: "ended" }
  | { kind: "requesting" }
  | { kind: "joining" }
  | { kind: "controlling"; stream: Stream }
  // The input stream ended by itself. The owner still holds the take-over until a check of who ended it finishes.
  | { kind: "lost" };

export type ScreenEvent =
  | { type: "connected"; stream: Stream }
  | { type: "disconnected" }
  | { type: "takeControl" }
  | { type: "granted" }
  | { type: "refused" }
  | { type: "giveBack" }
  | { type: "settled" }
  | { type: "retry" };

export const INITIAL_SCREEN_STATE: ScreenState = { kind: "connecting", notice: null };

export function screenReducer(state: ScreenState, event: ScreenEvent): ScreenState {
  switch (state.kind) {
    case "connecting":
      if (event.type === "connected") {
        return { kind: "watching", notice: state.notice };
      }
      return event.type === "disconnected" ? { kind: "ended" } : state;
    case "watching":
      if (event.type === "takeControl") {
        return { kind: "requesting" };
      }
      return event.type === "disconnected" ? { kind: "ended" } : state;
    case "ended":
      return event.type === "retry" ? INITIAL_SCREEN_STATE : state;
    case "requesting":
      switch (event.type) {
        case "granted":
          return { kind: "joining" };
        case "refused":
          return { kind: "watching", notice: "takeoverRefused" };
        case "disconnected":
          return { kind: "ended" };
        default:
          return state;
      }
    case "joining":
      switch (event.type) {
        case "connected":
          return { kind: "controlling", stream: event.stream };
        case "giveBack":
          return INITIAL_SCREEN_STATE;
        case "disconnected":
          return { kind: "lost" };
        default:
          return state;
      }
    case "controlling":
      if (event.type === "giveBack") {
        return INITIAL_SCREEN_STATE;
      }
      return event.type === "disconnected" ? { kind: "lost" } : state;
    case "lost":
      return event.type === "settled" ? { kind: "connecting", notice: "takeoverEnded" } : state;
  }
}

export function streamFor(state: ScreenState): "watch" | "control" | null {
  switch (state.kind) {
    case "connecting":
    case "watching":
    case "requesting":
      return "watch";
    case "joining":
    case "controlling":
      return "control";
    case "ended":
    case "lost":
      return null;
  }
}

export function holdsScreen(state: ScreenState): boolean {
  return state.kind === "requesting" || state.kind === "joining" || state.kind === "controlling" || state.kind === "lost";
}
