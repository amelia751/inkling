import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import type { SourceNode, SourceSummary } from "@studio/contracts/types";
import { FolderIcon, FolderOpenIcon, PrivacyIcon, UnknownFileIcon, WarningIcon } from "@studio/ui/icons";
import { FileTree, type FileTreeHandle, type FileTreeNode } from "@studio/ui/ui/file-tree";
import { Spinner } from "@studio/ui/ui/spinner";
import { fetchChildren, projectKeys } from "@/studio/lib/projects-api";
import { nodeIcon, statusReason } from "@/studio/lib/file-kinds";

/**
 * The Sources tree (todo6 Phase 4.2): the project's sources as roots, children loaded a page
 * (500) at a time when a folder opens, compact single-child chains and numbered runs as the
 * kernel sends them. Read-only: no rename, move, delete or drag (design implication 2).
 */
export type TreeTarget = { id: string; node?: SourceNode; source?: SourceSummary };

export interface SourceTreeHandle {
  focus: () => void;
  /** The row that has keyboard focus, if any. */
  focused: () => TreeTarget | undefined;
  lookup: (id: string) => TreeTarget | undefined;
}

export interface RevealRequest {
  id: string;
  /** Ancestor ids, root first (from the node's detail). */
  path: string[];
  /** The run the node is collapsed into, when it is (`seq:<folder>:<key>`). */
  seq?: string;
  nonce: number;
}

interface Props {
  sources: SourceSummary[];
  selectedId: string | null;
  reveal: RevealRequest | null;
  onSelect: (t: TreeTarget) => void;
  onKey: (e: KeyboardEvent) => boolean;
  onContextMenu: (t: TreeTarget, e: React.MouseEvent) => void;
}

