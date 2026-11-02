import { useEffect } from "react";
import { create } from "zustand";

/**
 * A message typed before its conversation existed (todo13 D1: Home's first send or drop). Home
 * creates the project, queues the text (and, for a drop, the drop it already started in the
 * project's conversation) here and opens the project with the drawer; the drawer's
 * conversation sends it once it's ready (agent configured), even with no text (D4). The files don't
 * wait for that: they upload and land in Shared in chat at once. Held in memory only: a
 * reload drops the message, as it would drop an unsent draft (the drop stays in Files).
 */
/** A drop already started in the conversation (Home's drop, D1/D2): the message carries it. */
export interface PendingDrop {
  dropId: string;
  messageId: string;
}

interface PendingAsk {
  text: string;
  drop?: PendingDrop;
}

interface PendingAsks {
  asks: Record<string, PendingAsk>;
  queue: (projectId: string, text: string, drop?: PendingDrop) => void;
  take: (projectId: string) => PendingAsk | undefined;
}

export const usePendingAsks = create<PendingAsks>((set, get) => ({
  asks: {},
  queue: (projectId, text, drop) => set((s) => ({ asks: { ...s.asks, [projectId]: { text, ...(drop ? { drop } : {}) } } })),
  take: (projectId) => {
    const ask = get().asks[projectId];
    if (ask !== undefined) set((s) => ({ asks: Object.fromEntries(Object.entries(s.asks).filter(([k]) => k !== projectId)) }));
    return ask;
  },
}));

/** In the conversation: send the queued message (and its drop) for this project once, when mounted. */
export function usePendingAsk(projectId: string, ask: (text: string, drop?: PendingDrop) => void): void {
  const pending = usePendingAsks((s) => s.asks[projectId]);
  useEffect(() => {
    if (pending === undefined) return;
    const queued = usePendingAsks.getState().take(projectId);
    if (queued && (queued.text || queued.drop)) ask(queued.text, queued.drop);
    // `ask` changes every render; the queued text is what triggers this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pending]);
}
