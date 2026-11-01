import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EmptyState, NoResults } from "@studio/ui/ui/empty-state";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { DetectedKind, FsOp, SourceNode, SourceSummary, TrashItem } from "@studio/contracts/types";
import { ns, RES } from "@studio/contracts/naming";
import { ChevronDownIcon, CloseIcon, GridViewIcon, ListViewIcon, MoreIcon, NewFolderIcon, PasteIcon, PlusIcon, SearchIcon, UploadIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@studio/ui/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Input } from "@studio/ui/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@studio/ui/ui/resizable";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { useCommands } from "@/extension-host/commands";
import { AppLayout } from "@/studio/components/layout/app-layout";
import { sourceNodeContext, useAgentContext } from "@/studio/lib/agent/providers";
import { useAddData, usePickers } from "@/studio/components/uploads/uploads";
import { FilesEmptyState } from "@/studio/app/entry/empty-states";
import { ImportsList, ImportSummary } from "@/studio/components/sources/imports";
import { Inspector } from "@/studio/components/sources/inspector";
import { Listing, sortItems, type ListingHandle, type Sort, type SortKey } from "@/studio/components/sources/listing";
import { QuickLook } from "@/studio/components/sources/quick-look";
import { isSeq, seqFolder, useImports, useNode, useSearch, useSources } from "@/studio/components/sources/queries";
import { DriveTree, type DriveTreeHandle, type RevealRequest } from "@/studio/components/sources/drive-tree";
import {
  contextMenuPrimitives,
  editHistoryEntries,
  FilesMenuItems,
  menuItems,
  MoveDialog,
  NEEDS_FULL_STACK,
  PathBar,
  ReasonButton,
  SAMPLE_LOCKED,
  SelectionBar,
  TrashView,
  TreeFooter,
  TreeHeader,
  type FilesMenuAction,
  type FilesRowType,
  type MenuEntry,
  type MoveDestination,
  type PathSegment,
  type TreeSortKey,
} from "@/studio/components/files";
import { fetchNode, projectKeys, useProjectSummary } from "@/studio/lib/projects-api";
import { KINDS, nodeIcon, nodeKind } from "@/studio/lib/file-kinds";
import { exploreUrl, filesUrl, pipelinesUrl, studioUrl, trashUrl } from "@/studio/lib/routes";
import { useViewport } from "@/studio/lib/use-media-query";
import { fromDataTransfer, hasFiles } from "@/studio/lib/uploads/walk";
import { defaultView, useSourcesPrefs } from "@/studio/stores/sources";
import { useReorgPlans } from "@/studio/stores/reorg-plans";
import {
  applyOptimistic,
  downloadNode,
  downloadVersion,
  downloadZip,
  fetchFsChildren,
  findCachedNode,
  rollback,
  useDrive,
  useEmptyTrash,
  useEmptyTrashPreview,
  useFsChildren,
  useFsHistory,
  useRecent,
  useReplaceFile,
  useRestoreVersion,
  useStar,
  useStarred,
  useTrash,
  filesKeys,
  type ChildrenData,
  type FsSort,
  type OptimisticContext,
} from "@/studio/lib/files/api";
import { rowsOf } from "@/studio/lib/files/optimistic";
import { copyName, extensionChanged, nameWarning, nextUntitled, splitExtension, validateName } from "@/studio/lib/files/names";
import { clipboardFor, useCutIds, useFilesClipboard, usePasteCount } from "@/studio/lib/files/clipboard";
import { beginFsDrag, endFsDrag, fsDropTargetProps, startFsDrag, useFsDrag, useFsDropZone, type FsDragItem } from "@/studio/lib/files/dnd";
import { FsDragGhost } from "@/studio/lib/files/drag-ghost";
import { noticesFor, useFilesLive } from "@/studio/lib/files/live";
import { dismissNotice, notify, progressNotice } from "@/studio/lib/files/announce";
import { redoHint, undoHint, useTabUndoLabels } from "@/studio/lib/files/undo";
import { errorText, expandRuns, useFileOps } from "./files/ops";
import { PlanPanel } from "./files/plan-panel";

/**
 * Files (todo7; todo6 Phase 4 before it, docs/ux.md §6): the project's drive. One root
 * ("Files", D1) whose folders are yours: make, rename, move, copy, trash and undo, with the
 * bytes of every upload immutable. Three panes: the tree, the listing of the folder shown and
 * the inspector of the selection. Drive's moves (selection bar, drag anywhere, New ▾), Finder's
 * keys (core commands with `when: section == sources`), every change optimistic and journaled.
 *
 * URL: `/projects/:p/sources/:nodeId?` names a folder (listed), a file (its folder listed, the
 * file selected) or a numbered run (`seq:…`); node ids only, never names (paths may hold
 * identifiers). `/sources/trash` is the Trash. `?import=` shows an import's summary, `?status=`
 * filters by status, `?plan=` opens an assistant's reorganization plan (its ops stay in the tab).
 * The search text stays out of the URL for the same reason. `data-testid`s keep their todo6
 * `sources-*` names (a regression contract).
 */
const SCOPE = ns("core");
const SORT_KEY = `${RES}-files-sort`;
const RECENT_KEY = `${RES}-files-move-recent`;
const EXPAND_CAP = 2000;
const STATUS_CHIPS = [
  { value: "attention", label: "Needs attention" },
  { value: "unsupported", label: "Can't read" },
] as const;
const ROOT_FIXED = "The project's top folder stays where it is";

type Area = "tree" | "list" | "page" | "inspector";
type MenuTarget = { node: SourceNode; from: "tree" | "list" | "path" } | { node: null; folderId: string; from: "tree" | "list" } | { trash: TrashItem };

function readSort(): Sort {
  try {
    const v = JSON.parse(localStorage.getItem(SORT_KEY) ?? "null") as Sort | null;
    if (v && ["name", "kind", "size", "status", "added"].includes(v.key) && (v.dir === 1 || v.dir === -1)) return v;
  } catch {
    // Storage blocked: the default.
  }
  return { key: "name", dir: 1 };
}

function readRecent(projectId: string): MoveDestination[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Record<string, MoveDestination[]>;
    return Array.isArray(all[projectId]) ? all[projectId] : [];
  } catch {
    return [];
  }
}

