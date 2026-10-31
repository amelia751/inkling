import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { DetectedKind, SourceNode, SourceSummary } from "@studio/contracts/types";
import { ns } from "@studio/contracts/naming";
import { ChevronRightIcon, CloseIcon, GridViewIcon, ListViewIcon, MoreIcon, SearchIcon } from "@studio/ui/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@studio/ui/ui/alert-dialog";
import { Button } from "@studio/ui/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Input } from "@studio/ui/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@studio/ui/ui/resizable";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import { useCommands } from "@/extension-host/commands";
import { AppLayout } from "@/studio/components/layout/app-layout";
import { sourceNodeContext, useAgentContext } from "@/studio/lib/agent/providers";
import { AddDataButton, DropZone, useAddData } from "@/studio/components/uploads/uploads";
import { ImportsList, ImportSummary } from "@/studio/components/sources/imports";
import { Inspector } from "@/studio/components/sources/inspector";
import { Listing, sortItems, type ListingHandle, type Sort } from "@/studio/components/sources/listing";
import { QuickLook } from "@/studio/components/sources/quick-look";
import { isSeq, pagesItems, seqFolder, useFolder, useImports, useNode, useSearch, useSources } from "@/studio/components/sources/queries";
import { SourceTree, type RevealRequest, type SourceTreeHandle, type TreeTarget } from "@/studio/components/sources/source-tree";
import { api, fetchNode, projectKeys, useProjectSummary } from "@/studio/lib/projects-api";
import { KINDS, nodeKind } from "@/studio/lib/file-kinds";
import { exploreUrl, sourcesUrl } from "@/studio/lib/routes";
import { useViewport } from "@/studio/lib/use-media-query";
import { fromDataTransfer, hasFiles } from "@/studio/lib/uploads/walk";
import { defaultView, useSourcesPrefs } from "@/studio/stores/sources";

/**
 * Sources (todo6 Phase 4, docs/ux.md §6): the files a project holds, exactly as they arrived.
 * Three panes: the tree (the project's sources as roots), the listing of the folder shown and
 * the inspector of the selection. Drive's moves (drop anywhere, a tray, list or grid), Finder's
 * keys (declared as Sources commands) and nothing that edits an original.
 *
 * URL: `/projects/:p/sources/:nodeId?` names a folder (listed), a file (its folder listed, the
 * file selected) or a numbered run (`seq:…`); node ids only, never names (paths may hold
 * identifiers). `?import=` shows an import's summary, `?status=` filters by status. The
 * search text stays out of the URL for the same reason.
 */
const SCOPE = ns("core");
const DEFAULT_SORT: Sort = { key: "name", dir: 1 };
const STATUS_CHIPS = [
  { value: "attention", label: "Needs attention" },
  { value: "unsupported", label: "Can't read" },
] as const;

