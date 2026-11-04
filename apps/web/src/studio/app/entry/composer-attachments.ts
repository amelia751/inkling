import { create } from "zustand";
import type { PendingDrop } from "./pending-ask";

/**
 * todo29 D1: files attached to an empty project's Overview composer (dropped on it, picked, pasted,
 * or dropped anywhere on the empty page) wait here until Send. The upload starts at once; nothing
 * is queued for the assistant until the person sends. Memory only: a reload drops the
 * attachment (the files are already in Sources).
 */
export interface ComposerAttachment {
  /** Chat drops on: the drop started in the project's conversation, and the message that will carry it. */
  drop?: PendingDrop;
  /** Chat drops off: the tray upload the message will wait for (todo24 D2). */
  uploadKey?: string;
}

interface ComposerAttachments {
  byProject: Record<string, ComposerAttachment>;
  attach: (projectId: string, a: ComposerAttachment) => void;
  /** Take (and clear) what's attached, on Send. */
  take: (projectId: string) => ComposerAttachment | undefined;
  clear: (projectId: string) => void;
}

export const useComposerAttachments = create<ComposerAttachments>((set, get) => ({
  byProject: {},
  attach: (projectId, a) => set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...s.byProject[projectId], ...a } } })),
  take: (projectId) => {
    const a = get().byProject[projectId];
    get().clear(projectId);
    return a;
  },
  clear: (projectId) =>
    set((s) => {
      const { [projectId]: _gone, ...rest } = s.byProject;
      return { byProject: rest };
    }),
}));