function writeRecent(projectId: string, dest: MoveDestination) {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Record<string, MoveDestination[]>;
    all[projectId] = [dest, ...(all[projectId] ?? []).filter((d) => d.id !== dest.id)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch {
    // Not remembered.
  }
}

const toFsSort = (s: Sort): FsSort => ({ by: s.key === "status" ? "name" : s.key, dir: s.dir === 1 ? "asc" : "desc" });
const newNodeId = () => `nod-${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^0-9a-f]/gi, "").slice(0, 32)}`;
const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

export function FilesPage({ trash = false }: { trash?: boolean }) {
  const { projectId = "", nodeId: pathNode } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const importId = params.get("import");
  const planId = params.get("plan");
  const status = params.get("status") ?? undefined;
  const desktop = useViewport() === "desktop";
  const project = useProjectSummary(projectId).data;
  const prefs = useSourcesPrefs();
  const addData = useAddData(projectId);

  // ---- The drive -----------------------------------------------------------------------------
  const drive = useDrive(projectId);
  const rootId = drive.data?.rootNodeId ?? null;
  const writable = drive.data?.writable ?? false;
  const [sort, setSortState] = useState<Sort>(readSort);
  const setSort = (s: Sort) => {
    setSortState(s);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(s));
    } catch {
      // Not remembered.
    }
  };
  const fsSort = toFsSort(sort);
  const rootQ = useFsChildren(projectId, rootId, fsSort, { enabled: !!rootId });
  const rootItems = useMemo(() => rowsOf(rootQ.data), [rootQ.data]);
  // One top folder (a project with one source): its folder is the page, without a URL change.
  const onlyChild = rootItems.length === 1 && rootItems[0].kind === "folder" && !rootQ.hasNextPage ? rootItems[0].id : null;
  const sources = useSources(projectId);
  const sourceList = useMemo(() => sources.data ?? [], [sources.data]);
  const imports = useImports(projectId);
  const ops = useFileOps(projectId, writable);
  const live = useFilesLive(projectId);
  const clipboard = useFilesClipboard();
  useEffect(() => clipboard.setProject(projectId), [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const cutIds = useCutIds(projectId);
  const pasteCount = usePasteCount(projectId);
  const history = useFsHistory(projectId).data;
  const tabLabels = useTabUndoLabels(projectId);
  const undoLabel = history?.undo?.label ?? tabLabels.undo?.label ?? null;
  const redoLabel = history?.redo?.label ?? tabLabels.redo?.label ?? null;

  const nodeId = trash ? undefined : (pathNode ?? onlyChild ?? undefined);
  // The drive's one folder starts open (initialOpen); one that arrives later (the first upload
  // into an empty project) opens too, so the tree matches what a reload would show.
  useEffect(() => {
    if (!onlyChild) return;
    // The tree takes the new row on one of its next renders: retry for a moment.
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      const row = tree.current?.rowOf(onlyChild)?.closest("[role=treeitem]");
      if (row?.getAttribute("aria-expanded") === "true") return;
      if (row) tree.current?.open(onlyChild);
      if (++tries < 40) timer = window.setTimeout(attempt, 50);
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [onlyChild]);

  // ---- Where we are -----------------------------------------------------------------------
  const atRoot = !nodeId || nodeId === rootId;
  const anchorId = nodeId && !atRoot ? (isSeq(nodeId) ? seqFolder(nodeId) : nodeId) : null;
  const anchor = useNode(anchorId);
  const a = anchor.data && anchor.data.id === anchorId ? anchor.data : undefined;
  const fileLoc = !!a && !isSeq(nodeId) && a.kind === "file";
  const baseFolder = atRoot ? rootId : isSeq(nodeId) ? nodeId! : a ? (a.kind === "folder" ? a.id : (a.parentId ?? rootId)) : null;
  const folderQ = useFsChildren(projectId, baseFolder, fsSort, { enabled: !!baseFolder && !trash });
  const folderItems = useMemo(() => rowsOf(folderQ.data), [folderQ.data]);
  // A file collapsed into a numbered run: list the run, so the file is among the rows.
  const runId = fileLoc ? (a.runId ?? null) : null;
  const inRun = !!runId && folderItems.some((n) => n.id === runId);
  const runQ = useFsChildren(projectId, inRun ? runId : null, fsSort, { enabled: inRun });
  const listQ = inRun ? runQ : folderQ;
  const listingId = inRun ? runId : baseFolder;
  const runRow = inRun ? folderItems.find((n) => n.id === runId) : undefined;
  // The real folder shown (a run's folder for a run): where new folders, pastes and drops go.
  const listedFolderId = isSeq(listingId) ? seqFolder(listingId!) : listingId;
  const stripRoot = useCallback((path: { id: string; name: string }[]) => path.filter((p) => p.id !== rootId), [rootId]);

  // ---- Search -------------------------------------------------------------------------------
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<DetectedKind | undefined>();
  useEffect(() => {
    const t = window.setTimeout(() => setQ(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);
  const searching = !trash && (!!q || !!kind || !!status);
  const search = useSearch(projectId, q, kind, status);
  const setParam = (key: string, v: string | undefined | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set(key, v);
        else n.delete(key);
        return n;
      },
      { replace: true },
    );

  // ---- The rows shown -------------------------------------------------------------------------
  const rawItems: SourceNode[] = useMemo(() => (searching ? (search.data ?? []) : rowsOf(listQ.data)), [searching, search.data, listQ.data]);
  // Server order (folders first, the sort key, then the name), except what only the client sorts.
  const items = useMemo(() => (searching || sort.key === "status" ? sortItems(rawItems, sort) : rawItems), [rawItems, sort, searching]);
  const listLoading = searching ? search.isLoading : drive.isLoading || anchor.isLoading || listQ.isLoading;
  const folderKind = useMemo(() => dominantKind(items), [items]);
  const view = searching ? "list" : (prefs.views[folderKind] ?? defaultView(folderKind));

  // ---- Selection (shared by tree and listing) ---------------------------------------------
  const [selection, setSelection] = useState<string[]>([]);
  useEffect(() => setSelection(fileLoc && anchorId ? [anchorId] : []), [anchorId, fileLoc, trash]);
  const tree = useRef<DriveTreeHandle>(null);
  const findNode = useCallback(
    (id: string): SourceNode | undefined => items.find((n) => n.id === id) ?? tree.current?.lookup(id) ?? findCachedNode(qc, projectId, id) ?? (a?.id === id ? a : undefined),
    [items, qc, projectId, a],
  );
  // Details pop up when something is picked and go away with ✕ (no toolbar toggle; ⌘I still toggles).
  useEffect(() => {
    if (selection.length) useSourcesPrefs.getState().setInspector(true);
  }, [selection]);
  const selectedNodes = useMemo(() => selection.map((id) => findNode(id)).filter((n): n is SourceNode => !!n), [selection, findNode]);
  const single = selectedNodes.length === 1 ? selectedNodes[0] : null;
  const listedNode: SourceNode | null = a && a.kind === "folder" && !isSeq(nodeId) ? a : (runRow ?? null);
  const inspected = single ?? (selectedNodes.length > 1 ? null : listedNode);
  useAgentContext(useMemo(() => (project ? sourceNodeContext({ id: project.id, title: project.title, restricted: project.restricted }, inspected) : null), [project, inspected]));

  // ---- Reveal in the tree (anything but a click in the tree itself) ---------------------------
  const treeBox = useRef<HTMLDivElement>(null);
  const listing = useRef<ListingHandle>(null);
  const inspectorBox = useRef<HTMLDivElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const filterBox = useRef<HTMLInputElement>(null);
  const fromTree = useRef(false);
  const nonce = useRef(0);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const [filter, setFilter] = useState("");
  const [filterNote, setFilterNote] = useState<string | null>(null);
  useEffect(() => {
    if (!a || !nodeId) return;
    if (fromTree.current) {
      fromTree.current = false;
      return;
    }
    // Auto-reveal clears the tree filter when it would hide the row, and says so.
    if (filter) {
      setFilter("");
      setFilterNote(`Filter cleared to show “${a.name}”`);
    }
    const path = stripRoot(a.path).map((p) => p.id);
    if (isSeq(nodeId)) setReveal({ id: nodeId, path: [...path, a.id], nonce: ++nonce.current });
    else setReveal({ id: a.id, path, seq: a.runId ?? undefined, nonce: ++nonce.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per location, not per refetch
  }, [nodeId, a?.id]);
  useEffect(() => {
    if (!filterNote) return;
    const t = window.setTimeout(() => setFilterNote(null), 5000);
    return () => window.clearTimeout(t);
  }, [filterNote]);

  const go = useCallback(
    (id: string | null, opts: { tree?: boolean } = {}) => {
      if (!trash && id === (nodeId ?? null) && !importId) return;
      fromTree.current = !!opts.tree;
      navigate(filesUrl(projectId, id === rootId ? null : id));
    },
    [navigate, projectId, nodeId, importId, rootId, trash],
  );

  const openNode = (n: SourceNode, from: "tree" | "list" | "page") => {
    if (n.kind === "folder" || n.kind === "sequence") return go(n.id, { tree: from === "tree" });
    if (from === "tree") go(n.id, { tree: true });
    setSelection([n.id]);
    prefs.setInspector(true);
  };

  // ---- Quick Look -----------------------------------------------------------------------------
  const trashQ = useTrash(projectId, { enabled: trash || !!drive.data?.trashCount });
  const trashItems = useMemo(() => trashQ.data?.pages.flatMap((p) => p.items) ?? [], [trashQ.data]);
  const [ql, setQl] = useState<SourceNode | null>(null);
  const qlItems = trash ? trashItems : items;
  const qlFiles = qlItems.filter((n) => n.kind === "file");
  const stepQl = (d: number) => {
    const at = ql ? qlFiles.findIndex((f) => f.id === ql.id) : -1;
    if (at < 0 || qlFiles.length < 2) return;
    const next = qlFiles[(at + d + qlFiles.length) % qlFiles.length];
    setQl(next);
    if (!trash) setSelection([next.id]);
  };

  // ---- Names --------------------------------------------------------------------------------
  const siblingsOf = (parentId: string | null | undefined, except?: string): string[] => {
    if (!parentId) return [];
    const out = new Set<string>();
    for (const [, data] of qc.getQueriesData<ChildrenData>({ queryKey: filesKeys.children(projectId, parentId) })) for (const r of rowsOf(data)) if (r.id !== except) out.add(r.name);
    return [...out];
  };
  const validate = (name: string, n: SourceNode) => validateName(name, siblingsOf(n.parentId ?? rootId, n.id), { isFile: n.kind === "file", current: n.name });
  const warn = (name: string, n: SourceNode) => nameWarning(name, { isFile: n.kind === "file" });

  // ---- Edit rules ---------------------------------------------------------------------------
  const isRootId = (id: string | null | undefined) => !!id && id === rootId;
  const editReason = (n: SourceNode | null | undefined): string | null => {
    if (!writable) return NEEDS_FULL_STACK;
    if (!n) return null;
    if (isRootId(n.id)) return ROOT_FIXED;
    if (n.locked) return SAMPLE_LOCKED;
    return null;
  };
  const canRename = (n: SourceNode) => !editReason(n) && n.kind !== "sequence" && !isSeq(n.id);
  const folderLocked = (id: string | null | undefined) => (!id || isRootId(id) ? false : !!findNode(id)?.locked);
  const newFolderReason = (parentId: string | null | undefined) => (!writable ? NEEDS_FULL_STACK : folderLocked(parentId) ? SAMPLE_LOCKED : null);

  // ---- Drafts: "Untitled folder" until Enter ------------------------------------------------
  const drafts = useRef(new Map<string, { ctx: OptimisticContext; parentId: string; name: string; where: "tree" | "list" }>());
  const [draftIds, setDraftIds] = useState<Set<string>>(new Set());
  const [pendingEdit, setPendingEdit] = useState<{ id: string; where: "tree" | "list" } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [inspectorRenaming, setInspectorRenaming] = useState(false);
  const [treeTick, setTreeTick] = useState(0);

  const newFolder = async (parentId: string | null | undefined, where: "tree" | "list") => {
    const parent = parentId ?? rootId;
    if (!parent) return;
    const why = newFolderReason(parent);
    if (why) return void notify(why, { tone: "error" });
    const name = nextUntitled(siblingsOf(parent));
    const id = newNodeId();
    const ctx = await applyOptimistic(qc, projectId, [{ kind: "mkdir", parentId: parent, name, id }]);
    const shown = where === "list" && parent === listedFolderId && !searching ? "list" : "tree";
    drafts.current.set(id, { ctx, parentId: parent, name, where: shown });
    setDraftIds((s) => new Set(s).add(id));
    if (where === "tree" && !isRootId(parent)) tree.current?.open(parent);
    setPendingEdit({ id, where: shown });
  };
  const dropDraft = (id: string) => {
    drafts.current.delete(id);
    setDraftIds((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  };
  const cancelDraft = (id: string) => {
    const d = drafts.current.get(id);
    if (!d) return false;
    rollback(qc, d.ctx);
    d.ctx.settle();
    dropDraft(id);
    return true;
  };
  const commitDraft = async (id: string, name: string) => {
    const d = drafts.current.get(id);
    if (!d) return false;
    dropDraft(id);
    // Show the chosen name at once; the server's answer replaces the row.
    for (const [key, data] of qc.getQueriesData<ChildrenData>({ queryKey: filesKeys.children(projectId, d.parentId) })) {
      if (data) qc.setQueryData(key, { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map((x) => (x.id === id ? { ...x, name } : x)) })) });
    }
    const res = await ops.run([{ kind: "mkdir", parentId: d.parentId, name, id }], { optimistic: false, fallback: `Made the folder “${name}”` });
    d.ctx.settle();
    if (!res) rollback(qc, d.ctx);
    return true;
  };
  // A draft lives only in the cache until Enter. If its field goes away without a blur (Back,
  // a link, leaving the page), drop it, or a folder the server never heard of stays listed.
  useEffect(
    () => () => {
      for (const [id, d] of [...drafts.current]) if (d.where === "list" && d.parentId === listedFolderId) cancelDraft(id);
    },
    [listedFolderId], // eslint-disable-line react-hooks/exhaustive-deps -- cancelDraft reads refs
  );
  useEffect(
    () => () => {
      for (const id of [...drafts.current.keys()]) cancelDraft(id);
    },
    [projectId], // eslint-disable-line react-hooks/exhaustive-deps -- on leaving the page or project
  );
  useEffect(() => {
    if (editingId && !draftIds.has(editingId) && !items.some((n) => n.id === editingId)) setEditingId(null);
  }, [editingId, draftIds, items]);
  useEffect(() => {
    if (!pendingEdit) return;
    if (pendingEdit.where === "list") {
      if (items.some((n) => n.id === pendingEdit.id)) {
        setEditingId(pendingEdit.id);
        listing.current?.scrollTo(pendingEdit.id);
        setPendingEdit(null);
      }
    } else if (tree.current?.lookup(pendingEdit.id)) {
      // The tree takes the new row on its next render: retry for a moment.
      const id = pendingEdit.id;
      let tries = 0;
      const attempt = () => {
        if (tree.current?.edit(id)) return setPendingEdit((p) => (p?.id === id ? null : p));
        if (++tries < 20) timer = window.setTimeout(attempt, 50);
      };
      let timer = window.setTimeout(attempt, 0);
      return () => window.clearTimeout(timer);
    }
  }, [pendingEdit, items, treeTick]);

  const renameNode = async (n: SourceNode, raw: string): Promise<boolean> => {
    const name = raw.trim();
    if (drafts.current.has(n.id)) return commitDraft(n.id, name);
    if (!name || name === n.name) return false;
    if (n.kind === "file" && extensionChanged(n.name, name)) {
      const ok = await ops.confirmExtension(splitExtension(n.name)[1], splitExtension(name)[1]);
      if (!ok) return false;
    }
    const res = await ops.run([{ kind: "rename", nodeId: n.id, name }], { fallback: `Renamed to “${name}”` });
    return !!res;
  };

  // ---- Actions ------------------------------------------------------------------------------
  const [moveDlg, setMoveDlg] = useState<{ mode: "move" | "copy"; nodes: SourceNode[] } | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const star = useStar(projectId);
  const replace = useReplaceFile(projectId);
  const restoreVersion = useRestoreVersion(projectId);
  const emptyTrash = useEmptyTrash(projectId);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<SourceNode | null>(null);
  const uploadTarget = useRef<string | undefined>(undefined);
  const pickers = usePickers((p) => void addData(p, uploadTarget.current));
  const pickUpload = (folderId: string | null | undefined, which: "files" | "folder") => {
    uploadTarget.current = folderId && !isRootId(folderId) ? folderId : undefined;
    if (which === "files") pickers.files();
    else pickers.folder();
  };

  const toDragItem = (n: SourceNode): FsDragItem => ({ id: n.id, name: n.displayPath ?? n.name, kind: n.kind, parentId: n.parentId, locked: n.locked, icon: nodeIcon(n) });

  const pathNames = async (id: string): Promise<string> => {
    if (isRootId(id)) return "Files";
    const d = await qc.fetchQuery({ queryKey: projectKeys.node(id), queryFn: () => fetchNode(id) });
    return ["Files", ...stripRoot(d.path).map((p) => p.name), d.name].join("/");
  };
  const copyPath = async (id?: string | null) => {
    const target = id && !isSeq(id) ? id : (listedFolderId ?? rootId);
    if (!target) return;
    await navigator.clipboard?.writeText(await pathNames(target));
    notify("Path copied");
  };

  const moveOrCopy = async (nodes: SourceNode[], parentId: string, copy: boolean) => {
    const ids = nodes.map((n) => n.id);
    if (!copy && nodes.some((n) => n.locked)) {
      notify("Sample data can't be moved", { tone: "error", action: { label: "Copy instead", onClick: () => void moveOrCopy(nodes, parentId, true) } });
      return;
    }
    await ops.run([{ kind: copy ? "copy" : "move", nodeIds: ids, parentId }]);
  };

  const trashNodes = async (nodes: SourceNode[]) => {
    const list = nodes.filter((n) => !isRootId(n.id));
    if (!list.length) return;
    const res = await ops.run([{ kind: "trash", nodeIds: list.map((n) => n.id) }], { fallback: list.length === 1 ? `Moved “${list[0].name}” to Trash` : `Moved ${plural(list.length, "item")} to Trash` });
    if (!res) return;
    setSelection((s) => s.filter((id) => !list.some((n) => n.id === id)));
    // The folder shown went to Trash: show where it was.
    const gone = list.find((n) => n.id === listedFolderId || a?.path.some((p) => p.id === n.id));
    if (gone) go(gone.parentId ?? null);
  };

  const paste = async (targetId: string | null | undefined) => {
    const clip = clipboardFor(projectId);
    const parentId = targetId ?? listedFolderId ?? rootId;
    if (!clip || !parentId) return false;
    const res = await ops.run([{ kind: clip.mode === "cut" ? "move" : "copy", nodeIds: clip.nodeIds, parentId }]);
    if (res) useFilesClipboard.getState().pasted();
    return true;
  };

  // Duplicate in place never conflicts: the kernel names it "name (copy).ext" (docs/files-api.md).
  const duplicate = async (nodes: SourceNode[]) => {
    const list = nodes.filter((n) => !isRootId(n.id) && n.parentId);
    if (!list.length) return;
    const byParent = new Map<string, string[]>();
    for (const n of list) byParent.set(n.parentId!, [...(byParent.get(n.parentId!) ?? []), n.id]);
    const res = await ops.run(
      [...byParent].map(([parentId, nodeIds]): FsOp => ({ kind: "copy", nodeIds, parentId })),
      { fallback: list.length === 1 ? `Duplicated “${list[0].name}”` : `Duplicated ${plural(list.length, "item")}` },
    );
    if (!res || list.length !== 1) return;
    const want = copyName(list[0].name);
    const made = res.nodes.find((n) => n.id !== list[0].id && n.name === want) ?? res.nodes.find((n) => n.id !== list[0].id && n.parentId === list[0].parentId);
    if (!made) return;
    setSelection([made.id]);
    setPendingEdit({ id: made.id, where: made.parentId === listedFolderId && !searching ? "list" : "tree" });
  };

  const download = async (nodes: SourceNode[]) => {
    if (nodes.length === 1 && nodes[0].kind === "file") {
      if (nodes[0].status === "privacy") return void notify("This file is held for privacy review", { tone: "error", description: "Clear the hold (or rename the file) before downloading it." });
      return downloadNode(nodes[0].id);
    }
    const name = nodes.length === 1 ? `${nodes[0].name}.zip` : "files.zip";
    // One toast from start to end: "Preparing x.zip · 12.3 MB", then the outcome in its place.
    const toastId = notify(`Preparing ${name}`, { group: "zip" });
    let shown = 0;
    try {
      const p = await downloadZip(projectId, await expandRuns(projectId, nodes.map((n) => n.id)), {
        filename: name,
        onProgress: ({ received, total }) => {
          if (Date.now() - shown < 250) return;
          shown = Date.now();
          const mb = (b: number) => (b / 1e6).toFixed(1);
          progressNotice(toastId, `Preparing ${name}`, total ? `${mb(received)} of ${mb(total)} MB` : `${mb(received)} MB`);
        },
      });
      const held = p.held ? `${plural(p.held, "file")} held for privacy review ${p.held === 1 ? "was" : "were"} left out (listed in _held_files.txt)` : undefined;
      const size = p.received ? `${(p.received / 1e6).toFixed(1)} MB` : undefined;
      notify(`Downloaded ${name}`, { group: "zip", replace: toastId, description: [size, held].filter(Boolean).join(" · ") || undefined, tone: "success" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return void dismissNotice(toastId);
      notify(errorText(e), { tone: "error", group: "zip", replace: toastId });
    }
  };

  const toggleStar = (nodes: SourceNode[], on: boolean) => {
    for (const n of nodes) star.mutate({ nodeId: n.id, starred: on, node: n });
    notify(on ? (nodes.length === 1 ? `Starred “${nodes[0].name}”` : `Starred ${plural(nodes.length, "item")}`) : nodes.length === 1 ? `Removed “${nodes[0].name}” from Starred` : `Removed ${plural(nodes.length, "item")} from Starred`);
  };

  const startRename = (n: SourceNode, where: Area) => {
    const why = editReason(n);
    if (why) return void notify(why, { tone: "error" });
    if (!canRename(n)) return;
    if (where === "tree") return tree.current?.edit(n.id);
    if (where === "inspector") return setInspectorRenaming(true);
    if (items.some((x) => x.id === n.id) && !searching) {
      setSelection([n.id]);
      setEditingId(n.id);
    } else if (tree.current?.lookup(n.id)) {
      tree.current.edit(n.id);
    } else {
      setSelection([n.id]);
      prefs.setInspector(true);
      setInspectorRenaming(true);
    }
  };

  const openMove = (mode: "move" | "copy", nodes: SourceNode[]) => {
    if (!nodes.length) return;
    if (!writable) return void notify(NEEDS_FULL_STACK, { tone: "error" });
    setMoveError(null);
    setMoveDlg({ mode, nodes });
  };

  // ---- Menus --------------------------------------------------------------------------------
  const rowTypeOf = (n: SourceNode): FilesRowType => (n.kind === "folder" ? "folder" : n.kind === "sequence" ? "run" : "file");
  const entriesFor = (t: MenuTarget): MenuEntry[] => {
    const hist = editHistoryEntries({ undo: writable && undoLabel ? undoHint(undoLabel) : null, redo: writable && redoLabel ? redoHint(redoLabel) : null });
    if ("trash" in t) return menuItems("trash", { writable });
    if (!t.node) {
      const folder = findNode(t.folderId);
      const base = menuItems("folder", { writable, locked: folderLocked(t.folderId), isRoot: isRootId(t.folderId), clipboardCount: pasteCount, starred: folder?.starred });
      return [...base.filter((e) => ["newFolder", "uploadFiles", "uploadFolder", "paste", "copyPath"].includes(e.id)), ...hist];
    }
    const n = t.node;
    if (selection.length > 1 && selection.includes(n.id)) {
      const all = selectedNodes;
      return [...menuItems("multi", { writable, selectionCount: all.length, clipboardCount: pasteCount, starred: all.every((x) => x.starred), selectionLocked: all.some((x) => x.locked) }), ...hist];
    }
    const usedInTask = (inspected?.id === n.id && !!(anchor.data && "usedIn" in anchor.data && anchor.data.id === n.id && anchor.data.usedIn.some((u) => u.tasks.length))) || false;
    return [
      ...menuItems(rowTypeOf(n), { writable, locked: n.locked, sampleKind: n.kind, starred: n.starred, clipboardCount: pasteCount, runCount: n.kind === "sequence" ? n.childCount : undefined, isRoot: isRootId(n.id), usedInTask, hasVersions: n.version === undefined ? undefined : n.version > 1 || undefined }),
      ...hist,
    ];
  };

  const [pendingSelectAll, setPendingSelectAll] = useState(false);
  useEffect(() => {
    if (pendingSelectAll && !listQ.isLoading && items.length) {
      setSelection(items.map((n) => n.id));
      setPendingSelectAll(false);
    }
  }, [pendingSelectAll, items, listQ.isLoading]);

  const onMenuAction = (t: MenuTarget, id: FilesMenuAction) => {
    if ("trash" in t) {
      if (id === "restore") void ops.run([{ kind: "restore", nodeIds: [t.trash.id] }]);
      if (id === "deleteForever") void ops.run([{ kind: "purge", nodeIds: [t.trash.id] }]);
      return;
    }
    const n = t.node ?? (t.folderId ? (findNode(t.folderId) ?? null) : null);
    const folderId = t.node ? (t.node.kind === "folder" ? t.node.id : (t.node.parentId ?? rootId)) : t.folderId;
    const nodes = t.node && selection.length > 1 && selection.includes(t.node.id) ? selectedNodes : n ? [n] : [];
    switch (id) {
      case "open":
        if (n) openNode(n, t.from === "list" ? "list" : "page");
        break;
      case "quickLook":
        if (n) {
          setSelection([n.id]);
          setQl(n);
        }
        break;
      case "openInStudio": {
        const task = anchor.data && anchor.data.id === n?.id ? anchor.data.usedIn.find((u) => u.tasks.length)?.tasks[0] : undefined;
        if (task) navigate(studioUrl(projectId, task.id));
        break;
      }
      case "newFolder":
        void newFolder(folderId, t.from === "tree" ? "tree" : "list");
        break;
      case "uploadFiles":
        pickUpload(folderId, "files");
        break;
      case "uploadFolder":
        pickUpload(folderId, "folder");
        break;
      case "rename":
        if (n) startRename(n, t.from === "tree" ? "tree" : t.from === "path" ? "inspector" : "list");
        break;
      case "moveTo":
        openMove("move", nodes);
        break;
      case "copyTo":
        openMove("copy", nodes);
        break;
      case "duplicate":
        void duplicate(nodes);
        break;
      case "cut":
        clipboard.set(projectId, "cut", nodes.map((x) => x.id));
        notify(`Cut ${nodes.length === 1 ? `“${nodes[0].name}”` : plural(nodes.length, "item")}`, { description: "Paste moves it" });
        break;
      case "copy":
        clipboard.set(projectId, "copy", nodes.map((x) => x.id));
        notify(`Copied ${nodes.length === 1 ? `“${nodes[0].name}”` : plural(nodes.length, "item")}`, { description: "Paste makes a copy (no bytes are copied)" });
        break;
      case "paste":
        void paste(folderId);
        break;
      case "star":
        toggleStar(nodes, true);
        break;
      case "unstar":
        toggleStar(nodes, false);
        break;
      case "download":
      case "downloadZip":
        void download(nodes);
        break;
      case "replaceVersion":
        if (n) {
          replaceTarget.current = n;
          replaceInput.current?.click();
        }
        break;
      case "versionHistory":
        if (n) {
          setSelection([n.id]);
          prefs.setInspector(true);
        }
        break;
      case "copyPath":
        void copyPath(n?.id ?? folderId);
        break;
      case "showInExplore":
        navigate(exploreUrl(projectId));
        break;
      case "selectAll":
        if (n?.kind === "sequence") {
          go(n.id);
          setPendingSelectAll(true);
        } else setSelection(items.map((x) => x.id));
        break;
      case "trash":
        void trashNodes(nodes);
        break;
      case "undo":
        void ops.undo();
        break;
      case "redo":
        void ops.redo();
        break;
      case "restore":
      case "deleteForever":
        break;
    }
  };

  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const menuContent = menu && <FilesMenuItems entries={entriesFor(menu)} onAction={(id) => onMenuAction(menu, id)} primitives={contextMenuPrimitives} />;
  const resolveMenu = (e: React.MouseEvent, from: "tree" | "list" | "path"): MenuTarget | null => {
    const el = (e.target as Element).closest<HTMLElement>("[data-node-id]");
    const id = el?.dataset.nodeId;
    if (trash) {
      const t = id ? trashItems.find((x) => x.id === id) : undefined;
      return t ? { trash: t } : null;
    }
    if (id) {
      const n = findNode(id) ?? (isRootId(id) ? rootNode() : undefined);
      if (n) return { node: n, from };
    }
    if (from === "path") return null;
    const folderId = from === "tree" ? rootId : (listedFolderId ?? rootId);
    return folderId ? { node: null, folderId, from } : null;
  };
  const rootNode = (): SourceNode | undefined =>
    rootId ? { id: rootId, sourceId: "", parentId: null, name: "Files", kind: "folder", detectedKind: "folder", size: null, sha256: null, childCount: rootItems.length, descendantCount: 0, facts: {}, flags: {}, status: "ready", importSessionId: null, createdAt: null } : undefined;
  const menuRegion = (from: "tree" | "list" | "path", child: ReactNode, className?: string) => (
    <ContextMenu onOpenChange={(o) => !o && setMenu(null)}>
      <ContextMenuTrigger asChild>
        <div
          className={className}
          onContextMenu={(e) => {
            if ((e.target as Element).closest("input, textarea")) {
              e.stopPropagation();
              return;
            }
            const t = resolveMenu(e, from);
            if (!t) {
              e.preventDefault();
              return;
            }
            setMenu(t);
          }}
        >
          {child}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64" data-testid="sources-context-menu" onCloseAutoFocus={(e) => e.preventDefault()}>
        {menuContent}
      </ContextMenuContent>
    </ContextMenu>
  );

  // ---- Keys (core manifest commands; never hard-coded) ----------------------------------------
  const area = (): Area | null => {
    const el = document.activeElement;
    if (treeBox.current?.contains(el)) return "tree";
    if (listing.current?.contains(el)) return "list";
    if (inspectorBox.current?.contains(el)) return "inspector";
    return !el || el === document.body ? "page" : null;
  };
  const overlayOpen = () => !!document.querySelector("[role=dialog][data-state=open], [role=alertdialog][data-state=open], [role=menu]");
  const current = (where: Area): SourceNode | undefined => (where === "tree" ? tree.current?.focused() : (single ?? undefined));
  const targets = (where: Area): SourceNode[] => {
    if (where === "tree") {
      const f = tree.current?.focused();
      if (!f) return [];
      return selection.includes(f.id) ? selectedNodes : [f];
    }
    return selectedNodes;
  };
  const textSelected = () => !!window.getSelection()?.toString();

  const keys = useCommands(
    {
      quickLook: () => {
        if (ql) return void setQl(null);
        const where = area();
        const n = where && current(where);
        if (!where || !n || n.kind !== "file") return false;
        if (where === "tree") go(n.id, { tree: true });
        setSelection([n.id]);
        setQl(n);
      },
      openItem: () => {
        const where = area();
        if (ql || !where || where === "inspector") return false;
        const n = current(where);
        if (!n) return false;
        openNode(n, where);
      },
      parentFolder: () => {
        if (ql || searching || trash || atRoot) return false;
        go(parentOfListing());
      },
      focusSearch: () => {
        if (ql) return false;
        searchBox.current?.focus();
        searchBox.current?.select();
      },
      newFolder: () => {
        if (ql || trash || overlayOpen()) return false;
        const where = area();
        const f = where === "tree" ? tree.current?.focused() : undefined;
        void newFolder(f && f.kind === "folder" ? f.id : listedFolderId, where === "tree" ? "tree" : "list");
      },
      rename: () => {
        const where = area();
        const n = where && (current(where) ?? (where === "inspector" || where === "page" ? (inspected ?? undefined) : undefined));
        if (!where || !n || ql || trash) return false;
        startRename(n, where);
      },
      cut: () => {
        const where = area();
        const list = where && !textSelected() && !trash ? targets(where) : [];
        if (!list.length) return false;
        const why = list.map(editReason).find(Boolean);
        if (why) return void notify(why, { tone: "error" });
        clipboard.set(projectId, "cut", list.map((n) => n.id));
        notify(`Cut ${list.length === 1 ? `“${list[0].name}”` : plural(list.length, "item")}`, { description: "Paste moves it" });
      },
      copy: () => {
        const where = area();
        const list = where && !textSelected() && !trash ? targets(where) : [];
        if (!list.length) return false;
        clipboard.set(projectId, "copy", list.map((n) => n.id));
        notify(`Copied ${list.length === 1 ? `“${list[0].name}”` : plural(list.length, "item")}`, { description: "Paste makes a copy (no bytes are copied)" });
      },
      paste: () => {
        const where = area();
        if (!where || trash || !clipboardFor(projectId)) return false;
        const f = where === "tree" ? tree.current?.focused() : undefined;
        void paste(f && f.kind === "folder" ? f.id : listedFolderId);
      },
      duplicate: () => {
        const where = area();
        const list = where && !trash ? targets(where) : [];
        if (!list.length) return false;
        const why = list.map(editReason).find(Boolean);
        if (why) return void notify(why, { tone: "error" });
        void duplicate(list);
      },
      moveToTrash: () => {
        const where = area();
        const list = where && !trash && !ql ? targets(where) : [];
        if (!list.length) return false;
        const why = list.map(editReason).find(Boolean);
        if (why) return void notify(why, { tone: "error" });
        void trashNodes(list);
      },
      clearSelection: () => {
        if (ql || overlayOpen() || editingId) return false;
        if (filter && document.activeElement === filterBox.current) return false;
        if (!selection.length) return false;
        setSelection([]);
      },
      selectAll: () => {
        const where = area();
        if (!where || where === "inspector" || ql || trash) return false;
        setSelection(items.map((n) => n.id));
      },
      expandAllBelow: () => {
        if (area() !== "tree") return false;
        const f = tree.current?.focused();
        if (!f || f.kind === "file") return false;
        if (tree.current?.openRecursive(f.id, EXPAND_CAP)) notify(`Expand stopped at ${EXPAND_CAP.toLocaleString()}. Open folders one by one`);
      },
      toggleInspector: () => {
        if (!desktop) return false;
        prefs.setInspector(!prefs.inspector);
      },
      contextMenu: () => {
        const where = area();
        const id = where === "tree" ? tree.current?.focused()?.id : where === "list" ? (listing.current?.focusedId() ?? selection[0]) : undefined;
        const el = id ? (where === "tree" ? tree.current?.rowOf(id) : listing.current?.rowOf(id)) : null;
        if (!el) return false;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + Math.min(40, r.width / 2), clientY: r.top + r.height / 2 }));
      },
      undo: () => {
        if (overlayOpen() || !writable) return false;
        void ops.undo();
      },
      redo: () => {
        if (overlayOpen() || !writable) return false;
        void ops.redo();
      },
    },
    { scope: SCOPE, global: true },
  );
  // Quick Look steps with the core previous / next item commands (← → by default).
  const qlKeys = useCommands({ prevItem: () => stepQl(-1), nextItem: () => stepQl(1) }, { scope: SCOPE, global: true, enabled: !!ql });

  function parentOfListing(): string | null {
    if (!a) return null;
    if (isSeq(nodeId)) return a.id;
    if (a.kind === "folder") return a.parentId;
    // A file: its folder (or run) is listed; go one above that.
    return inRun ? (a.parentId ?? null) : (a.path.at(-2)?.id ?? null);
  }

  // ---- Path bar -------------------------------------------------------------------------------
  const runName = runRow?.name ?? (isSeq(nodeId) && items.length ? `${items[0].name}–${items.at(-1)!.name}` : "Numbered files");
  const segments: PathSegment[] = useMemo(() => {
    if (!a || atRoot) return [];
    const path = stripRoot(a.path);
    const segs = isSeq(nodeId)
      ? [...path, { id: a.id, name: a.name }, { id: nodeId!, name: runName }]
      : a.kind === "folder"
        ? [...path, { id: a.id, name: a.name }]
        : inRun
          ? [...path, { id: runId!, name: runName }]
          : path;
    return segs.map((s) => ({ ...s, locked: s.id === a.id ? a.locked : findCachedNode(qc, projectId, s.id)?.locked }));
  }, [a, atRoot, stripRoot, nodeId, runName, inRun, runId, qc, projectId]);

  // ---- Drag and drop: our rows (the drag controller) and OS files (uploads) -------------------
  const dragTarget = useFsDrag((s) => s.target?.id ?? null);
  // While rows are dragged the toolbar (with its breadcrumb drop targets) comes back.
  const dragging = useFsDrag((s) => !!s.drag);
  const ancestorsOf = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur = findNode(id)?.parentId;
    while (cur && !seen.has(cur) && out.length < 64) {
      seen.add(cur);
      out.unshift(cur);
      cur = findNode(cur)?.parentId;
    }
    if (a && (a.id === id || segments.some((s) => s.id === id))) for (const p of a.path) if (!out.includes(p.id)) out.unshift(p.id);
    return out;
  };
  const zone = useFsDropZone({
    describe: (id) => ({ ancestors: ancestorsOf(id), locked: folderLocked(id) }),
    onDrop: ({ items: dragged, target, copy }) => {
      const nodes = dragged.map((d) => findNode(d.id) ?? ({ id: d.id, name: d.name, kind: d.kind, parentId: d.parentId, locked: d.locked } as SourceNode));
      void moveOrCopy(nodes, target.id, copy);
    },
    onSpringOpen: (id) => {
      if (id !== listingId) go(id);
    },
  });
  const dropAttrs = (id: string, name: string) => (isSeq(id) ? undefined : fsDropTargetProps(id, name));
  const dragProps = (n: SourceNode) => {
    if (draftIds.has(n.id) || trash) return undefined;
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.stopPropagation();
        const list = selection.includes(n.id) ? selectedNodes : [n];
        if (!selection.includes(n.id)) setSelection([n.id]);
        startFsDrag(e, list.map(toDragItem), "listing");
      },
      onDragEnd: () => endFsDrag(),
    };
  };

  const listedFolderForDrop = (): { id: string; label: string } | undefined => {
    if (!listedFolderId || isRootId(listedFolderId)) return undefined;
    const name = isSeq(listingId) ? (a?.id === listedFolderId ? a.name : (findNode(listedFolderId)?.name ?? "this folder")) : (a?.kind === "folder" ? a.name : (findNode(listedFolderId)?.name ?? "this folder"));
    return { id: listedFolderId, label: name };
  };
  // OS files: the veil covers only the listing; over the tree or the path bar only the folder
  // under the pointer lights up (the same look as a row drag).
  const [drop, setDrop] = useState<{ id?: string; label: string; area: "tree" | "path" | "list" } | null>(null);
  const depth = useRef(0);
  const dropTarget = (el: EventTarget | null): { id?: string; label: string; area: "tree" | "path" | "list" } => {
    const e = el instanceof Element ? el : null;
    const area = e && treeBox.current?.contains(e) ? "tree" : e?.closest("[data-testid=path-bar]") ? "path" : "list";
    const row = e?.closest<HTMLElement>("[data-drop-id], [data-fs-drop-id]");
    const id = row?.dataset.dropId ?? row?.dataset.fsDropId;
    if (id && !isRootId(id)) return { id, label: row?.dataset.dropLabel ?? row?.dataset.fsDropLabel ?? "this folder", area };
    return { ...(listedFolderForDrop() ?? { label: project?.title ?? "this project" }), area: area === "list" ? "list" : area, ...(area !== "list" ? { id: undefined } : {}) };
  };
  const osDropId = drop && drop.area !== "list" ? (drop.id ?? null) : null;

  // ---- Inspector actions ----------------------------------------------------------------------
  const inspectorActions = {
    rootId,
    editReason,
    validate,
    warn,
    onRename: async (n: SourceNode, name: string) => {
      const ok = await renameNode(n, name);
      if (!ok && name !== n.name) throw new Error("Not renamed");
    },
    renaming: inspectorRenaming,
    onRenamingChange: setInspectorRenaming,
    onReplace: (n: SourceNode) => {
      replaceTarget.current = n;
      replaceInput.current?.click();
    },
    onRestoreVersion: (n: SourceNode, version: number) =>
      restoreVersion.mutate(
        { nodeId: n.id, version },
        { onSuccess: (r) => notify(r.summary || `Restored version ${version}`, { undo: () => void ops.undo(r.batchId), tone: "success" }), onError: (e) => notify(errorText(e), { tone: "error" }) },
      ),
    onDownloadVersion: (n: SourceNode, version: number, isCurrent: boolean) => (isCurrent ? downloadNode(n.id) : downloadVersion(n.id, version)),
  };

  // ---- Footer, trash, imports -----------------------------------------------------------------
  const starred = useStarred(projectId).data ?? [];
  const recent = useRecent(projectId).data ?? [];
  const [showImports, setShowImports] = useState(true);
  const [trashSel, setTrashSel] = useState<string[]>([]);
  const [wantPreview, setWantPreview] = useState(false);
  const previewQ = useEmptyTrashPreview(projectId, wantPreview);

  const nothing = !trash && !!rootQ.data && rootItems.length === 0 && !rootQ.isLoading;
  const anchorMissing = !!anchorId && anchor.isError;
  const notices = noticesFor(live.notices, listingId);
  const sortFor = (k: TreeSortKey) => setSort({ key: k, dir: k === sort.key ? sort.dir : k === "name" || k === "kind" ? 1 : -1 });
  const treeSelected = selection.length ? selection : nodeId && !isRootId(nodeId) ? [nodeId] : [];
  const treeSelectedRef = useRef(treeSelected);
  treeSelectedRef.current = treeSelected;
  const listedEditReason = newFolderReason(listedFolderId);

  const toolbarRight = (
    <div className="ml-auto flex items-center gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-hint" aria-hidden />
        <Input
          ref={searchBox}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              e.currentTarget.blur();
            }
          }}
          placeholder="Search all files"
          aria-label="Search all files"
          className="h-7 w-[min(260px,40vw)] pl-7"
          data-testid="sources-search"
        />
      </div>
      <SegmentedControl
        aria-label="View"
        value={view}
        onValueChange={(v) => prefs.setView(folderKind, v)}
        options={[
          { value: "list", label: <ListViewIcon />, "aria-label": "List view", title: "List" },
          { value: "grid", label: <GridViewIcon />, "aria-label": "Grid view", title: "Grid" },
        ]}
        size="md"
      />
    </div>
  );

  const newMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="default" data-testid="files-new">
          <PlusIcon /> New <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem disabled={!!listedEditReason} onSelect={() => void newFolder(listedFolderId, "list")} className={cn(listedEditReason && "items-start")} data-testid="files-new-folder">
          <NewFolderIcon />
          <span className="flex flex-col">
            <span>Folder</span>
            {listedEditReason && <span className="text-xs text-hint" data-testid="files-new-folder-reason">{listedEditReason}</span>}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => pickUpload(listedFolderId, "files")} data-testid="files-upload-files">
          <UploadIcon /> Upload files…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => pickUpload(listedFolderId, "folder")} data-testid="files-upload-folder">
          <UploadIcon /> Upload folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const selLocked = selectedNodes.some((n) => n.locked);
  const selRoot = selectedNodes.some((n) => isRootId(n.id));
  const plan = useReorgPlans((s) => (planId ? s.plans[planId] : undefined));

  return (
    <AppLayout>
      <div
        className="relative flex h-full min-h-0 flex-col"
        data-testid="sources-page"
        data-trash={trash || undefined}
        onDragEnter={(e) => {
          if (!hasFiles(e.dataTransfer)) return zone.onDragEnter(e);
          depth.current++;
          setDrop(dropTarget(e.target));
        }}
        onDragLeave={(e) => {
          if (!hasFiles(e.dataTransfer)) return zone.onDragLeave(e);
          if (--depth.current <= 0) {
            depth.current = 0;
            setDrop(null);
          }
        }}
        onDragOver={(e) => {
          if (!hasFiles(e.dataTransfer)) return zone.onDragOver(e);
          e.preventDefault();
          const t = dropTarget(e.target);
          if (t.id !== drop?.id || t.label !== drop?.label || t.area !== drop?.area) setDrop(t);
        }}
        onDrop={(e) => {
          if (!hasFiles(e.dataTransfer)) return zone.onDrop(e);
          e.preventDefault();
          const t = dropTarget(e.target);
          depth.current = 0;
          setDrop(null);
          void fromDataTransfer(e.dataTransfer).then((picked) => addData(picked, t.id));
        }}
      >
        {pickers.inputs}
        <input
          ref={replaceInput}
          type="file"
          hidden
          data-testid="pick-replace"
          onChange={(e) => {
            const file = e.target.files?.[0];
            const n = replaceTarget.current;
            e.target.value = "";
            if (!file || !n) return;
            if (!writable) return void notify(NEEDS_FULL_STACK, { tone: "error" });
            notify(`Uploading a new version of “${n.name}”`, { group: "replace" });
            replace.mutate({ nodeId: n.id, file }, { onSuccess: () => notify(`“${n.name}” has a new version`, { group: "replace", tone: "success" }), onError: (err) => notify(errorText(err), { tone: "error", group: "replace" }) });
          }}
        />

        {/* Toolbar: path, search, view, details, New ▾; the selection bar replaces it while anything is selected. */}
        {!trash && selection.length > 0 && !dragging ? (
          <SelectionBar
            count={selection.length}
            starred={selectedNodes.length > 0 && selectedNodes.every((n) => n.starred)}
            onMove={() => openMove("move", selectedNodes)}
            onCopy={() => openMove("copy", selectedNodes)}
            onDownload={() => void download(selectedNodes)}
            onStar={() => toggleStar(selectedNodes, !selectedNodes.every((n) => n.starred))}
            onTrash={() => void trashNodes(selectedNodes)}
            onClear={() => setSelection([])}
            disabled={{
              move: !writable ? NEEDS_FULL_STACK : selRoot ? ROOT_FIXED : selLocked ? SAMPLE_LOCKED : null,
              copy: !writable ? NEEDS_FULL_STACK : null,
              trash: !writable ? NEEDS_FULL_STACK : selRoot ? ROOT_FIXED : selLocked ? SAMPLE_LOCKED : null,
            }}
          >
            {pasteCount > 0 && (
              <ReasonButton variant="ghost" reason={listedEditReason} onClick={() => void paste(listedFolderId)} data-testid="selection-paste">
                <PasteIcon /> Paste ({pasteCount})
              </ReasonButton>
            )}
            {toolbarRight}
          </SelectionBar>
        ) : (
          <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            {menuRegion(
              "path",
              <PathBar
                rootLabel="Files"
                rootId={rootId}
                segments={trash ? [{ id: "trash", name: "Trash" }] : segments}
                hrefFor={(id) => (id === "trash" ? trashUrl(projectId) : filesUrl(projectId, id))}
                loading={!!anchorId && anchor.isLoading}
                searching={searching}
                onCopyPath={() => void copyPath()}
                loadSubfolders={(id) => fetchFsChildren(projectId, id).then((r) => r.items)}
                dropAttrs={trash ? undefined : dropAttrs}
                dropHighlightId={dragTarget ?? osDropId}
                folderMenu={
                  trash || !listedNode
                    ? undefined
                    : (seg) => {
                        const n = findNode(seg.id) ?? listedNode;
                        const t: MenuTarget = { node: n, from: "path" };
                        return <FilesMenuItems entries={entriesFor(t)} onAction={(id) => onMenuAction(t, id)} />;
                      }
                }
              />,
              "flex min-w-0 flex-1",
            )}
            {toolbarRight}
            {!trash && newMenu}
          </div>
        )}
        {(searching || !!query) && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-1.5 text-sm" data-testid="search-chips" onMouseDown={(e) => e.preventDefault()}>
            <span className="mr-1 text-muted-foreground">{searching ? (search.isLoading ? "Searching" : `${(search.data ?? []).length.toLocaleString()}${(search.data ?? []).length >= 200 ? "+" : ""} found`) : "Filter"}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Chip on={!!kind} data-testid="chip-kind">{kind ? KINDS[kind].plural : "Kind"}</Chip>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {(Object.keys(KINDS) as DetectedKind[])
                  .filter((k) => k !== "folder")
                  .map((k) => (
                    <DropdownMenuItem key={k} onSelect={() => setKind(k)}>{KINDS[k].plural}</DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {STATUS_CHIPS.map((c) => (
              <Chip key={c.value} on={status === c.value} onClick={() => setParam("status", status === c.value ? undefined : c.value)} data-testid={`chip-${c.value}`}>{c.label}</Chip>
            ))}
            {searching && (
              <Button
                variant="ghost-secondary"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setKind(undefined);
                  setParam("status", undefined);
                }}
              >
                <CloseIcon /> Clear
              </Button>
            )}
          </div>
        )}

        <ResizablePanelGroup id="sources-panes" className="min-h-0 flex-1">
          {desktop && (
            <>
              <ResizablePanel id="tree" defaultSize={260} minSize={180} maxSize={480}>
                <div ref={treeBox} className="flex h-full min-h-0 flex-col" data-testid="sources-tree">
                  <TreeHeader
                    label="Files"
                    sort={sort.key === "status" ? "name" : sort.key}
                    onSort={sortFor}
                    filter={filter}
                    onFilter={(v) => {
                      setFilter(v);
                      setFilterNote(null);
                    }}
                    filterRef={filterBox}
                    onNewFolder={() => {
                      const f = treeBox.current?.contains(document.activeElement) ? tree.current?.focused() : undefined;
                      void newFolder(f && f.kind === "folder" ? f.id : listedFolderId, "tree");
                    }}
                    onUpload={() => pickUpload(listedFolderId, "files")}
                    onCollapseAll={() => tree.current?.closeAll()}
                    disabled={{ newFolder: listedEditReason, upload: !writable ? NEEDS_FULL_STACK : null }}
                  />
                  {filterNote && (
                    <p className="px-4 pb-1 text-xs text-muted-foreground" role="status" data-testid="tree-filter-note">
                      {filterNote}
                    </p>
                  )}
                  {menuRegion(
                    "tree",
                    <>
                      {(drive.isLoading || (rootId && rootQ.isLoading)) && <TreeSkeleton />}
                      {drive.isError && <p className="px-3 py-2 text-sm text-muted-foreground">{errorText(drive.error)}</p>}
                      {rootId && rootQ.data && (
                        <DriveTree
                          ref={tree}
                          projectId={projectId}
                          rootId={rootId}
                          sort={fsSort}
                          selectedIds={treeSelected}
                          reveal={reveal}
                          initialOpen={onlyChild ? [onlyChild] : undefined}
                          onSelect={(ids) => {
                            if (sameIds(ids, treeSelectedRef.current)) return;
                            if (ids.length > 1) return setSelection(ids);
                            const n = ids[0] ? tree.current?.lookup(ids[0]) : undefined;
                            if (n) openNode(n, "tree");
                          }}
                          onActivate={(id) => {
                            const n = tree.current?.lookup(id);
                            if (n) openNode(n, "tree");
                          }}
                          onKey={keys}
                          onContextMenu={() => {}}
                          editable={canRename}
                          onRename={(id, name) => {
                            const n = tree.current?.lookup(id);
                            if (n) void renameNode(n, name);
                          }}
                          onRenameCancel={(id) => void cancelDraft(id)}
                          validate={validate}
                          warn={warn}
                          rowActions={(n) => (
                            <RowActions
                              n={n}
                              addReason={n.kind === "folder" ? newFolderReason(n.id) : null}
                              onAdd={n.kind === "folder" ? () => void newFolder(n.id, "tree") : undefined}
                              menu={(() => {
                                const t: MenuTarget = { node: n, from: "tree" };
                                return <FilesMenuItems entries={entriesFor(t)} onAction={(id) => onMenuAction(t, id)} />;
                              })()}
                            />
                          )}
                          canDrag={(n) => !draftIds.has(n.id)}
                          canDrop={({ dragIds, parentId }) => {
                            const list = dragIds.map((id) => tree.current?.lookup(id)).filter((x): x is SourceNode => !!x).map(toDragItem);
                            if (folderLocked(parentId)) return "Sample data can't be changed. Copy it to make your own";
                            if (list.some((i) => i.kind !== "file" && ancestorsOf(parentId).includes(i.id))) return "Can't move a folder into one of its own folders";
                            return true;
                          }}
                          onMove={({ dragIds, parentId, copy }) => {
                            const nodes = dragIds.map((id) => tree.current?.lookup(id)).filter((x): x is SourceNode => !!x);
                            if (!copy && nodes.every((n) => n.parentId === parentId)) return;
                            void moveOrCopy(nodes, parentId, copy);
                          }}
                          dropTargetId={dragTarget ?? osDropId}
                          onDragChange={(ids) => (ids ? beginFsDrag(ids.map((id) => tree.current?.lookup(id)).filter((x): x is SourceNode => !!x).map(toDragItem), "tree") : endFsDrag())}
                          searchTerm={filter}
                          onOpenCap={() => notify(`Expand stopped at ${EXPAND_CAP.toLocaleString()}. Open folders one by one`)}
                          cutIds={cutIds as string[]}
                          draftIds={draftIds}
                          onLoaded={() => setTreeTick((t) => t + 1)}
                        />
                      )}
                    </>,
                    "min-h-0 flex-1 px-1 pt-1",
                  )}
                  {showImports && <ImportsList sessions={imports.data ?? []} selectedId={importId} onOpen={(id) => navigate(filesUrl(projectId, pathNode, { import: id }))} />}
                  <TreeFooter
                    starred={starred}
                    recent={recent}
                    onReveal={(n) => (n.kind === "file" ? go(n.id) : go(n.id))}
                    trashCount={drive.data?.trashCount ?? 0}
                    trashActive={trash}
                    onOpenTrash={() => navigate(trashUrl(projectId))}
                    onOpenImports={imports.data?.length ? () => setShowImports((v) => !v) : undefined}
                    importsCount={imports.data?.length}
                    importsActive={showImports && !!imports.data?.length}
                    onOpenPipelines={writable ? () => navigate(pipelinesUrl(projectId)) : undefined}
                    dropAttrs={(n) => fsDropTargetProps(n.id, n.name, { spring: false })}
                    dropHighlightId={dragTarget}
                  />
                </div>
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}
          <ResizablePanel id="listing" minSize={320}>
            <div className="flex h-full min-h-0 flex-col">
              {plan && plan.projectId === projectId && !trash && (
                <PlanPanel
                  plan={plan.plan}
                  writable={writable}
                  run={ops.run}
                  onClose={() => {
                    useReorgPlans.getState().drop(plan.plan.id);
                    setParam("plan", null);
                  }}
                />
              )}
              {notices.length > 0 && (
                <div className="flex shrink-0 flex-wrap gap-2 border-b border-border bg-generic px-4 py-1.5 text-sm" role="status" data-testid="files-remote-notice">
                  {notices.map((n) => (
                    <span key={n.id}>{n.text}</span>
                  ))}
                </div>
              )}
              <div className="relative min-h-0 flex-1">
                {drop?.area === "list" && (
                  <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-veil p-6" data-testid="drop-overlay">
                    <div className="flex h-full w-full items-center justify-center rounded-xl border-2 border-dashed border-ring">
                      <p className="rounded-lg bg-float px-4 py-2 text-body-2 shadow-float">
                        Drop to add to <em className="font-semibold not-italic" data-testid="drop-target">{drop.label}</em>
                      </p>
                    </div>
                  </div>
                )}
                {trash ? (
                  <TrashView
                    items={trashItems}
                    total={trashQ.data?.pages[0]?.total ?? 0}
                    loading={trashQ.isLoading}
                    hasMore={!!trashQ.hasNextPage}
                    onMore={() => void trashQ.fetchNextPage()}
                    selectedIds={trashSel}
                    onSelectionChange={setTrashSel}
                    onRestore={(ids) => void ops.run([{ kind: "restore", nodeIds: ids }]).then((r) => r && setTrashSel([]))}
                    onDeleteForever={(ids) => void ops.run([{ kind: "purge", nodeIds: ids }]).then((r) => r && setTrashSel([]))}
                    onEmptyTrash={() =>
                      emptyTrash.mutate(undefined, {
                        onSuccess: (r) => notify(`Deleted ${plural(r.purged, "item")} for good`, { description: r.keptBytes.length ? `${plural(r.keptBytes.length, "file")} kept: something still uses them` : undefined }),
                        onError: (e) => notify(errorText(e), { tone: "error" }),
                      })
                    }
                    onEmptyTrashPreview={() => setWantPreview(true)}
                    keptBytes={previewQ.data?.keptBytes}
                    emptying={emptyTrash.isPending}
                    disabledReason={!writable ? NEEDS_FULL_STACK : null}
                    onOpen={(it) => (it.kind === "file" ? setQl(it) : undefined)}
                  />
                ) : importId ? (
                  <ImportSummary
                    id={importId}
                    projectId={projectId}
                    sources={sourceList}
                    onClose={() => navigate(filesUrl(projectId, pathNode))}
                    trashReason={(s: SourceSummary) => (!writable ? NEEDS_FULL_STACK : s.kind === "seed" ? SAMPLE_LOCKED : null)}
                    onTrash={(s: SourceSummary) => {
                      const n = findNode(s.rootNodeId!) ?? ({ id: s.rootNodeId!, name: s.title, kind: "folder", parentId: rootId } as SourceNode);
                      void trashNodes([n]).then(() => navigate(filesUrl(projectId)));
                    }}
                  />
                ) : nothing ? (
                  <div className="p-6">
                    <FilesEmptyState projectId={projectId} disabledReason={!writable ? NEEDS_FULL_STACK : null} />
                  </div>
                ) : anchorMissing ? (
                  <div className="p-6 text-sm text-muted-foreground" data-testid="node-missing">
                    This file or folder isn't in this project. <Link className="text-brand hover:underline" to={filesUrl(projectId)}>Show all files</Link>
                  </div>
                ) : (
                  menuRegion(
                    "list",
                    <Listing
                      ref={listing}
                      items={items}
                      loading={listLoading}
                      view={view}
                      sort={sort}
                      onSort={setSort}
                      selectedIds={selection}
                      onSelectionChange={(ids) => setSelection(ids)}
                      onOpen={(n) => (n.kind === "file" ? (setSelection([n.id]), setQl(n)) : openNode(n, "list"))}
                      total={searching ? undefined : listQ.data?.pages[0]?.total}
                      hasMore={!searching && !!listQ.hasNextPage}
                      onMore={() => void listQ.fetchNextPage()}
                      showFolder={searching}
                      dropFolder={listedFolderForDrop()}
                      cutIds={cutIds}
                      editingId={editingId}
                      draftIds={draftIds}
                      validateName={validate}
                      warnName={warn}
                      onRename={(n, name) => {
                        setEditingId(null);
                        void renameNode(n, name);
                        listing.current?.focus();
                      }}
                      onRenameCancel={(n) => {
                        setEditingId(null);
                        cancelDraft(n.id);
                        listing.current?.focus();
                      }}
                      dragProps={dragProps}
                      dropAttrs={(n) => fsDropTargetProps(n.id, n.name)}
                      dropTargetId={dragTarget}
                      empty={
                        searching ? (
                          <NoResults what="files" />
                        ) : (
                          <EmptyState art="folder" title="This folder is empty" description="Drop files or folders here, or use Add data. Originals are kept exactly as they are." />
                        )
                      }
                    />,
                    "h-full",
                  )
                )}
              </div>
            </div>
          </ResizablePanel>
          {desktop && prefs.inspector && !trash && selection.length > 0 && (
            <>
              <ResizableHandle />
              <ResizablePanel id="inspector" defaultSize={320} minSize={260} maxSize={520}>
                <div ref={inspectorBox} className="h-full">
                  <Inspector projectId={projectId} item={trash ? null : inspected} items={trash ? undefined : selectedNodes} onClose={() => prefs.setInspector(false)} actions={inspectorActions} />
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>

      </div>

      <QuickLook items={qlItems} current={ql} onStep={(n) => (setQl(n), !trash && setSelection([n.id]))} onClose={() => setQl(null)} onKey={(e) => qlKeys(e) || keys(e)} />
      <FsDragGhost />
      {ops.dialogs}
      <MoveDialog
        open={!!moveDlg}
        onOpenChange={(o) => !o && setMoveDlg(null)}
        mode={moveDlg?.mode ?? "move"}
        itemCount={moveDlg?.nodes.length ?? 0}
        itemName={moveDlg?.nodes.length === 1 ? moveDlg.nodes[0].name : undefined}
        root={{ id: rootId ?? "", name: "Files" }}
        initialPath={segments.filter((s) => !isSeq(s.id)).map((s) => ({ id: s.id, name: s.name, locked: s.locked }))}
        loadFolders={(id) => fetchFsChildren(projectId, id).then((r) => r.items)}
        recent={readRecent(projectId)}
        validate={(target, path) => {
          const list = moveDlg?.nodes ?? [];
          if (list.some((n) => n.id === target)) return "Can't move a folder into itself";
          if (moveDlg?.mode === "move" && list.some((n) => path.some((p) => p.id === n.id))) return "Can't move a folder into one of its own folders";
          if (moveDlg?.mode === "move" && list.every((n) => n.parentId === target)) return "It's already in this folder";
          return null;
        }}
        onNewFolder={async (parentId, name) => {
          const id = newNodeId();
          const res = await ops.run([{ kind: "mkdir", parentId, name, id }], { optimistic: false, quiet: true });
          if (!res) throw new Error("Couldn't make the folder");
          const made = res.nodes.find((n) => n.kind === "folder" && n.name === name) ?? res.nodes[0];
          return { id: made?.id ?? id, name };
        }}
        newFolderDisabledReason={!writable ? NEEDS_FULL_STACK : null}
        validateName={(name) => validateName(name, [])}
        busy={moveBusy}
        error={moveError}
        onConfirm={async (target) => {
          if (!moveDlg) return;
          setMoveBusy(true);
          setMoveError(null);
          const res = await ops.run([{ kind: moveDlg.mode, nodeIds: moveDlg.nodes.map((n) => n.id), parentId: target } as FsOp]);
          setMoveBusy(false);
          if (!res) return setMoveError("Nothing was moved. See the message at the bottom left.");
          setMoveDlg(null);
          if (!isRootId(target)) {
            void qc
              .fetchQuery({ queryKey: projectKeys.node(target), queryFn: () => fetchNode(target) })
              .then((d) => writeRecent(projectId, { id: d.id, name: d.name, locked: d.locked, path: stripRoot(d.path).map((p) => ({ id: p.id, name: p.name })) }))
              .catch(() => undefined);
          }
        }}
      />
    </AppLayout>
  );
}

/** The `+` (new folder inside) and `⋯` (the row's menu) on a tree row, shown on hover or focus. */
function RowActions({ n, onAdd, addReason, menu }: { n: SourceNode; onAdd?: () => void; addReason: string | null; menu: ReactNode }) {
  return (
    <>
      {onAdd && (
        <ReasonButton variant="ghost-secondary" size="icon-xs" reason={addReason} tip="New folder inside" aria-label={`New folder in ${n.name}`} onClick={onAdd} tabIndex={-1} data-testid="tree-row-add">
          <PlusIcon />
        </ReasonButton>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost-secondary" size="icon-xs" aria-label={`Actions for ${n.name}`} tabIndex={-1} data-testid="tree-row-more">
            <MoreIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64" data-testid="tree-row-menu">
          {menu}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function Chip({ on, className, children, ...rest }: React.ComponentProps<"button"> & { on: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      className={cn("inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-sm transition-colors", on ? "border-transparent bg-selection text-brand-heavy" : "border-border text-muted-foreground hover:bg-generic hover:text-foreground", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

function TreeSkeleton() {
  return (
    <div className="space-y-1 px-2" aria-hidden>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-7 items-center gap-2" style={{ paddingLeft: (i % 3) * 12 }}>
          <Skeleton className="size-4 rounded-sm" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
    </div>
  );
}

/** The kind most files in a listing have ("image"), or "mixed". */
function dominantKind(items: SourceNode[]): string {
  const counts = new Map<string, number>();
  let files = 0;
  for (const n of items) {
    if (n.kind === "folder") continue;
    const k = nodeKind(n);
    counts.set(k, (counts.get(k) ?? 0) + (n.kind === "sequence" ? n.childCount : 1));
    files += n.kind === "sequence" ? n.childCount : 1;
  }
  const [k, c] = [...counts].sort((x, y) => y[1] - x[1])[0] ?? ["mixed", 0];
  return files && c / files > 0.5 ? k : items.length && !files ? "folders" : "mixed";
}
