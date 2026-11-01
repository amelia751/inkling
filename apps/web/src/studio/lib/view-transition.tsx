import * as React from "react";
import type { ReactNode } from "react";

/**
 * `<ViewTransition>` around shell regions (todo11 Milestone 2 item 7). React 19.2's stable
 * build doesn't export it yet (only canary/experimental do), so this renders the children
 * as they are until it does; then live environment updates (applied inside
 * `startTransition`) animate with no code change. Route changes already animate through the
 * router's `viewTransition` flag (`document.startViewTransition`).
 */
const VT = (React as unknown as { ViewTransition?: React.ComponentType<{ children: ReactNode }> }).ViewTransition;

export function ShellTransition({ children }: { children: ReactNode }) {
  return VT ? <VT>{children}</VT> : <>{children}</>;
}