export const SourceTree = forwardRef<SourceTreeHandle, Props>(function SourceTree({ sources, selectedId, reveal, onSelect, onKey, onContextMenu }, ref) {
  const roots = useMemo(() => sources.filter((s) => s.rootNodeId), [sources]);
  const initialOpen = useMemo(() => (roots.length === 1 ? [roots[0].rootNodeId!] : []), [roots]);
  const [open, setOpen] = useState<string[]>(initialOpen);
  // Cursors of the pages loaded per folder: [null] is the first page; "Load more" appends.
  const [cursors, setCursors] = useState<Record<string, (string | null)[]>>({});
  const tree = useRef<FileTreeHandle>(null);
  const focusedId = useRef<string | null>(null);

  const sourceByRoot = useMemo(() => new Map(roots.map((s) => [s.rootNodeId!, s])), [roots]);
  const known = useRef(new Map<string, SourceNode>());
  const sourceOf = (id: string) => sourceByRoot.get(id)?.id ?? known.current.get(id)?.sourceId;

  const wanted = open.flatMap((id) => {
    const sourceId = sourceOf(id);
    return sourceId ? (cursors[id] ?? [null]).map((cursor) => ({ id, sourceId, cursor })) : [];
  });
  const results = useQueries({
    queries: wanted.map((w) => ({
      queryKey: [...projectKeys.children(w.sourceId, w.id), w.cursor ?? ""],
      queryFn: () => fetchChildren(w.sourceId, w.id, w.cursor),
      staleTime: 10_000,
    })),
  });
  const pages = new Map<string, { items?: SourceNode[]; next?: string | null; loading: boolean }[]>();
  wanted.forEach((w, i) => {
    const r = results[i];
    const list = pages.get(w.id) ?? [];
    list.push({ items: r.data?.items, next: r.data?.nextCursor, loading: r.isLoading });
    pages.set(w.id, list);
    for (const n of r.data?.items ?? []) known.current.set(n.id, n);
  });

  const more = useCallback((id: string, next: string) => setCursors((c) => ({ ...c, [id]: [...(c[id] ?? [null]), next] })), []);

  const childrenOf = (id: string): FileTreeNode[] => {
    const list = pages.get(id);
    if (!list) return [];
    const out: FileTreeNode[] = [];
    for (const p of list) {
      if (!p.items) {
        if (p.loading) out.push({ id: `${id}:loading:${out.length}`, name: "Loading…", icon: FolderIcon, placeholder: "loading" });
        continue;
      }
      out.push(...p.items.map((n) => toTreeNode(n, id)));
    }
    const last = list.at(-1);
    if (last?.next) out.push({ id: `${id}:more:${last.next}`, name: "Load more", icon: FolderIcon, placeholder: "more", onMore: () => more(id, last.next!) });
    return out;
  };

  const toTreeNode = (n: SourceNode, parentId: string): FileTreeNode => {
    const reason = statusReason(n);
    const name = n.displayPath ?? n.name;
    const dropTo = n.kind === "folder" ? { id: n.id, label: n.name } : undefined;
    return {
      id: n.id,
      name,
      title: reason ? `${name}\n${reason}` : name,
      icon: nodeIcon(n),
      openIcon: n.kind === "folder" ? FolderOpenIcon : undefined,
      count: n.kind === "folder" ? n.descendantCount.toLocaleString() : n.kind === "sequence" ? `${n.childCount.toLocaleString()} files` : undefined,
      status: statusIcon(n.status),
      children: n.kind === "file" ? undefined : childrenOf(n.id),
      drop: dropTo ?? (n.kind === "file" || n.kind === "sequence" ? dropOf(parentId) : undefined),
    };
  };

  // A drop on a file row goes to its folder; a run's folder is its parent.
  const dropOf = (folderId: string) => {
    const root = sourceByRoot.get(folderId);
    if (root) return { id: folderId, label: root.title };
    const f = known.current.get(folderId);
    return f && f.kind === "folder" ? { id: f.id, label: f.name } : undefined;
  };

  const data: FileTreeNode[] = roots.map((s) => ({
    id: s.rootNodeId!,
    name: s.title,
    title: s.title,
    icon: FolderIcon,
    openIcon: FolderOpenIcon,
    count: s.fileCount.toLocaleString(),
    status: s.status === "uploading" || s.status === "inspecting" ? <Spinner className="size-3.5" /> : undefined,
    children: childrenOf(s.rootNodeId!),
    drop: { id: s.rootNodeId!, label: s.title },
  }));

  const lookup = (id: string): TreeTarget | undefined => {
    const source = sourceByRoot.get(id);
    if (source) return { id, source };
    const node = known.current.get(id);
    return node ? { id, node } : undefined;
  };

  useImperativeHandle(ref, () => ({
    focus: () => tree.current?.focus(),
    focused: () => (focusedId.current ? lookup(focusedId.current) : undefined),
    lookup,
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

  return (
    <FileTree
      ref={tree}
      data={data}
      selectedId={selectedId}
      initialOpen={initialOpen}
      aria-label="Data"
      onToggle={(id, isOpen) => setOpen((o) => (isOpen ? (o.includes(id) ? o : [...o, id]) : o.filter((x) => x !== id)))}
      onSelect={(ids) => {
        const t = ids.length === 1 ? lookup(ids[0]) : undefined;
        if (t) onSelect(t);
      }}
      onActivate={(id) => {
        const t = lookup(id);
        if (t) onSelect(t);
      }}
      onFocusNode={(id) => (focusedId.current = id)}
      onKey={(e) => onKey(e.nativeEvent)}
      onContextMenu={(id, e) => {
        const t = lookup(id);
        if (!t) return;
        e.preventDefault();
        onContextMenu(t, e);
      }}
    />
  );
});

/** One status icon per row: checking, privacy, attention or unreadable (never colour alone: the tooltip says why). */
export function statusIcon(status: SourceNode["status"]): ReactNode {
  switch (status) {
    case "checking":
      return <Spinner className="size-3.5" aria-label="Checking" />;
    case "privacy":
      return <PrivacyIcon className="size-3.5 text-warning" aria-label="Held for privacy review" />;
    case "attention":
      return <WarningIcon className="size-3.5 text-warning" aria-label="Needs attention" />;
    case "unsupported":
      return <UnknownFileIcon className="size-3.5 text-hint" aria-label="Can't read this file yet" />;
    default:
      return undefined;
  }
}
