import { create } from "zustand";
import { persist } from "zustand/middleware";
import { RES } from "@studio/contracts/naming";
import type { DropOriginKind } from "@studio/contracts/drops";

/**
 * Drops this browser started (todo13-drops). The kernel is the record (`GET /drops/:id`); this
 * keeps what only the browser knows: the tray entries uploading the drop's bytes, local previews
 * of images (object URLs of the person's own files, never sent anywhere) and, persisted, enough
 * to say "Upload paused: choose the same files to continue" after a reload.
 */
export interface LocalDropFile {
  relPath: string;
  size: number;
  /** An object URL for an image the person dropped (memory only). */
  preview?: string;
}

export interface LocalDrop {
  id: string;
  projectId: string;
  origin: DropOriginKind;
  conversationId?: string;
  taskId?: string;
  /** The files as dropped, before the kernel knows them. */
  files: LocalDropFile[];
  /** `useUploads` entries carrying the bytes (memory only: gone after a reload). */
  uploadKeys: string[];
  /** The kernel refused the drop (over the limits, rate limited, a viewer…). */
  error?: string;
  /** 413: point to Files' folder upload. */
  overLimit?: boolean;
  createdAt: number;
}

interface DropsState {
  drops: Record<string, LocalDrop>;
  put: (d: LocalDrop) => void;
  patch: (id: string, p: Partial<LocalDrop> | ((d: LocalDrop) => Partial<LocalDrop>)) => void;
  forget: (id: string) => void;
}

const KEEP = 50;

export const useDrops = create<DropsState>()(
  persist(
    (set) => ({
      drops: {},
      put: (d) => set((s) => ({ drops: { ...s.drops, [d.id]: d } })),
      patch: (id, p) =>
        set((s) => {
          const cur = s.drops[id];
          if (!cur) return s;
          return { drops: { ...s.drops, [id]: { ...cur, ...(typeof p === "function" ? p(cur) : p) } } };
        }),
      forget: (id) =>
        set((s) => {
          const drops = { ...s.drops };
          for (const f of drops[id]?.files ?? []) if (f.preview) URL.revokeObjectURL(f.preview);
          delete drops[id];
          return { drops };
        }),
    }),
    {
      name: `${RES}-drops`,
      version: 1,
      // Upload entries and object URLs don't survive a reload; the newest drops do.
      partialize: (s) => ({
        drops: Object.fromEntries(
          Object.values(s.drops)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, KEEP)
            .map((d) => [d.id, { ...d, uploadKeys: [], files: d.files.map(({ preview: _p, ...f }) => f) }]),
        ),
      }),
    },
  ),
);
