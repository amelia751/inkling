import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import type { SourceNode } from "@studio/contracts/types";
import { FolderIcon, FolderOpenIcon, LockIcon, StarFillIcon } from "@studio/ui/icons";
import { FileTree, type FileTreeHandle, type FileTreeMoveArgs, type FileTreeNode } from "@studio/ui/ui/file-tree";
import { nodeIcon, statusReason } from "@/studio/lib/file-kinds";
import { useFsChildren, type FsSort } from "@/studio/lib/files/api";
import { statusIcon } from "./source-tree";

/**
 * The drive tree (todo7 D1, Phases 2, 3 and 5): the children of the project's one root
 * ("Files"), each folder's pages loaded with `useFsChildren` when it opens (the same cache as
 * the listing, so optimistic moves and renames show in both), sorted server-side. Compact
 * single-child chains and numbered runs as the kernel sends them. Rename, multi-select, row
 * actions, drag and drop into folders, the filter and recursive expand come from `FileTree`;
 * this component only maps nodes to rows and loads children.
 */
export interface RevealRequest {
  id: string;
  /** Ancestor ids, root first (from the node's detail). */
  path: string[];
  /** The run the node is collapsed into, when it is (`seq:<folder>:<key>`). */
  seq?: string;
  nonce: number;
}

export interface DriveTreeHandle {
  focus: () => void;
  /** The row that has keyboard focus, if any. */
  focused: () => SourceNode | undefined;
  lookup: (id: string) => SourceNode | undefined;
  edit: (id: string) => void;
  closeAll: () => void;
  openRecursive: (id: string, cap?: number) => boolean;
  open: (id: string) => void;
  /** The element of a row (for keyboard context menus). */
  rowOf: (id: string) => HTMLElement | null;
  contains: (el: Element | null) => boolean;
}

interface Props {
  projectId: string;
  rootId: string;
  sort: FsSort;
  selectedIds: readonly string[];
  reveal: RevealRequest | null;
  initialOpen?: string[];
  onSelect: (ids: string[]) => void;
  onActivate: (id: string) => void;
  onKey: (e: KeyboardEvent) => boolean;
  onContextMenu: (id: string, e: React.MouseEvent) => void;
  editable?: (n: SourceNode) => boolean;
  onRename?: (id: string, name: string) => void;
  onRenameCancel?: (id: string) => void;
  validate?: (name: string, n: SourceNode) => string | null;
  rowActions?: (n: SourceNode) => ReactNode;
  canDrag?: (n: SourceNode) => boolean;
  canDrop?: (args: { dragIds: string[]; parentId: string }) => true | string;
  onMove?: (args: FileTreeMoveArgs) => void;
  dropTargetId?: string | null;
  onDragChange?: (ids: string[] | null) => void;
  searchTerm?: string;
  onOpenCap?: (id: string) => void;
  cutIds?: readonly string[];
  draftIds?: ReadonlySet<string>;
  /** Rows were loaded (to resolve reveals and pending renames). */
  onLoaded?: () => void;
}

interface FolderState {
  items?: SourceNode[];
  hasMore: boolean;
  loading: boolean;
}

/** Loads one folder's pages and reports them (hooks can't run in a loop). */
function FolderLoader({ projectId, id, sort, report, more }: { projectId: string; id: string; sort: FsSort; report: (id: string, s: FolderState) => void; more: Map<string, () => void> }) {
  const q = useFsChildren(projectId, id, sort);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items), [q.data]);
  useEffect(() => {
    report(id, { items, hasMore: !!q.hasNextPage, loading: q.isLoading });
  }, [id, items, q.hasNextPage, q.isLoading, report]);
  useEffect(() => {
    more.set(id, () => void q.fetchNextPage());
    return () => void more.delete(id);
  }, [id, more, q]);
  return null;
}

