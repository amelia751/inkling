import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, CopyIcon, DocumentIcon, DoneIcon, ExportIcon, FileIcon, FolderIcon, InfoIcon, ReviewIcon, SearchIcon, TagIcon, TodoIcon, AiIcon, UndoIcon } from "@studio/ui/icons";
import type { IconComponent } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import type { AgentCard } from "@studio/agent-protocol";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { labelNames } from "@studio/contracts/environment";
import { useViewport } from "@/studio/lib/use-media-query";
import { cn } from "@studio/ui/utils";
import type { CardState } from "@/studio/stores/agent";
import { isEditable, useStudio } from "@/studio/stores/studio";
import type { Project, StudioItem } from "@studio/contracts/types";
import { filesUrl, targetUrl } from "@/studio/lib/routes";
import { useShell } from "@/studio/stores/shell";
import { fetchNode, projectKeys } from "@/studio/lib/projects-api";
import { planNodeIds, planSnapshot, planSummary, planToDiffOps, planToFsOps, reorgError, undoReorgBatch, type DiffNodeInfo } from "@/studio/lib/agent/reorg";
import { useFsOps } from "@/studio/lib/files/api";
import { useTabUndo } from "@/studio/lib/files/undo";
import { ReorgDiff } from "@/studio/components/files/reorg-diff";
import { useReorgPlans } from "@/studio/stores/reorg-plans";
import { Markdown } from "./markdown";

/** What Studio-only cards act on: the open dataset and its items. */
export interface StudioCardContext {
  project: Project;
  items: StudioItem[];
}

interface CardProps {
  card: AgentCard;
  state: CardState;
  setState: (s: CardState) => void;
  projectId: string;
  studio?: StudioCardContext;
}

type StudioProps = CardProps & StudioCardContext;

/** Cards that act on the open Studio (items, tools, annotations). */
const STUDIO_ONLY = new Set<AgentCard["kind"]>(["items", "label-schema", "tool-switch", "review-suggestions", "select-annotations"]);

/** Interactive result of an agent tool. Nothing here changes annotations until the expert clicks. */
export function AgentCardView({ studio, ...rest }: CardProps) {
  const { card } = rest;
  if (card.kind === "location") return <LocationCard {...rest} card={card} />;
  if (card.kind === "document") return <DocumentCard {...rest} card={card} />;
  if (card.kind === "reorg-plan") return <ReorgPlanCard {...rest} card={card} />;
  if (STUDIO_ONLY.has(card.kind) && !studio)
    return (
      <Shell icon={InfoIcon} title="Open the Studio to use this">
        <p className="px-3 pb-3 text-muted-foreground">This suggestion acts on items and annotations in the Studio.</p>
      </Shell>
    );
  const props = { ...rest, ...studio! } as StudioProps;
  switch (card.kind) {
    case "items":
      return <ItemsCard {...props} card={card} />;
    case "label-schema":
      return <LabelSchemaCard {...props} card={card} />;
    case "tool-switch":
      return <ToolSwitchCard {...props} card={card} />;
    case "review-suggestions":
      return <ReviewCard {...props} card={card} />;
    case "select-annotations":
      return <SelectCard {...props} card={card} />;
  }
}

function Shell({ icon: Icon, title, meta, children, footer, tone }: { icon: IconComponent; title: ReactNode; meta?: ReactNode; children?: ReactNode; footer?: ReactNode; tone?: "ai" }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background">
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <Icon className={cn("size-4 shrink-0", tone === "ai" ? "text-ai-text" : "text-hint")} />
        <h4 className="min-w-0 flex-1 truncate font-semibold">{title}</h4>
        {meta && <span className="max-w-[40%] min-w-0 shrink-0 truncate text-hint">{meta}</span>}
      </header>
      {children}
      {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-2">{footer}</footer>}
    </section>
  );
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: (text: string) => {
      void navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    },
  };
}

const PREVIEW_ROWS = 6;

