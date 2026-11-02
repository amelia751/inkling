/**
 * todo18 D3: what this person may do in a project, from their project role, in one place. Every
 * write or destructive control asks `useCan(projectId, action)` and hides or disables itself with
 * `reason`. The api stays the authority; this only keeps people from clicking into a 403.
 */
import { useProjectSummary } from "@/studio/lib/projects-api";

export type CanAction =
  | "view"
  | "upload" // drop, import, add files
  | "edit" // rename, move, create folders, change datasets and Studios
  | "annotate"
  | "trash" // move to Trash, restore
  | "destroy" // delete forever, empty Trash
  | "delete-project"
  | "manage"; // settings, members

type Role = "owner" | "admin" | "editor" | "contributor" | "viewer";

const RANK: Record<Role, number> = { viewer: 0, contributor: 1, editor: 2, admin: 3, owner: 3 };

const NEEDS: Record<CanAction, Role> = {
  view: "viewer",
  upload: "contributor",
  annotate: "contributor",
  edit: "editor",
  trash: "editor",
  destroy: "owner",
  "delete-project": "owner",
  manage: "admin",
};

const VERB: Record<CanAction, string> = {
  view: "view",
  upload: "add files to",
  annotate: "annotate in",
  edit: "change",
  trash: "delete from",
  destroy: "delete forever from",
  "delete-project": "delete",
  manage: "manage",
};

export interface Can {
  ok: boolean;
  /** Why not, in the person's words ("You can view this project but not delete from it"). */
  reason?: string;
  /** True until the role is known; controls should stay disabled, not hidden, meanwhile. */
  loading: boolean;
}

/** Pure check, for tests and non-hook code. A missing role (seed / local projects) allows everything. */
export function can(role: string | null | undefined, action: CanAction): Omit<Can, "loading"> {
  if (!role) return { ok: true };
  const r = (role in RANK ? role : "viewer") as Role;
  if (RANK[r] >= RANK[NEEDS[action]]) return { ok: true };
  const what = r === "viewer" ? "view this project" : `work in this project as ${r === "contributor" ? "a contributor" : `an ${r}`}`;
  return { ok: false, reason: `You can ${what} but not ${VERB[action]} it.` };
}

export function useCan(projectId: string | undefined, action: CanAction): Can {
  const q = useProjectSummary(projectId);
  if (!projectId) return { ok: true, loading: false };
  if (q.isLoading) return { ok: false, loading: true };
  return { ...can(q.data?.role, action), loading: false };
}
