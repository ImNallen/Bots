import { useSyncExternalStore } from "react";

// styles.css switches its layout at the same width.
const phone = window.matchMedia("(max-width: 1023.98px)");
const coarsePointer = window.matchMedia("(pointer: coarse)");

function useMatches(query: MediaQueryList): boolean {
  return useSyncExternalStore(
    (onChange) => {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => query.matches,
  );
}

export function useIsPhone(): boolean {
  return useMatches(phone);
}

export function useHasCoarsePointer(): boolean {
  return useMatches(coarsePointer);
}
