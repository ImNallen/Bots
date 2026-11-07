export type Appearance = "system" | "light" | "dark";
const STORAGE_KEY = "bots.appearance";

export function parseAppearance(value: string | null): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

export function readAppearance(): Appearance {
  try {
    return parseAppearance(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "system";
  }
}

function applyAppearance(value: Appearance) {
  document.documentElement.dataset.theme = value === "system"
    ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    : value;
}

export function setAppearance(value: Appearance) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // The choice still applies when the browser disallows persistent storage.
  }
  applyAppearance(value);
}

export function initializeAppearance() {
  applyAppearance(readAppearance());
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyAppearance(readAppearance()));
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) applyAppearance(readAppearance());
  });
}