export const DriveTree = forwardRef<DriveTreeHandle, Props>(function DriveTree(props, ref) {
  const { projectId, rootId, sort, selectedIds, reveal, initialOpen, onSelect, onActivate, onKey, onContextMenu, draftIds } = props;
  const [open, setOpen] = useState<string[]>(initialOpen ?? []);
  const [folders, setFolders] = useState<Record<string, FolderState>>({});
  const more = useRef(new Map<string, () => void>()).current;
  const tree = useRef<FileTreeHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const focusedId = useRef<string | null>(null);
  const known = useRef(new Map<string, SourceNode>());

  const report = useCallback((id: string, s: FolderState) => {
    for (const n of s.items ?? []) known.current.set(n.id, n);
    setFolders((f) => (f[id]?.items === s.items && f[id]?.hasMore === s.hasMore && f[id]?.loading === s.loading ? f : { ...f, [id]: s }));
  }, []);
  // A new project or root: forget what was open.
  useEffect(() => {
    setOpen(initialOpen ?? []);
    setFolders({});
    known.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per drive
  }, [projectId, rootId]);
  const initialKey = (initialOpen ?? []).join("|");
  useEffect(() => {
    if (initialOpen?.length) setOpen((o) => [...new Set([...o, ...initialOpen])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  const childrenOf = (id: string, depth = 0): FileTreeNode[] => {
    const f = folders[id];
    if (!f) return [];
    if (!f.items) return f.loading ? [{ id: `${id}:loading`, name: "Loading…", icon: FolderIcon, placeholder: "loading" }] : [];
    const out = f.items.map((n) => toTreeNode(n, id, depth));
    if (f.hasMore) out.push({ id: `${id}:more`, name: "Load more", icon: FolderIcon, placeholder: "more", onMore: () => more.get(id)?.() });
    return out;
  };

  const toTreeNode = (n: SourceNode, parentId: string, depth: number): FileTreeNode => {
    const reason = statusReason(n);
    const name = n.displayPath ?? n.name;
    return {
      id: n.id,
      name,
      title: reason ? `${name}\n${reason}` : name,
      icon: nodeIcon(n),
      openIcon: n.kind === "folder" ? FolderOpenIcon : undefined,
      count: n.kind === "folder" ? n.descendantCount.toLocaleString() : n.kind === "sequence" ? `${n.childCount.toLocaleString()} files` : undefined,
      status: statusIcon(n.status),
      badges:
        n.starred || (n.locked && n.kind === "folder" && depth === 0) ? (
          <>
            {n.starred && <StarFillIcon className="size-3 text-warning" aria-label="Starred" />}
            {n.locked && n.kind === "folder" && depth === 0 && <LockIcon className="size-3" aria-label="Sample data" />}
          </>
        ) : undefined,
      children: n.kind === "file" ? undefined : depth > 40 ? [] : childrenOf(n.id, depth + 1),
      drop: n.kind === "folder" ? { id: n.id, label: n.name } : dropOf(parentId),
      editName: n.name,
      draft: draftIds?.has(n.id),
    };
  };

  // A drop of OS files on a file row goes to its folder.
  const dropOf = (folderId: string) => {
    if (folderId === rootId) return { id: rootId, label: "Files" };
    const f = known.current.get(folderId);
    return f && f.kind === "folder" ? { id: f.id, label: f.name } : undefined;
  };

  const data = childrenOf(rootId);

  useImperativeHandle(ref, () => ({
    focus: () => tree.current?.focus(),
    focused: () => (focusedId.current ? known.current.get(focusedId.current) : undefined),
    lookup: (id) => known.current.get(id),
    edit: (id) => tree.current?.edit(id),
    closeAll: () => {
      tree.current?.closeAll();
      setOpen([]);
    },
    openRecursive: (id, cap) => tree.current?.openRecursive(id, cap) ?? false,
    open: (id) => tree.current?.api()?.open(id),
    rowOf: (id) => box.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`) ?? null,
    contains: (el) => !!el && !!box.current?.contains(el),
  }));

  // Reveal: open each ancestor as it appears (children load on open), then flash the row.
  const revealed = useRef(0);
  useEffect(() => {
    if (!reveal || revealed.current === reveal.nonce) return;
    const api = tree.current?.api();
    if (!api) return;
    for (const id of reveal.path) {
      const n = api.get(id);
      if (n && !n.isOpen) n.open();
    }
    if (api.get(reveal.id)) {
      revealed.current = reveal.nonce;
      tree.current?.reveal(reveal.id);
      return;
    }
    const run = reveal.seq ? api.get(reveal.seq) : null;
    if (run && !run.isOpen) run.open();
  });

  useEffect(() => props.onLoaded?.(), [folders, props]);

  const toggled = (id: string, isOpen: boolean) => setOpen((o) => (isOpen ? (o.includes(id) ? o : [...o, id]) : o.filter((x) => x !== id)));
  const node = (d: FileTreeNode) => known.current.get(d.id);

  return (
    <div ref={box} className="h-full min-h-0">
      {[rootId, ...open.filter((id) => id !== rootId)].map((id) => (
        <FolderLoader key={id} projectId={projectId} id={id} sort={sort} report={report} more={more} />
      ))}
      <FileTree
        ref={tree}
        data={data}
        selectedIds={selectedIds}
        initialOpen={initialOpen}
        aria-label="Files"
        onToggle={toggled}
        onSelect={onSelect}
        onActivate={onActivate}
        onFocusNode={(id) => (focusedId.current = id)}
        onKey={(e) => onKey(e.nativeEvent)}
        onContextMenu={(id, e) => onContextMenu(id, e)}
        editable={props.editable ? (d) => !!node(d) && props.editable!(node(d)!) : undefined}
        onRename={props.onRename}
        onRenameCancel={props.onRenameCancel}
        validate={props.validate ? (name, d) => (node(d) ? props.validate!(name, node(d)!) : null) : undefined}
        rowActions={props.rowActions ? (d) => (node(d) ? props.rowActions!(node(d)!) : null) : undefined}
        canDrag={props.canDrag ? (d) => !!node(d) && props.canDrag!(node(d)!) : undefined}
        canDrop={props.canDrop}
        onMove={props.onMove}
        dropTargetId={props.dropTargetId}
        onDragChange={props.onDragChange}
        searchTerm={props.searchTerm}
        onOpenCap={props.onOpenCap}
        cutIds={props.cutIds}
      />
    </div>
  );
});
