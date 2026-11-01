import { useEffect } from "react";
import { create } from "zustand";

/**
 * A message typed before its conversation existed (todo13 D1: Home's first send). Home
 * creates the project, queues the text here and opens the project with the drawer; the
 * drawer's conversation sends it once it's ready (agent configured, consent given). Held in
 * memory only: a reload drops it, as it would drop an unsent draft.
 */
interface PendingAsks {
  asks: Record<string, string>;
  queue: (projectId: string, text: string) => void;
  take: (projectId: string) => string | undefined;
}

export const usePendingAsks = create<PendingAsks>((set, get) => ({
  asks: {},
  queue: (projectId, text) => set((s) => ({ asks: { ...s.asks, [projectId]: text } })),
  take: (projectId) => {
    const text = get().asks[projectId];
    if (text !== undefined) set((s) => ({ asks: Object.fromEntries(Object.entries(s.asks).filter(([k]) => k !== projectId)) }));
    return text;
  },
}));

/** In the conversation: send the queued message for this project once, when mounted. */
export function usePendingAsk(projectId: string, ask: (text: string) => void): void {
  const pending = usePendingAsks((s) => s.asks[projectId]);
  useEffect(() => {
    if (pending === undefined) return;
    const text = usePendingAsks.getState().take(projectId);
    if (text) ask(text);
    // `ask` changes every render; the queued text is what triggers this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pending]);
}