/** Off desktop the panel covers the canvas, so revealing something in the viewer closes it. */
function useReveal() {
  const viewport = useViewport();
  return () => {
    if (viewport !== "desktop" && useStudio.getState().aiOpen) useStudio.getState().toggleAi();
  };
}

function ItemsCard({ card, items }: StudioProps & { card: Extract<AgentCard, { kind: "items" }> }) {
  const [all, setAll] = useState(false);
  const reveal = useReveal();
  const itemIndex = useStudio((s) => s.itemIndex);
  const annotations = useStudio((s) => s.annotations);
  const annotated = useMemo(() => new Set(annotations.map((a) => a.itemId)), [annotations]);
  const rows = card.itemIds.map((id) => ({ id, index: items.findIndex((i) => i.id === id) })).filter((r) => r.index >= 0);
  const shown = all ? rows : rows.slice(0, PREVIEW_ROWS);
  return (
    <Shell icon={SearchIcon} title={card.title} meta={rows.length}>
      <ul className="max-h-72 overflow-y-auto px-1 pb-1">
        {shown.map(({ id, index }) => {
          const item = items[index];
          const done = annotated.has(id);
          return (
            <li key={id}>
              <button
                onClick={() => {
                  useStudio.getState().setItemIndex(index);
                  reveal();
                }}
                className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-generic", index === itemIndex && "bg-selection hover:bg-selection-hover")}
              >
                {done ? <DoneIcon className="size-3.5 shrink-0 text-positive" /> : <TodoIcon className="size-3.5 shrink-0 text-hint" />}
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="shrink-0 text-hint">{item.group}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length > PREVIEW_ROWS && (
        <footer className="border-t border-border px-1 py-1">
          <Button variant="ghost-secondary" size="sm" className="w-full" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${rows.length}`}
          </Button>
        </footer>
      )}
    </Shell>
  );
}

function LabelSchemaCard({ card, project }: StudioProps & { card: Extract<AgentCard, { kind: "label-schema" }> }) {
  const { copied, copy } = useCopy();
  const current = labelNames(project.labels);
  const names = card.labels.map((l) => l.name);
  return (
    <Shell
      icon={TagIcon}
      title={card.title}
      meta={card.labels.length}
      footer={
        <Button variant="outline" size="sm" onClick={() => copy(JSON.stringify(card.labels, null, 2))}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy as JSON"}
        </Button>
      }
    >
      <ul className="space-y-2.5 px-3 pb-3">
        {card.labels.map((l) => (
          <li key={l.name} className="flex gap-2.5">
            <span className="mt-[5px] size-2.5 shrink-0 rounded-full" style={{ background: l.color ?? labelColor(names, l.name) }} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold">{l.name}</span>
                {current.length > 0 && <Badge theme={current.includes(l.name) ? "normal" : "info"}>{current.includes(l.name) ? "Existing" : "New"}</Badge>}
              </div>
              <p className="text-muted-foreground">{l.description}</p>
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  );
}

function DocumentCard({ card }: CardProps & { card: Extract<AgentCard, { kind: "document" }> }) {
  const { copied, copy } = useCopy();
  const [open, setOpen] = useState(false);
  const download = () => {
    const url = URL.createObjectURL(new Blob([card.markdown], { type: "text/markdown" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: card.filename.endsWith(".md") ? card.filename : `${card.filename}.md` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Shell
      icon={DocumentIcon}
      title={card.title}
      meta={card.filename}
      footer={
        <>
          <Button variant="ghost-secondary" size="sm" className="mr-auto" onClick={() => setOpen(!open)}>
            {open ? "Collapse" : "Expand"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => copy(card.markdown)}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="outline" size="sm" onClick={download}>
            <ExportIcon />
            Download
          </Button>
        </>
      }
    >
      <div className={cn("relative px-3 pb-3", !open && "max-h-56 overflow-hidden")}>
        <Markdown text={card.markdown} />
        {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background" />}
      </div>
    </Shell>
  );
}

function ToolSwitchCard({ card, state, setState }: StudioProps & { card: Extract<AgentCard, { kind: "tool-switch" }> }) {
  const meta = useStudio((s) => s.env?.tools.find((t) => t.name === card.tool));
  const active = useStudio((s) => s.tool === card.tool && (!card.label || s.activeLabel === card.label));
  const use = () => {
    const s = useStudio.getState();
    s.setTool(card.tool);
    if (card.label) s.setActiveLabel(card.label);
    setState("applied");
  };
  return (
    <Shell
      icon={meta?.icon ?? AiIcon}
      title={<>{meta?.label ?? card.tool}{card.label && <span className="font-normal text-muted-foreground"> · {card.label}</span>}</>}
      footer={
        active ? (
          <span className="flex h-6 items-center gap-1 text-positive"><CheckIcon className="size-3.5" />Active</span>
        ) : (
          <Button size="sm" onClick={use}>{state === "applied" ? "Use again" : "Use this tool"}</Button>
        )
      }
    >
      <p className="px-3 pb-3 text-muted-foreground">{card.reason}</p>
    </Shell>
  );
}

function ReviewCard({ card, state, setState }: StudioProps & { card: Extract<AgentCard, { kind: "review-suggestions" }> }) {
  const annotations = useStudio((s) => s.annotations);
  const lockedLabels = useStudio((s) => s.lockedLabels);
  const pending = annotations.filter((a) => card.annotationIds.includes(a.id) && a.provenance === "ai-suggested");
  const accept = card.action === "accept";
  const apply = () => {
    const s = useStudio.getState();
    const ids = pending.filter((a) => isEditable(a, lockedLabels)).map((a) => a.id);
    if (accept) s.batch({ update: ids.map((id) => ({ id, patch: { provenance: "human-created" as const } })) });
    else s.removeMany(ids);
    setState("applied");
  };
  const counts = new Map<string, number>();
  pending.forEach((a) => counts.set(a.label, (counts.get(a.label) ?? 0) + 1));
  return (
    <Shell
      icon={ReviewIcon}
      tone="ai"
      title={`${accept ? "Accept" : "Reject"} ${card.annotationIds.length} AI suggestion${card.annotationIds.length === 1 ? "" : "s"}`}
      footer={
        state === "applied" ? (
          <span className="flex h-6 items-center gap-1 text-muted-foreground"><CheckIcon className="size-3.5" />{accept ? "Accepted" : "Rejected"} · undo with ⌘Z</span>
        ) : state === "dismissed" ? (
          <span className="h-6 leading-6 text-hint">Dismissed</span>
        ) : pending.length === 0 ? (
          <span className="h-6 leading-6 text-hint">Already reviewed</span>
        ) : (
          <>
            <Button variant="ghost-secondary" size="sm" onClick={() => setState("dismissed")}>Dismiss</Button>
            <Button size="sm" variant={accept ? "default" : "destructive"} onClick={apply}>{accept ? "Accept" : "Reject"} {pending.length}</Button>
          </>
        )
      }
    >
      <div className="space-y-2 px-3 pb-3">
        <p className="text-muted-foreground">{card.reason}</p>
        <div className="flex flex-wrap gap-1">
          {[...counts].map(([label, n]) => <Badge key={label} theme="ai">{label} × {n}</Badge>)}
        </div>
      </div>
    </Shell>
  );
}

function SelectCard({ card, items, state, setState }: StudioProps & { card: Extract<AgentCard, { kind: "select-annotations" }> }) {
  const annotations = useStudio((s) => s.annotations);
  const reveal = useReveal();
  const found = annotations.filter((a) => card.annotationIds.includes(a.id));
  const show = () => {
    const s = useStudio.getState();
    const first = found[0];
    if (!first) return;
    const index = items.findIndex((i) => i.id === first.itemId);
    if (index >= 0 && index !== s.itemIndex) s.setItemIndex(index);
    s.selectMany(found.filter((a) => a.itemId === first.itemId).map((a) => a.id));
    setState("applied");
    reveal();
  };
  const itemCount = new Set(found.map((a) => a.itemId)).size;
  return (
    <Shell
      icon={SearchIcon}
      title={`${found.length} annotation${found.length === 1 ? "" : "s"}`}
      meta={itemCount > 1 ? `${itemCount} items` : undefined}
      footer={found.length ? <Button variant="outline" size="sm" onClick={show}>{state === "applied" ? "Show again" : "Show in viewer"}</Button> : <span className="h-6 leading-6 text-hint">No longer exist</span>}
    >
      <p className="px-3 pb-3 text-muted-foreground">{card.reason}</p>
    </Shell>
  );
}

/**
 * open_location: the agent points, the person goes. A button that opens a project place
 * (by node, proposal or task id, never a path); the agent never navigates by itself.
 */
function LocationCard({ card, setState, projectId }: CardProps & { card: Extract<AgentCard, { kind: "location" }> }) {
  const navigate = useNavigate();
  const go = () => {
    setState("applied");
    // Off desktop the drawer covers the page; close it so the place is visible.
    if (window.innerWidth < 1024) useShell.getState().setAssistant(false);
    navigate(targetUrl(projectId, card.target));
  };
  const label = /^open\b/i.test(card.label) ? card.label : `Open ${card.label}`;
  return (
    <div className="flex flex-col gap-1 self-start" data-testid="agent-location">
      {card.reason && <p className="text-muted-foreground">{card.reason}</p>}
      <Button variant="outline" size="sm" className="self-start" onClick={go}>
        {label}
        <ArrowRightIcon />
      </Button>
    </div>
  );
}

const MAX_LOOKUPS = 60;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * propose_reorganization (todo7 Phase 8): the assistant proposes, the person applies. Apply sends
 * one `fs/ops` batch as the person (the agent's token can't write the namespace), so Undo here
 * or ⌘Z in Files reverts the whole plan. Edit opens it in Files (`?plan=<id>`; the plan waits in
 * the per-tab plan store, never in the URL) with a checkbox per op.
 */
function ReorgPlanCard({ card, state, setState, projectId }: CardProps & { card: Extract<AgentCard, { kind: "reorg-plan" }> }) {
  const { plan } = card;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const batchId = useReorgPlans((s) => s.batches[plan.id]);
  const [busy, setBusy] = useState<"apply" | "undo" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = useMemo(() => planNodeIds(plan).slice(0, MAX_LOOKUPS), [plan]);
  // Current names, for the person only (the assistant never got these from the card).
  const lookups = useQueries({ queries: ids.map((id) => ({ queryKey: projectKeys.node(id), queryFn: () => fetchNode(id), staleTime: 30_000, retry: false })) });
  const names = useMemo(() => new Map(ids.map((id, i) => [id, lookups[i]?.data?.name] as const)), [ids, lookups]);
  const refresh = () =>
    qc.invalidateQueries({ predicate: (q) => ["sources", "source-nodes", "files", "fs"].includes(String(q.queryKey[0])) || (q.queryKey[0] === "projects" && q.queryKey[1] === projectId) });
  const fsOps = useFsOps(projectId);
  // The before / after tree, once the touched nodes' current names are known.
  const settled = lookups.every((l) => !l.isLoading);
  const snapshot = useMemo(
    () => planSnapshot(lookups.flatMap((l): DiffNodeInfo[] => (l.data ? [{ id: l.data.id, name: l.data.name, kind: l.data.kind, parentId: l.data.parentId }] : []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when the lookups settle
    [settled, ids],
  );
  const diffOps = useMemo(() => planToDiffOps(plan), [plan]);
  const apply = async () => {
    setBusy("apply");
    setError(null);
    try {
      // One fs/ops batch through the Files API (optimistic rows, this tab's undo label).
      const r = await fsOps.mutateAsync(planToFsOps(plan)).catch((e: unknown) => Promise.reject(reorgError(e)));
      useReorgPlans.getState().setBatch(plan.id, r.batchId);
      setState("applied");
      void refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const undo = async () => {
    if (!batchId) return;
    setBusy("undo");
    setError(null);
    try {
      const r = await undoReorgBatch(projectId, batchId);
      useTabUndo.getState().markUndone(r.undoneBatchId);
      useReorgPlans.getState().setBatch(plan.id, null);
      setState("undone");
      void refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const edit = () => {
    useReorgPlans.getState().put(projectId, plan);
    if (window.innerWidth < 1024) useShell.getState().setAssistant(false);
    navigate(filesUrl(projectId, null, { plan: plan.id }));
  };
  const newName = new Map(plan.ops.flatMap((o) => (o.kind === "mkdir" ? [[o.ref, o.name] as const] : [])));
  const where = (parentId: string) => newName.get(parentId) ?? names.get(parentId) ?? "a folder";
  const footer =
    state === "applied" ? (
      <>
        <span className="mr-auto flex h-6 items-center gap-1 text-muted-foreground"><CheckIcon className="size-3.5" />Applied{batchId ? "" : " · undo with ⌘Z in Data"}</span>
        {batchId && (
          <Button variant="outline" size="sm" onClick={undo} disabled={busy !== null} data-testid="agent-reorg-undo">
            <UndoIcon />
            Undo
          </Button>
        )}
      </>
    ) : state === "undone" ? (
      <span className="h-6 leading-6 text-hint">Undone</span>
    ) : state === "dismissed" ? (
      <span className="h-6 leading-6 text-hint">Dismissed</span>
    ) : (
      <>
        <Button variant="ghost-secondary" size="sm" className="mr-auto" onClick={() => setState("dismissed")}>Dismiss</Button>
        <Button variant="outline" size="sm" onClick={edit} data-testid="agent-reorg-edit">Edit</Button>
        <Button size="sm" onClick={apply} disabled={busy !== null} data-testid="agent-reorg-apply">{busy === "apply" ? "Applying…" : "Apply"}</Button>
      </>
    );
  return (
    <div data-testid="agent-reorg" data-plan-id={plan.id} data-state={state}>
      <Shell icon={FolderIcon} tone="ai" title={plan.title} meta={planSummary(plan)} footer={footer}>
        {settled && snapshot.children?.length ? (
          <div className="px-3 pb-2">
            <ReorgDiff tree={snapshot} ops={diffOps} actions={false} steps={false} />
          </div>
        ) : null}
        <ul className="max-h-72 space-y-1.5 overflow-y-auto px-3 pb-3" data-testid="agent-reorg-diff">
          {plan.ops.map((o, i) => (
            <li key={i} className="flex gap-2" data-testid="agent-reorg-op" data-kind={o.kind}>
              {o.kind === "rename" ? <FileIcon className="mt-0.5 size-3.5 shrink-0 text-hint" /> : <FolderIcon className={cn("mt-0.5 size-3.5 shrink-0", o.kind === "mkdir" ? "text-ai-text" : "text-hint")} />}
              <div className="min-w-0">
                <div className="min-w-0 break-words">
                  {o.kind === "mkdir" && (
                    <>
                      <Badge theme="ai">New</Badge> <span className="font-semibold">{o.name}</span> <span className="text-hint">in {where(o.parentId)}</span>
                    </>
                  )}
                  {o.kind === "move" && (
                    <span className="rounded-sm border border-dashed border-border px-1">
                      {o.nodeIds.length <= 3 ? o.nodeIds.map((id) => names.get(id) ?? "…").join(", ") : `${o.nodeIds.length} items`} → <span className="font-semibold">{where(o.parentId)}</span>
                    </span>
                  )}
                  {o.kind === "rename" && (
                    <>
                      {names.get(o.nodeId) ?? "…"} → <span className="font-semibold">{o.name}</span>
                    </>
                  )}
                </div>
                {o.reason && <p className="text-muted-foreground">{o.reason}</p>}
              </div>
            </li>
          ))}
        </ul>
        {error && <p className="px-3 pb-3 text-danger" role="alert" data-testid="agent-reorg-error">{error}</p>}
      </Shell>
    </div>
  );
}
