import type { InfiniteData } from "@tanstack/react-query";
import type { ChildrenPage, FsOp, SourceNode } from "@studio/contracts/types";

/**
 * Optimistic patches of the cached children pages (kiwifs `lib/treeReorder.ts`
 * `applyOptimisticTreeMove`, but on React Query pages instead of one whole-tree state). Pure:
 * the hooks in `api.ts` snapshot the cache, apply these, and put the snapshot back on error.
 */

export type ChildrenData = InfiniteData<ChildrenPage, string | null>;

export type FsSortKey = "name" | "kind" | "size" | "added";
export interface FsSort {
  by: FsSortKey;
  dir: "asc" | "desc";
}
export const DEFAULT_SORT: FsSort = { by: "name", dir: "asc" };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The server's order: folders (and runs) first always, then the sort key, then the name. */
export function compareNodes(a: SourceNode, b: SourceNode, sort: FsSort = DEFAULT_SORT): number {
  const fa = a.kind === "file" ? 1 : 0;
  const fb = b.kind === "file" ? 1 : 0;
  if (fa !== fb) return fa - fb;
  const sign = sort.dir === "desc" ? -1 : 1;
  let c = 0;
  if (sort.by === "kind") c = collator.compare(a.detectedKind ?? "", b.detectedKind ?? "");
  else if (sort.by === "size") c = (sizeOf(a) ?? -1) - (sizeOf(b) ?? -1);
  else if (sort.by === "added") c = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  if (c !== 0) return sign * c;
  return sign * collator.compare(a.name, b.name);
}

const sizeOf = (n: SourceNode) => (n.kind === "file" ? n.size : (n.totalBytes ?? n.size));

/** Every node in the cached pages of a folder. */
export const rowsOf = (data: ChildrenData | undefined): SourceNode[] => data?.pages.flatMap((p) => p.items) ?? [];

/**
 * Insert `node` at its sorted place in the loaded pages. When it would sort after the last
 * loaded row and more pages exist, it's left out (it shows up when that page loads).
 */
export function insertSorted(data: ChildrenData, node: SourceNode, sort: FsSort = DEFAULT_SORT): ChildrenData {
  const pages = data.pages.map((p) => ({ ...p, items: [...p.items] }));
  for (const p of pages) {
    const at = p.items.findIndex((x) => compareNodes(node, x, sort) < 0);
    if (at !== -1) {
      p.items.splice(at, 0, node);
      return { ...data, pages: bumpTotal(pages, 1) };
    }
  }
  const lastPage = pages[pages.length - 1];
  if (!lastPage) return { ...data, pages: [{ items: [node], total: 1, nextCursor: null }], pageParams: data.pageParams.length ? data.pageParams : [null] };
  if (lastPage.nextCursor) return { ...data, pages: bumpTotal(pages, 1) };
  lastPage.items.push(node);
  return { ...data, pages: bumpTotal(pages, 1) };
}

function bumpTotal(pages: ChildrenPage[], by: number): ChildrenPage[] {
  return pages.map((p) => ({ ...p, total: Math.max(0, p.total + by) }));
}

function removeIds(data: ChildrenData, ids: ReadonlySet<string>): ChildrenData {
  let removed = 0;
  const pages = data.pages.map((p) => {
    const items = p.items.filter((x) => !ids.has(x.id));
    removed += p.items.length - items.length;
    return { ...p, items };
  });
  return removed ? { ...data, pages: bumpTotal(pages, -removed) } : data;
}

/** A row for a folder made optimistically (`mkdir` with a client id). */
export function draftFolder(op: Extract<FsOp, { kind: "mkdir" }>, like?: SourceNode): SourceNode {
  return {
    id: op.id ?? `tmp-${op.parentId}-${op.name}`,
    sourceId: like?.sourceId ?? "",
    parentId: op.parentId,
    name: op.name,
    kind: "folder",
    detectedKind: null,
    size: null,
    sha256: null,
    childCount: 0,
    descendantCount: 0,
    facts: {},
    flags: {},
    status: "ready",
    importSessionId: null,
    createdAt: new Date().toISOString(),
    totalBytes: 0,
  };
}

/** Optimistic copies carry this id prefix until the server's answer replaces them. */
export const COPY_PREFIX = "tmp-copy:";

/**
 * Patch one folder's cached pages for a batch of ops. `lookup` finds a node anywhere in the
 * cache (a move into this folder needs the row from its old folder).
 */
export function patchFolder(folderId: string, data: ChildrenData, ops: FsOp[], lookup: (id: string) => SourceNode | undefined, sort: FsSort = DEFAULT_SORT): ChildrenData {
  let out = data;
  for (const op of ops) {
    switch (op.kind) {
      case "mkdir":
        if (op.parentId === folderId) out = insertSorted(out, draftFolder(op, rowsOf(out)[0]), sort);
        break;
      case "rename": {
        const row = rowsOf(out).find((x) => x.id === op.nodeId);
        if (row) out = insertSorted(removeIds(out, new Set([op.nodeId])), { ...row, name: op.name, displayPath: undefined }, sort);
        break;
      }
      case "move": {
        const ids = new Set(op.nodeIds);
        if (op.parentId === folderId) {
          const here = new Set(rowsOf(out).map((x) => x.id));
          for (const id of op.nodeIds) {
            const row = lookup(id);
            if (row && !here.has(id)) out = insertSorted(out, { ...row, parentId: folderId }, sort);
          }
        } else {
          out = removeIds(out, ids);
        }
        break;
      }
      case "copy":
        if (op.parentId === folderId) {
          for (const id of op.nodeIds) {
            const row = lookup(id);
            if (row) out = insertSorted(out, { ...row, id: `${COPY_PREFIX}${id}`, parentId: folderId, starred: false, locked: false }, sort);
          }
        }
        break;
      case "trash":
      case "purge":
      case "restore":
        // Trash and purge hide rows; restore takes rows out of a Trash listing.
        out = removeIds(out, new Set(op.nodeIds));
        break;
    }
  }
  return out;
}

/** The folders a batch changes, given where its nodes are now (`parentOf`). */
export function foldersTouched(ops: FsOp[], parentOf: (id: string) => string | null | undefined): string[] {
  const out = new Set<string>();
  const add = (id: string | null | undefined) => id && out.add(id);
  for (const op of ops) {
    if (op.kind === "mkdir") add(op.parentId);
    else if (op.kind === "rename") add(parentOf(op.nodeId));
    else if (op.kind === "move") {
      add(op.parentId);
      op.nodeIds.forEach((id) => add(parentOf(id)));
    } else if (op.kind === "copy") add(op.parentId);
    else op.nodeIds.forEach((id) => add(parentOf(id)));
  }
  return [...out];
}

/** Set `starred` on a row wherever it's cached (star / unstar). */
export function patchStar(data: ChildrenData, nodeId: string, starred: boolean): ChildrenData {
  if (!rowsOf(data).some((x) => x.id === nodeId)) return data;
  return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((x) => (x.id === nodeId ? { ...x, starred } : x)) })) };
}
