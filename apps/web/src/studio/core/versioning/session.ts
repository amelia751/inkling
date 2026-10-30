import { create } from "zustand";
import type { Annotation, AnnotationDocument } from "@studio/plugin-contracts/types";
import { api, fetchStatus, VersioningError, type VersionedDocument } from "./api";

/**
 * The Studio's versioned save flow (todo4 Phase 6, V12). Off by default: it turns on only
 * when the kernel is on and reports apps/versioning configured, so the plain save path (and
 * every e2e test that runs without the kernel) is unchanged.
 *
 * - Each user edits on their own working branch, `work/<actor>/<dataset>`, created from
 *   `main` on first open (`main` is protected; changes reach it through a review).
 * - "Save" is a commit with `expected_head`. If someone else saved first the kernel answers
 *   409 `stale_head`: the Studio says so, and "Refresh and re-apply" reloads the branch and
 *   replays this session's edits on top of it.
 * - "Submit for review" opens a review of the branch into `main`.
 */

export interface VersioningSession {
  enabled: boolean;
  datasetId: string | null;
  branch: string | null;
  workBranch: string | null;
  head: string | null;
  /** A protected branch (main): viewable, never saved to directly. */
  readOnly: boolean;
  /** The document as last loaded or saved: what this session's edits are relative to. */
  base: Annotation[];
  /** Set when a save hit `stale_head`. */
  stale: { currentHead?: string } | null;
  set: (p: Partial<VersioningSession>) => void;
}

export const useVersioning = create<VersioningSession>((set) => ({
  enabled: false,
  datasetId: null,
  branch: null,
  workBranch: null,
  head: null,
  readOnly: false,
  base: [],
  stale: null,
  set: (p) => set(p),
}));

const BRANCH_KEY = (datasetId: string) => `versioning.branch.${datasetId}`;

function rememberedBranch(datasetId: string): string | null {
  try {
    return localStorage.getItem(BRANCH_KEY(datasetId));
  } catch {
    return null;
  }
}

function rememberBranch(datasetId: string, branch: string): void {
  try {
    localStorage.setItem(BRANCH_KEY(datasetId), branch);
  } catch {
    /* private mode: the work branch is the default anyway */
  }
}

/** Whether versioned saves are on for this dataset (cached per page load). */
const statusCache = new Map<string, Promise<boolean>>();
export function versioningEnabled(datasetId: string): Promise<boolean> {
  if (!statusCache.has(datasetId)) statusCache.set(datasetId, fetchStatus(datasetId).then((s) => s.configured && s.ready));
  return statusCache.get(datasetId)!;
}

/**
 * Load the dataset's annotations for the Studio: the versioned branch document when
 * versioning is on (creating the dataset repository and the user's work branch on first
 * open), otherwise `fallback()` (the plain document).
 */
export async function loadDocument(datasetId: string, fallback: () => Promise<AnnotationDocument>): Promise<AnnotationDocument> {
  if (!(await versioningEnabled(datasetId))) {
    useVersioning.getState().set({ enabled: false, datasetId });
    return fallback();
  }
  await api.ensureDataset(datasetId, datasetId);
  const work = await api.ensureWorkBranch(datasetId, datasetId);
  const want = rememberedBranch(datasetId) ?? work.name;
  return openBranch(datasetId, want, work.name).catch(() => openBranch(datasetId, work.name, work.name));
}

async function openBranch(datasetId: string, branch: string, workBranch: string, readOnly = false): Promise<VersionedDocument> {
  const doc = await api.document(datasetId, datasetId, branch);
  useVersioning.getState().set({ enabled: true, datasetId, branch, workBranch, head: doc.head, base: doc.annotations, stale: null, readOnly });
  if (!readOnly) rememberBranch(datasetId, branch);
  return doc;
}

/** Switch the Studio to another branch's document (the caller reloads the store). */
export async function switchBranch(datasetId: string, branch: string, readOnly = false): Promise<VersionedDocument> {
  const work = useVersioning.getState().workBranch ?? branch;
  return openBranch(datasetId, branch, work, readOnly);
}

export class StaleHeadError extends Error {
  constructor(public readonly currentHead?: string) {
    super("Someone else saved this branch; refresh and re-apply your changes");
  }
}

/** Save = a commit with expected_head. Returns the new branch generation (the store's revision). */
export async function saveVersioned(datasetId: string, annotations: Annotation[]): Promise<number> {
  const v = useVersioning.getState();
  if (!v.branch || !v.head) throw new Error("no branch open");
  if (v.readOnly) throw new Error(`${v.branch} is protected: switch to your work branch to save`);
  try {
    const res = await api.commit(datasetId, datasetId, { branch: v.branch, expected_head: v.head, message: "Save annotations", document: { annotations } });
    useVersioning.getState().set({ head: res.commit_oid, base: annotations, stale: null });
    return res.head_generation;
  } catch (e) {
    if (e instanceof VersioningError && e.code === "stale_head") {
      useVersioning.getState().set({ stale: { currentHead: e.problem.current_head } });
      throw new StaleHeadError(e.problem.current_head);
    }
    throw e;
  }
}

/**
 * This session's edits (relative to `base`) replayed onto `fresh`: annotations it added or
 * changed win, ones it deleted stay deleted, everything else comes from `fresh`.
 */
export function reapply(base: Annotation[], mine: Annotation[], fresh: Annotation[]): Annotation[] {
  const before = new Map(base.map((a) => [a.id, JSON.stringify(a)]));
  const mineIds = new Set(mine.map((a) => a.id));
  const deleted = new Set(base.filter((a) => !mineIds.has(a.id)).map((a) => a.id));
  const changed = new Map(mine.filter((a) => before.get(a.id) !== JSON.stringify(a)).map((a) => [a.id, a]));
  const out = fresh.filter((a) => !deleted.has(a.id)).map((a) => changed.get(a.id) ?? a);
  const have = new Set(out.map((a) => a.id));
  for (const a of changed.values()) if (!have.has(a.id)) out.push(a);
  return out;
}

/** "Refresh and re-apply": the branch's current document with this session's edits on top. */
export async function refreshAndReapply(datasetId: string, mine: Annotation[]): Promise<{ annotations: Annotation[]; revision: number }> {
  const v = useVersioning.getState();
  if (!v.branch) throw new Error("no branch open");
  const base = v.base;
  const doc = await api.document(datasetId, datasetId, v.branch);
  useVersioning.getState().set({ head: doc.head, base: doc.annotations, stale: null });
  return { annotations: reapply(base, mine, doc.annotations), revision: doc.revision };
}

/** Open a review of the current branch into main. */
export async function submitForReview(datasetId: string, title: string, description?: string) {
  const v = useVersioning.getState();
  if (!v.branch) throw new Error("no branch open");
  return api.openReview(datasetId, datasetId, { title, source_branch: v.branch, target_branch: "main", description });
}
