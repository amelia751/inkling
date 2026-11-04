import { useEffect } from "react";
import { create } from "zustand";
import { RES } from "@studio/contracts/naming";
import { personKey } from "@/studio/lib/dev-principal";
import { useUploads, type TraySession } from "@/studio/stores/uploads";

/**
 * A message typed before its conversation existed (todo13 D1: Home's first send or drop). Home
 * creates the project, queues the text (and, for a drop, the drop it already started in the
 * project's conversation) here and opens the project with the drawer; the drawer's
 * conversation sends it once it's ready (agent configured), even with no text (D4). The files don't
 * wait for that: they upload and land in Shared in chat at once. Kept in sessionStorage, per
 * person (todo15 D5), so a reload before the conversation is ready doesn't lose it.
 */
/** A drop already started in the conversation (Home's drop, D1/D2): the message carries it. */
export interface PendingDrop {
  dropId: string;
  messageId: string;
}

/**
 * todo24 D2: the tray upload the message waits for (Home's drop with chat drops off). The
 * message is sent only once that session stops moving, so the assistant never answers before
 * the files it's about are committed (or have definitively failed).
 */
export interface PendingUpload {
  key: string;
}

interface PendingAsk {
  text: string;
  drop?: PendingDrop;
  upload?: PendingUpload;
}

interface PendingAsks {
  asks: Record<string, PendingAsk>;
  queue: (projectId: string, text: string, drop?: PendingDrop, upload?: PendingUpload) => void;
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
  queue: (projectId, text, drop, upload) => {
    const asks = { ...loadPendingAsks(), ...get().asks, [projectId]: { text, ...(drop ? { drop } : {}), ...(upload ? { upload } : {}) } };
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

type GateSession = Pick<TraySession, "phase" | "error" | "stalled" | "files" | "total">;

/** Phases where bytes are still moving or the kernel is still checking them. */
const MOVING = new Set(["attesting", "preparing", "uploading", "checking"]);

/**
 * todo24 D2: whether a message waiting on an upload session may go, and what to add to it about
 * files that didn't make it. No session (dismissed, or the tab reloaded) or a stalled check:
 * go now rather than hold the message forever. `failed` with no error is `absorb`'s moment
 * between registering and uploading, not a failure. File names never go in the note (only
 * counts and extensions): the assistant reads screened names from the kernel, not the browser.
 */
export function uploadGate(s: GateSession | undefined): { ready: boolean; note: string } {
  if (!s) return { ready: true, note: "" };
  const moving = MOVING.has(s.phase) || (s.phase === "failed" && !s.error);
  if (moving && !s.stalled) return { ready: false, note: "" };
  const missed = s.files.length ? s.files.filter((f) => f.state === "failed" || f.state === "rejected" || f.state === "pending").map((f) => f.relPath) : s.phase === "failed" || s.phase === "cancelled" ? Array.from({ length: s.total }, () => "") : [];
  if (!missed.length) return { ready: true, note: "" };
  const total = Math.max(s.total, s.files.length);
  const exts = new Map<string, number>();
  for (const p of missed) {
    const m = /\.([a-z0-9]{1,8})$/i.exec(p);
    if (m) exts.set(`.${m[1].toLowerCase()}`, (exts.get(`.${m[1].toLowerCase()}`) ?? 0) + 1);
  }
  const kinds = [...exts].map(([e, n]) => `${n} ${e}`).join(", ");
  const head = missed.length === total ? `None of the ${total} ${total === 1 ? "file" : "files"} uploaded` : `${missed.length} of ${total} files didn't upload`;
  return { ready: true, note: `(${head}${kinds ? `: ${kinds}` : ""}.)` };
}

/** The queued text with what didn't upload appended. */
export function withUploadNote(text: string, note: string): string {
  return note ? (text ? `${text}\n\n${note}` : note) : text;
}

/**
 * In the conversation: send the queued message (and its drop) for this project once, when
 * mounted. A message queued with an upload session (todo24 D2) waits until that session stops
 * moving. Returns whether it's waiting on its files (the drawer says so).
 */
export function usePendingAsk(projectId: string, ask: (text: string, drop?: PendingDrop) => void, ready = true): boolean {
  const pending = usePendingAsks((s) => s.asks[projectId]);
  const uploadKey = pending?.upload?.key;
  const waiting = useUploads((s) => (uploadKey ? !uploadGate(s.sessions.find((x) => x.key === uploadKey)).ready : false));
  useEffect(() => {
    // todo18 D: not ready yet (status loading, session starting): keep it queued and retry when ready.
    if (pending === undefined || !ready || waiting) return;
    const queued = usePendingAsks.getState().take(projectId);
    if (!queued) return;
    const note = queued.upload ? uploadGate(useUploads.getState().sessions.find((x) => x.key === queued.upload!.key)).note : "";
    const text = withUploadNote(queued.text, note);
    if (text || queued.drop) ask(text, queued.drop);
    // `ask` changes every render; the queued text is what triggers this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, pending, ready, waiting]);
  return waiting && pending !== undefined;
}
