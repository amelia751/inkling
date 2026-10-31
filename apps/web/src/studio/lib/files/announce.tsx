import { create } from "zustand";
import { toast } from "@studio/ui/ui/sonner";

/**
 * Feedback for file operations (todo7 §2 Feedback): one sentence goes to a toast (sonner,
 * bottom-left, 6s, paused on hover, with **Undo** when there's one) and to a polite live
 * region for screen readers. Rapid operations collapse into one toast ("+2 more").
 */

interface LiveState {
  text: string;
  say: (text: string) => void;
}

const useLive = create<LiveState>((set, get) => ({
  text: "",
  // A trailing zero-width space toggles so the same sentence twice is announced twice.
  say: (text) => set({ text: get().text === text ? `${text}​` : text }),
}));

/** Screen readers only: say `text` politely. */
export const announce = (text: string): void => useLive.getState().say(text);

/** The polite live region. Mounted once at the app root (boot.tsx). */
export function LiveRegion() {
  const text = useLive((s) => s.text);
  return (
    <div aria-live="polite" aria-atomic="true" role="status" className="sr-only" data-testid="files-live-region">
      {text}
    </div>
  );
}

export interface NotifyOptions {
  /** Adds an **Undo** action to the toast. */
  undo?: () => void;
  /** Smaller second line (e.g. "12 identical files skipped", a dataset warning). */
  description?: string;
  tone?: "info" | "success" | "error";
  /** Toasts with the same group within `COLLAPSE_MS` replace each other (default "files"). */
  group?: string;
}

const COLLAPSE_MS = 2000;
const recent = new Map<string, { at: number; count: number; id: string | number }>();

/**
 * Tell the person what happened: a toast plus the live region. Returns the toast id (to
 * update or dismiss it, e.g. a ZIP's progress).
 */
export function notify(text: string, { undo, description, tone = "info", group = "files" }: NotifyOptions = {}): string | number {
  announce(description ? `${text}. ${description}` : text);
  const now = Date.now();
  const prev = recent.get(group);
  const collapsed = prev && now - prev.at < COLLAPSE_MS;
  const count = collapsed ? prev.count + 1 : 1;
  const id = collapsed ? prev.id : `${group}-${now}`;
  const more = count > 1 ? `+${count - 1} more` : undefined;
  const options = {
    id,
    description: [description, more].filter(Boolean).join(" · ") || undefined,
    action: undo ? { label: "Undo", onClick: () => undo() } : undefined,
  };
  if (tone === "error") toast.error(text, options);
  else if (tone === "success") toast.success(text, options);
  else toast(text, options);
  recent.set(group, { at: now, count, id });
  return id;
}

/** Dismiss a toast `notify` returned. */
export const dismissNotice = (id: string | number): void => {
  toast.dismiss(id);
};
