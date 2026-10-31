/**
 * The refresh guard (kiwifs `lib/treeRefresh.ts` `shouldApplyTreeLoad`, keyed per folder):
 * a children load that *started* before this tab's last local operation on that folder would
 * roll back the optimistic view, so its result is ignored. Per tab, in memory only (it guards
 * a view, not data).
 */

export interface LoadDecision {
  /** When the request was sent. */
  requestStartedAt: number;
  /** When this tab last changed that folder (0: never). */
  lastLocalMutationAt: number;
}

/** True when applying the response cannot roll back a local change. */
export function shouldApplyLoad({ requestStartedAt, lastLocalMutationAt }: LoadDecision): boolean {
  if (lastLocalMutationAt <= 0) return true;
  return requestStartedAt >= lastLocalMutationAt;
}

/** A monotonic clock (tests replace it with `setGuardClock`). */
let clock: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
export const guardNow = () => clock();
export function setGuardClock(c: (() => number) | null): void {
  clock = c ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
}

const key = (projectId: string, folderId: string) => `${projectId}\u0000${folderId}`;
const last = new Map<string, number>();
const pending = new Map<string, number>();

/**
 * Record a local operation touching these folders (optimistic patch applied). Returns the
 * function to call when the server answered (success or failure).
 */
export function beginLocalOp(projectId: string, folderIds: Iterable<string>): () => void {
  const ids = [...new Set(folderIds)];
  const at = guardNow();
  for (const id of ids) {
    const k = key(projectId, id);
    last.set(k, at);
    pending.set(k, (pending.get(k) ?? 0) + 1);
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const end = guardNow();
    for (const id of ids) {
      const k = key(projectId, id);
      const n = (pending.get(k) ?? 1) - 1;
      if (n <= 0) pending.delete(k);
      else pending.set(k, n);
      // Loads that started while the server was still working are as stale as earlier ones.
      last.set(k, Math.max(last.get(k) ?? 0, end));
    }
  };
}

export const lastLocalOp = (projectId: string, folderId: string): number => last.get(key(projectId, folderId)) ?? 0;
export const hasPendingOp = (projectId: string, folderId: string): boolean => (pending.get(key(projectId, folderId)) ?? 0) > 0;

/** A load of `folderId` that started at `startedAt` may replace what's shown. */
export function loadIsCurrent(projectId: string, folderId: string, startedAt: number): boolean {
  return !hasPendingOp(projectId, folderId) && shouldApplyLoad({ requestStartedAt: startedAt, lastLocalMutationAt: lastLocalOp(projectId, folderId) });
}

/** Tests only. */
export function resetGuard(): void {
  last.clear();
  pending.clear();
}
