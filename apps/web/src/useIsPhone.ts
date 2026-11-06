import { useSyncExternalStore } from "react";

// styles.css switches its layout at the same width.
const phone = window.matchMedia("(max-width: 759.98px)");

function subscribe(onChange: () => void): () => void {
  phone.addEventListener("change", onChange);
  return () => phone.removeEventListener("change", onChange);
}

export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribe, () => phone.matches);
}
