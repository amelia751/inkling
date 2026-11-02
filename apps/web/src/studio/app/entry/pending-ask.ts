import { useEffect } from "react";
import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { personKey } from "@/studio/lib/dev-principal";

/**
 * A message typed before its conversation existed (todo13 D1: Home's first send or drop). Home
 * creates the project, queues the text (and, for a drop, the drop it already started in the
 * project's conversation) here and opens the project with the drawer; the drawer's
 * conversation sends it once it's ready (agent configured, consent given). The files don't
 * wait for that: they upload and land in Shared in chat at once. Kept in sessionStorage, per
 * person (todo15 D5), so a reload before the conversation is ready doesn't lose it.
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

const storageKey = () => personKey(`${RES}-pending-asks`);

/** The queued messages this person left in this tab (none when storage is blocked or garbled). */
export function loadPendingAsks(): Record<string, PendingAsk> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey()) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw as Record<string, PendingAsk>).filter(([, a]) => a && typeof a.text === "string"));
  } catch {
    return {};
  }
}

function savePendingAsks(asks: Record<string, PendingAsk>): void {
  try {
    if (Object.keys(asks).length) sessionStorage.setItem(storageKey(), JSON.stringify(asks));
    else sessionStorage.removeItem(storageKey());
  } catch {
    /* storage blocked: memory only */
  }
}

export const usePendingAsks = create<PendingAsks>((set, get) => ({
  asks: loadPendingAsks(),
  queue: (projectId, text, drop) => {
    const asks = { ...loadPendingAsks(), ...get().asks, [projectId]: { text, ...(drop ? { drop } : {}) } };
    savePendingAsks(asks);
    set({ asks });
  },
  take: (projectId) => {
    const all = { ...loadPendingAsks(), ...get().asks };
    const ask = all[projectId];
    if (ask !== undefined) {
      const asks = Object.fromEntries(Object.entries(all).filter(([k]) => k !== projectId));
      savePendingAsks(asks);
      set({ asks });
    }
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
