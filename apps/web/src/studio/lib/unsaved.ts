import { RES } from "@studio/contracts/naming";
import type { Annotation } from "@studio/contracts/types";
import { useStudio } from "@/studio/stores/studio";

/**
 * Unsaved annotations across a sign-in redirect (todo9 Phase 4). When the session expires
 * mid-work the autosave can't reach the API any more, so the Studio's edits go to this tab's
 * sessionStorage just before the browser leaves for the sign-in page, and the Studio puts them
 * back (still unsaved, so the autosave writes them) when it opens the same task again.
 */

interface Stash {
  revision: number;
  annotations: Annotation[];
}

const key = (projectId: string) => `${RES}:unsaved:${projectId}`;

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Keep the open Studio's unsaved annotations, if any. True when something was kept. */
export function stashUnsaved(): boolean {
  const { projectId, dirty, revision, annotations } = useStudio.getState();
  if (!projectId || !dirty) return false;
  try {
    storage()?.setItem(key(projectId), JSON.stringify({ revision, annotations } satisfies Stash));
    return true;
  } catch (e) {
    console.warn("[unsaved] couldn't keep unsaved annotations", e);
    return false;
  }
}

/** The kept annotations for this task (removed from storage), or null. */
export function takeUnsaved(projectId: string): Stash | null {
  const s = storage();
  const raw = s?.getItem(key(projectId));
  if (!s || raw == null) return null;
  s.removeItem(key(projectId));
  try {
    const v = JSON.parse(raw) as Partial<Stash>;
    return typeof v.revision === "number" && Array.isArray(v.annotations) ? { revision: v.revision, annotations: v.annotations } : null;
  } catch {
    return null;
  }
}