export function SourcesPage() {
  const { projectId = "", nodeId: pathNode } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const importId = params.get("import");
  const status = params.get("status") ?? undefined;
  const desktop = useViewport() === "desktop";
  const project = useProjectSummary(projectId).data;
  const prefs = useSourcesPrefs();
  const addData = useAddData(projectId);

  const sources = useSources(projectId);
  const sourceList = useMemo(() => sources.data ?? [], [sources.data]);
  // One source: its folder is the page (no click through a list of one, and no URL change).
  const onlyRoot = sourceList.length === 1 ? sourceList[0].rootNodeId : null;
  const nodeId = pathNode ?? onlyRoot ?? undefined;
  const imports = useImports(projectId);

  // ---- Where we are -----------------------------------------------------------------------
  const anchorId = nodeId ? (isSeq(nodeId) ? seqFolder(nodeId) : nodeId) : null;
  const anchor = useNode(anchorId);
  const a = anchor.data && anchor.data.id === anchorId ? anchor.data : undefined;
  const fileLoc = !!a && !isSeq(nodeId) && a.kind === "file";
  const baseFolder = !nodeId ? null : isSeq(nodeId) ? nodeId : a ? (a.kind === "folder" ? a.id : a.parentId) : null;
  const folderQ = useFolder(a?.sourceId, baseFolder);
  const folderItems = useMemo(() => pagesItems(folderQ.data?.pages), [folderQ.data]);
  // A file collapsed into a numbered run: list the run, so the file is among the rows.
  const runId = fileLoc ? (a.runId ?? null) : null;
  const inRun = !!runId && folderItems.some((n) => n.id === runId);
  const runQ = useFolder(a?.sourceId, inRun ? runId : null);
  const listQ = inRun ? runQ : folderQ;
  const listingId = inRun ? runId : baseFolder;
  const runRow = inRun ? folderItems.find((n) => n.id === runId) : undefined;

  // ---- Search -------------------------------------------------------------------------------
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<DetectedKind | undefined>();
  useEffect(() => {
    const t = window.setTimeout(() => setQ(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);
  const searching = !!q || !!kind || !!status;
  const search = useSearch(projectId, q, kind, status);
  const setStatus = (v: string | undefined) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set("status", v);
        else n.delete("status");
        return n;
      },
      { replace: true },
    );

  // ---- The rows shown -------------------------------------------------------------------------
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const rawItems: SourceNode[] = useMemo(() => {
    if (searching) return search.data ?? [];
    if (!nodeId) return sourceList.filter((s) => s.rootNodeId).map(rootRow);
    return pagesItems(listQ.data?.pages);
  }, [searching, search.data, nodeId, sourceList, listQ.data]);
  const items = useMemo(() => sortItems(rawItems, sort), [rawItems, sort]);
  const listLoading = searching ? search.isLoading : !nodeId ? sources.isLoading : anchor.isLoading || listQ.isLoading;

  // Remembered per folder kind ("mostly images"), never per path.
  const folderKind = useMemo(() => dominantKind(items), [items]);
  const view = searching ? "list" : (prefs.views[folderKind] ?? defaultView(folderKind));

  // ---- Selection ------------------------------------------------------------------------------
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(fileLoc ? anchorId : null), [anchorId, fileLoc]);
  // Details pop up when something is picked and go away with ✕ (no toolbar toggle).
  useEffect(() => {
    if (selected) useSourcesPrefs.getState().setInspector(true);
  }, [selected]);
  const selectedItem = items.find((n) => n.id === selected) ?? (a && a.id === selected ? a : null);
  const inspected = selectedItem ?? (a && a.kind === "folder" && !isSeq(nodeId) ? a : (runRow ?? null));
  // What the assistant sees here: the inspected node and its facts, never file contents (todo6 Phase 6).
  useAgentContext(useMemo(() => (project ? sourceNodeContext({ id: project.id, title: project.title, restricted: project.restricted }, inspected) : null), [project, inspected]));

  // ---- Reveal in the tree (anything but a click in the tree itself) ---------------------------
  const tree = useRef<SourceTreeHandle>(null);
  const treeBox = useRef<HTMLDivElement>(null);
  const listing = useRef<ListingHandle>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  const fromTree = useRef(false);
  const nonce = useRef(0);
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  useEffect(() => {
    if (!a || !nodeId) return;
    if (fromTree.current) {
      fromTree.current = false;
      return;
    }
    const path = a.path.map((p) => p.id);
    if (isSeq(nodeId)) setReveal({ id: nodeId, path: [...path, a.id], nonce: ++nonce.current });
    else setReveal({ id: a.id, path, seq: a.runId ?? undefined, nonce: ++nonce.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per location, not per refetch
  }, [nodeId, a?.id]);

  const go = useCallback(
    (id: string | null, opts: { tree?: boolean } = {}) => {
      if (id === (nodeId ?? null) && !importId) return;
      fromTree.current = !!opts.tree;
      navigate(sourcesUrl(projectId, id));
    },
    [navigate, projectId, nodeId, importId],
  );

  const openNode = (n: SourceNode, from: "tree" | "list" | "page") => {
    if (n.kind === "folder" || n.kind === "sequence") return go(n.id, { tree: from === "tree" });
    if (from === "tree") go(n.id, { tree: true });
    setSelected(n.id);
    prefs.setInspector(true);
  };

  // ---- Quick Look -----------------------------------------------------------------------------
  const [ql, setQl] = useState<SourceNode | null>(null);
  const qlFiles = items.filter((n) => n.kind === "file");
  const stepQl = (d: number) => {
    const at = ql ? qlFiles.findIndex((f) => f.id === ql.id) : -1;
    if (at < 0 || qlFiles.length < 2) return;
    const next = qlFiles[(at + d + qlFiles.length) % qlFiles.length];
    setQl(next);
    setSelected(next.id);
  };

  // ---- Keys (core manifest commands; never hard-coded) ----------------------------------------
  const area = (): "tree" | "list" | "page" | null => {
    const el = document.activeElement;
    if (treeBox.current?.contains(el)) return "tree";
    if (listing.current?.contains(el)) return "list";
    return !el || el === document.body ? "page" : null;
  };
  const treeTarget = (t: TreeTarget | undefined): SourceNode | undefined => (t?.node ? t.node : t?.source ? rootRow(t.source) : undefined);
  const current = (where: "tree" | "list" | "page"): SourceNode | undefined => (where === "tree" ? treeTarget(tree.current?.focused()) : (selectedItem ?? undefined));

  const keys = useCommands(
    {
      quickLook: () => {
        if (ql) return void setQl(null);
        const where = area();
        const n = where && current(where);
        if (!where || !n || n.kind !== "file") return false;
        if (where === "tree") go(n.id, { tree: true });
        setSelected(n.id);
        setQl(n);
      },
      openItem: () => {
        const where = area();
        const n = !ql && where && current(where);
        if (!where || !n) return false;
        openNode(n, where);
      },
      parentFolder: () => {
        if (ql || searching || !nodeId) return false;
        go(parentOfListing());
      },
      focusSearch: () => {
        if (ql) return false;
        searchBox.current?.focus();
        searchBox.current?.select();
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
  const segments: { id: string; name: string }[] = !a
    ? []
    : isSeq(nodeId)
      ? [...a.path, { id: a.id, name: a.name }, { id: nodeId!, name: runName }]
      : a.kind === "folder"
        ? [...a.path, { id: a.id, name: a.name }]
        : inRun
          ? [...a.path, { id: runId!, name: runName }]
          : a.path;
  const copyPath = async (id?: string) => {
    let names = segments.map((s) => s.name);
    if (id && !isSeq(id)) {
      const d = await qc.fetchQuery({ queryKey: projectKeys.node(id), queryFn: () => fetchNode(id) });
      names = [...d.path.map((p) => p.name), d.name];
    }
    await navigator.clipboard?.writeText(names.join("/"));
  };

  // ---- Drop anywhere --------------------------------------------------------------------------
  const listedFolder = (): { id: string; label: string } | undefined => {
    if (!a) return undefined;
    if (isSeq(nodeId) || inRun || a.kind === "file") {
      const id = isSeq(nodeId) ? a.id : a.parentId;
      const seg = [...a.path, { id: a.id, name: a.name }].find((s) => s.id === id);
      return id && seg ? { id, label: seg.name } : undefined;
    }
    return { id: a.id, label: a.name };
  };
  // Over the tree, only the folder row under the pointer lights up; anywhere else the listing
  // shows the overlay (it never covers the tree).
  type DropAt = { id?: string; label: string; zone: "tree" | "list" };
  const [drop, setDrop] = useState<DropAt | null>(null);
  const depth = useRef(0);
  const dropTarget = (el: EventTarget | null): DropAt => {
    const zone = el instanceof Node && treeBox.current?.contains(el) ? "tree" : "list";
    const row = el instanceof Element ? el.closest<HTMLElement>("[data-drop-id]") : null;
    if (row?.dataset.dropId) return { id: row.dataset.dropId, label: row.dataset.dropLabel ?? "this folder", zone };
    return { ...(listedFolder() ?? { label: project?.title ?? "this project" }), zone };
  };

  // ---- Context menu (read-only: no rename, move or delete of an original) ---------------------
  const [menu, setMenu] = useState<{ x: number; y: number; n: SourceNode; source?: SourceSummary } | null>(null);
  const [removing, setRemoving] = useState<SourceSummary | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const sourceOfRoot = (n: SourceNode) => sourceList.find((s) => s.rootNodeId === n.id);

  const nothing = sources.data && sourceList.length === 0;
  const anchorMissing = !!anchorId && anchor.isError;

  return (
    <AppLayout>
      <div
        className="relative flex h-full min-h-0 flex-col"
        data-testid="sources-page"
        onDragEnter={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          depth.current++;
          setDrop(dropTarget(e.target));
        }}
        onDragLeave={() => {
          if (--depth.current <= 0) {
            depth.current = 0;
            setDrop(null);
          }
        }}
        onDragOver={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          const t = dropTarget(e.target);
          if (t.id !== drop?.id || t.label !== drop?.label || t.zone !== drop?.zone) setDrop(t);
        }}
        onDrop={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          const t = dropTarget(e.target);
          depth.current = 0;
          setDrop(null);
          void fromDataTransfer(e.dataTransfer).then((picked) => addData(picked, t.id));
        }}
      >
        {/* Toolbar: path, search, view, add data. */}
        <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <PathBar projectId={projectId} segments={segments} loading={!!anchorId && anchor.isLoading} onCopy={() => void copyPath()} searching={searching} />
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
                placeholder="Search in data"
                aria-label="Search in data"
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
            <AddDataButton size="default" onPick={(p) => void addData(p, listedFolder()?.id)} />
          </div>
        </div>
        {(searching || !!query) && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-1.5 text-sm" data-testid="search-chips" onMouseDown={(e) => e.preventDefault()}>
            <span className="mr-1 text-muted-foreground">{searching ? (search.isLoading ? "Searching…" : `${(search.data ?? []).length.toLocaleString()}${(search.data ?? []).length >= 200 ? "+" : ""} found`) : "Filter"}</span>
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
              <Chip key={c.value} on={status === c.value} onClick={() => setStatus(status === c.value ? undefined : c.value)} data-testid={`chip-${c.value}`}>{c.label}</Chip>
            ))}
            {searching && (
              <Button
                variant="ghost-secondary"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setKind(undefined);
                  setStatus(undefined);
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
                  {drop?.zone === "tree" && drop.id && (
                    // Node ids are opaque hashes (`nod-…`), safe in a selector.
                    <style>{`[data-testid=sources-tree] [data-drop-id="${CSS.escape(drop.id)}"] { background-color: var(--g-selection-hover); box-shadow: inset 0 0 0 1px var(--g-line-focus); }`}</style>
                  )}
                  <div className="min-h-0 flex-1 px-1 pt-2">
                    {sources.isLoading && <TreeSkeleton />}
                    {sources.data && sourceList.length > 0 && (
                      <SourceTree
                        ref={tree}
                        sources={sourceList}
                        selectedId={nodeId ?? null}
                        reveal={reveal}
                        onSelect={(t) => {
                          const n = treeTarget(t);
                          if (n) openNode(n, "tree");
                        }}
                        onKey={keys}
                        onContextMenu={(t, e) => {
                          const n = treeTarget(t);
                          if (n) setMenu({ x: e.clientX, y: e.clientY, n, source: t.source });
                        }}
                      />
                    )}
                  </div>
                  <ImportsList sessions={imports.data ?? []} selectedId={importId} onOpen={(id) => navigate(sourcesUrl(projectId, pathNode, { import: id }))} />
                </div>
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}
          <ResizablePanel id="listing" minSize={320} className="relative">
            {importId ? (
              <ImportSummary id={importId} projectId={projectId} sources={sourceList} onClose={() => navigate(sourcesUrl(projectId, pathNode))} />
            ) : nothing ? (
              <div className="p-6">
                <DropZone onPick={(p) => void addData(p)} title="Add the files you have" hint="Drop a folder here, as it is: DICOM exports, spreadsheets, videos, PDFs. Originals are kept exactly as they arrive." />
              </div>
            ) : anchorMissing ? (
              <div className="p-6 text-sm text-muted-foreground" data-testid="node-missing">
                This file or folder isn't in this project. <Link className="text-brand hover:underline" to={sourcesUrl(projectId)}>Show all sources</Link>
              </div>
            ) : (
              <Listing
                ref={listing}
                items={items}
                loading={listLoading}
                view={view}
                sort={sort}
                onSort={setSort}
                selectedId={selected}
                onSelect={(n) => setSelected(n.id)}
                onOpen={(n) => (n.kind === "file" ? (setSelected(n.id), setQl(n)) : openNode(n, "list"))}
                onContextMenu={(n, e) => setMenu({ x: e.clientX, y: e.clientY, n, source: sourceOfRoot(n) })}
                hasMore={!searching && !!nodeId && !!listQ.hasNextPage}
                onMore={() => void listQ.fetchNextPage()}
                showFolder={searching}
                dropFolder={listedFolder()}
                empty={<p className="text-sm text-muted-foreground">{searching ? "No files match." : "This folder is empty."}</p>}
              />
            )}
            {drop?.zone === "list" && (
              <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-veil p-6" data-testid="drop-overlay">
                <div className="flex h-full w-full items-center justify-center rounded-xl border-2 border-dashed border-ring">
                  <p className="rounded-lg bg-float px-4 py-2 text-body-2 shadow-float">
                    Drop to add to <em className="font-semibold not-italic" data-testid="drop-target">{drop.label}</em>
                  </p>
                </div>
              </div>
            )}
          </ResizablePanel>
          {desktop && prefs.inspector && selectedItem && (
            <>
              <ResizableHandle />
              <ResizablePanel id="inspector" defaultSize={320} minSize={260} maxSize={520}>
                <Inspector projectId={projectId} item={inspected} onClose={() => prefs.setInspector(false)} />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>

      </div>

      <QuickLook items={items} current={ql} onStep={(n) => (setQl(n), setSelected(n.id))} onClose={() => setQl(null)} onKey={(e) => qlKeys(e) || keys(e)} />

      {menu && (
        <DropdownMenu open onOpenChange={(o) => !o && setMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span aria-hidden className="fixed size-0" style={{ left: menu.x, top: menu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56" data-testid="sources-context-menu">
            <DropdownMenuItem onSelect={() => openNode(menu.n, "list")}>Open</DropdownMenuItem>
            {menu.n.kind === "file" && (
              <DropdownMenuItem
                onSelect={() => {
                  setSelected(menu.n.id);
                  setQl(menu.n);
                }}
              >
                Quick Look
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <Link to={exploreUrl(projectId)}>Show in Explore</Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void copyPath(menu.n.id)}>Copy path</DropdownMenuItem>
            {menu.source && (
              <>
                <DropdownMenuSeparator />
                <RemoveItem source={menu.source} onRemove={(s) => (setRemoveError(null), setRemoving(s))} />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this upload?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.fileCount.toLocaleString()} {removing?.fileCount === 1 ? "file" : "files"} in “{removing?.title}” leave the project. Nothing else changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && <p className="text-sm text-danger">{removeError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                const s = removing!;
                api(`/sources/${encodeURIComponent(s.id)}`, { method: "DELETE" })
                  .then(() => {
                    setRemoving(null);
                    void qc.invalidateQueries({ queryKey: ["projects", projectId] });
                    void qc.invalidateQueries({ queryKey: ["sources"] });
                    if (a?.sourceId === s.id) navigate(sourcesUrl(projectId));
                  })
                  .catch((err: Error) => setRemoveError(err.message));
              }}
            >
              Remove upload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

/** "Remove upload…", disabled with the reason while a dataset uses it (or for sample data). */
function RemoveItem({ source, onRemove }: { source: SourceSummary; onRemove: (s: SourceSummary) => void }) {
  const reason = source.kind === "seed" ? "Sample data can't be removed" : source.usedInDatasets.length ? "A dataset uses it: remove it there first" : null;
  return (
    <DropdownMenuItem disabled={!!reason} onSelect={() => onRemove(source)} className="flex-col items-start gap-0">
      <span>Remove upload…</span>
      {reason && <span className="text-xs text-hint">{reason}</span>}
    </DropdownMenuItem>
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

/** Breadcrumb of folder names; the last segment has `•••` → "Copy path" (a deliberate act). */
function PathBar({ projectId, segments, loading, onCopy, searching }: { projectId: string; segments: { id: string; name: string }[]; loading: boolean; onCopy: () => void; searching: boolean }) {
  return (
    <nav aria-label="Folder path" className="flex min-w-0 flex-1 items-center gap-1 text-sm" data-testid="path-bar">
      <Link to={sourcesUrl(projectId)} className={cn("shrink-0 rounded-sm px-1 hover:bg-generic", segments.length ? "text-muted-foreground" : "font-semibold")}>
        {searching ? "Search results" : "Data"}
      </Link>
      {loading && <Skeleton className="h-3 w-40" />}
      {!searching &&
        segments.map((s, i) => {
          const last = i === segments.length - 1;
          return (
            <span key={s.id} className="flex min-w-0 items-center gap-1">
              <ChevronRightIcon className="size-3 shrink-0 text-hint" aria-hidden />
              {last ? (
                <span className="truncate font-semibold" data-testid="path-current">{s.name}</span>
              ) : (
                <Link to={sourcesUrl(projectId, s.id)} className="truncate rounded-sm px-1 text-muted-foreground hover:bg-generic hover:text-foreground">
                  {s.name}
                </Link>
              )}
              {last && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost-secondary" size="icon-sm" aria-label="Folder actions" data-testid="path-more">
                      <MoreIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={onCopy}>Copy path</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </span>
          );
        })}
    </nav>
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

/** A source as a folder row (the listing of "all sources"). */
function rootRow(s: SourceSummary): SourceNode {
  return {
    id: s.rootNodeId!,
    sourceId: s.id,
    parentId: null,
    name: s.title,
    kind: "folder",
    detectedKind: "folder",
    size: null,
    sha256: null,
    childCount: 0,
    descendantCount: s.fileCount,
    facts: {},
    flags: {},
    status: "ready",
    importSessionId: null,
    createdAt: s.createdAt,
  };
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
