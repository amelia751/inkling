import { useSyncExternalStore } from "react";

/** Layout breakpoints, matching Tailwind's `md` and `lg`. */
export const BREAKPOINTS = { md: 768, lg: 1024 } as const;

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** "phone" < 768 ≤ "tablet" < 1024 ≤ "desktop". */
export function useViewport(): "phone" | "tablet" | "desktop" {
  const md = useMediaQuery(`(min-width: ${BREAKPOINTS.md}px)`);
  const lg = useMediaQuery(`(min-width: ${BREAKPOINTS.lg}px)`);
  return lg ? "desktop" : md ? "tablet" : "phone";
}

export function useWindowWidth(): number {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("resize", onChange);
      return () => window.removeEventListener("resize", onChange);
    },
    () => window.innerWidth,
    () => 1280,
  );
}
