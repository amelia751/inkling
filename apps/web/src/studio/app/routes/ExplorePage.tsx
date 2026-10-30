import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AiIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  DatasetsIcon,
  DocumentIcon,
  DoneIcon,
  ErrorIcon,
  ImportedIcon,
  NoRelationshipIcon,
  PrivacyIcon,
  RelationshipIcon,
  SearchIcon,
  TableFileIcon,
  TagIcon,
  UnknownFileIcon,
  VolumeIcon,
  WarningIcon,
  type IconComponent,
} from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@studio/ui/ui/popover";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@studio/ui/ui/tabs";
import {
  confirmProposal,
  dismissProposal,
  exploreKeys,
  fetchExplore,
  fetchNode,
  fetchProposalPreview,
  fetchProposals,
  NeedsApiError,
  recomputeProposal,
  searchNodes,
} from "@/studio/lib/projects-api";
import { kindIcon } from "@/studio/lib/file-kinds";
import { exploreUrl, sourcesUrl, studioUrl, targetUrl } from "@/studio/lib/routes";
import type { ExploreRecord, ExploreSummary, ExploreTaskRow, Proposal, ProposalStrength, QualityItem, RelationshipEvidence, RelationshipTargetRef } from "@studio/contracts/types";
import { NAMING } from "@studio/contracts/naming";
import { cn } from "@studio/ui/utils";

/**
 * Explore (todo6 Phase 5.2, docs/ux.md §7): what the files are, how they relate, how a table
 * becomes labels, and what's wrong. Detected facts are solid; proposals are dashed with their
 * evidence one click away; confirmed items get a check. Nothing proposed changes data until a
 * person confirms it, and strength is a word, never a percentage. The URL holds the tab and the
 * selected proposal (`/explore/:tab?proposal=`), never file names.
 */
const TABS = ["summary", "relationships", "mappings", "quality"] as const;
type Tab = (typeof TABS)[number];

const STRENGTH_WORDS: Record<ProposalStrength, string> = { strong: "Strong match", possible: "Possible match", weak: "Weak match" };

export function ExplorePage() {
  const { projectId = "", tab: rawTab } = useParams();
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as Tab) : "summary";
  const [params] = useSearchParams();
  const selected = params.get("proposal");
  const navigate = useNavigate();
  const summary = useQuery({ queryKey: exploreKeys.summary(projectId), queryFn: () => fetchExplore(projectId), staleTime: 5_000, retry: (n, e) => !(e instanceof NeedsApiError) && n < 2 });
  const proposals = useQuery({ queryKey: exploreKeys.proposals(projectId), queryFn: () => fetchProposals(projectId), staleTime: 5_000, retry: (n, e) => !(e instanceof NeedsApiError) && n < 2 });
  const all = proposals.data ?? [];
  const select = (t: Tab, id?: string | null) => navigate(exploreUrl(projectId, t, id ?? undefined), { replace: true });
  const openRel = all.filter((p) => p.kind === "relationship" && p.status === "proposed").length;
  const openMap = all.filter((p) => p.kind === "mapping" && p.status === "proposed").length;
  const previewing = all.find((p) => p.id === selected && (p.kind === "dataset" || p.kind === "task") && p.status === "proposed");
  const error = summary.error ?? proposals.error;

  return (
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6" data-testid="explore">
        <PageHeading title="Explore" description={`What ${NAMING.displayName} found in your files and how they fit together. Nothing here changes your data until you confirm it.`} />
        {error ? (
          <p className="text-sm text-muted-foreground" role="alert">
            {error instanceof NeedsApiError ? "Explore needs the full stack (the API and the worker): see docs/running.md." : `Couldn't load Explore: ${String(error)}`}
          </p>
        ) : (
          <Tabs value={tab} onValueChange={(t) => select(t as Tab)}>
            <TabsList className="mb-6" data-testid="explore-tabs">
              <TabsTrigger value="summary" data-testid="explore-tab-summary">Summary</TabsTrigger>
              <TabsTrigger value="relationships" data-testid="explore-tab-relationships">
                Relationships {openRel > 0 && <span data-counter className="tnum">{openRel}</span>}
              </TabsTrigger>
              <TabsTrigger value="mappings" data-testid="explore-tab-mappings">
                Mappings {openMap > 0 && <span data-counter className="tnum">{openMap}</span>}
              </TabsTrigger>
              <TabsTrigger value="quality" data-testid="explore-tab-quality">
                Quality {summary.data && summary.data.quality.length > 0 && <span data-counter className="tnum">{summary.data.quality.length}</span>}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="summary">
              {summary.data && proposals.data ? <ShapeSummary projectId={projectId} s={summary.data} proposals={all} onPreview={(id) => select("summary", id)} /> : <ExploreSkeleton />}
            </TabsContent>
            <TabsContent value="relationships">
              {proposals.data ? <ProposalList kind="relationship" projectId={projectId} proposals={all} selected={selected} onSelect={(id) => select("relationships", id)} /> : <ExploreSkeleton />}
            </TabsContent>
            <TabsContent value="mappings">
              {proposals.data ? <ProposalList kind="mapping" projectId={projectId} proposals={all} selected={selected} onSelect={(id) => select("mappings", id)} /> : <ExploreSkeleton />}
            </TabsContent>
            <TabsContent value="quality">{summary.data ? <QualityList projectId={projectId} items={summary.data.quality} /> : <ExploreSkeleton />}</TabsContent>
          </Tabs>
        )}
      </div>
      {previewing && <ActionPreview projectId={projectId} proposal={previewing} onClose={() => select(tab)} />}
    </AppLayout>
  );
}

function ExploreSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-3" aria-busy>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-48 rounded-lg" />
      ))}
    </div>
  );
}

// ---- Shared bits: proposal frames, strength words, decisions ----------------------------------

/** Proposed: dashed on a tint (assistant-made ones add the AI sparkle). Confirmed: solid with a check. */
function ProposalFrame({ p, selected, children, className, testid }: { p: Proposal; selected?: boolean; children: React.ReactNode; className?: string; testid?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={ref}
      className={cn(
        "rounded-lg border p-4",
        p.status === "proposed" ? "border-dashed border-border-hover bg-utility-tint" : "border-border bg-card",
        p.status === "dismissed" && "opacity-70",
        selected && "ring-2 ring-[var(--g-line-focus)]",
        className,
      )}
      data-testid={testid}
      data-proposal={p.id}
      data-status={p.status}
      aria-current={selected || undefined}
    >
      {children}
    </div>
  );
}

function Strength({ strength }: { strength: ProposalStrength }) {
  return <span className="text-sm text-muted-foreground" data-testid="strength">{STRENGTH_WORDS[strength]}</span>;
}

function Origin({ p }: { p: Proposal }) {
  if (p.status === "confirmed")
    return (
      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground" data-testid="confirmed">
        <DoneIcon className="size-4 text-positive" /> Confirmed{p.decidedBy?.startsWith("user:") ? " by you" : ""}
        {p.decidedAt && ` · ${new Date(p.decidedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
      </span>
    );
  if (p.status === "dismissed") return <span className="inline-flex items-center gap-1 text-sm text-hint"><NoRelationshipIcon className="size-4" /> Dismissed</span>;
  if (p.createdBy.startsWith("agent:")) return <span className="inline-flex items-center gap-1 text-sm text-ai-text"><AiIcon className="size-3.5" /> Suggested by the assistant</span>;
  return null;
}

function useDecide(projectId: string) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["projects", projectId] });
  const run = (fn: () => Promise<unknown>) => {
    setError(null);
    return fn().then(refresh, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return { error, run, refresh };
}

function DecisionButtons({ p, onEdit, editing, decide }: { p: Proposal; onEdit?: () => void; editing?: boolean; decide: ReturnType<typeof useDecide> }) {
  const [busy, setBusy] = useState<null | "confirm" | "dismiss">(null);
  if (p.status !== "proposed") return null;
  const go = (what: "confirm" | "dismiss") => {
    setBusy(what);
    void decide.run(() => (what === "confirm" ? confirmProposal(p.id) : dismissProposal(p.id))).finally(() => setBusy(null));
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" loading={busy === "confirm"} onClick={() => go("confirm")} data-testid="proposal-confirm">
        Confirm{p.kind === "relationship" ? " match" : ""}
      </Button>
      {onEdit && (
        <Button size="sm" variant="outline" onClick={onEdit} selected={editing} data-testid="proposal-edit">
          Edit
        </Button>
      )}
      <Button size="sm" variant="ghost-secondary" loading={busy === "dismiss"} onClick={() => go("dismiss")} data-testid="proposal-dismiss">
        Dismiss
      </Button>
    </div>
  );
}

// ---- Summary -----------------------------------------------------------------------------------

const RECORD_ICON: Record<ExploreRecord["type"], IconComponent> = { series: VolumeIcon, table: TableFileIcon, documents: DocumentIcon, files: DatasetsIcon };

function ShapeSummary({ projectId, s, proposals, onPreview }: { projectId: string; s: ExploreSummary; proposals: Proposal[]; onPreview: (id: string) => void }) {
  const decide = useDecide(projectId);
  const byId = useMemo(() => new Map(proposals.map((p) => [p.id, p])), [proposals]);
  if (s.files.total === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="explore-empty">
        No files yet. <Link className="underline" to={sourcesUrl(projectId)}>Add data in Sources</Link>, and what we find shows up here.
      </p>
    );
  return (
    <div className="flex flex-col gap-6" data-testid="shape-summary">
      {s.clean && s.readyProposalId && (
        <Card className="flex flex-wrap items-center gap-4 border-dashed border-border-hover bg-utility-tint p-5" data-testid="ready-card">
          <DatasetsIcon className="size-5 text-hint" />
          <p className="min-w-0 flex-1 text-body-2">
            Ready to annotate. {String(byId.get(s.readyProposalId)?.payload.summary ?? "")}
          </p>
          <Button size="lg" onClick={() => onPreview(s.readyProposalId!)} data-testid="ready-create">
            Create dataset & open Studio
          </Button>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        <Column title="Files" hint="What you have">
          <ul className="flex flex-col gap-1.5 text-sm" data-testid="summary-files">
            {s.files.byKind.map((k) => {
              const Icon = kindIcon(k.kind);
              return (
                <li key={k.kind} className="flex items-center gap-2">
                  <Icon className="size-4 shrink-0 text-hint" />
                  <span className="min-w-0 flex-1 truncate">{k.label}</span>
                  <span className="tnum text-muted-foreground">{k.count.toLocaleString()}</span>
                </li>
              );
            })}
          </ul>
          {s.files.facts.length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <p className="mb-1.5 text-xs text-hint">Detected</p>
              <ul className="flex flex-col gap-1 text-sm">
                {s.files.facts.map((f) => (
                  <li key={f} className="truncate" title={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </Column>
        <Column title="Records" hint="How it's organized">
          <ul className="flex flex-col gap-2" data-testid="summary-records">
            {s.records.map((r) => {
              const Icon = RECORD_ICON[r.type];
              const p = r.proposalId ? byId.get(r.proposalId) : undefined;
              const body = (
                <div className="flex items-start gap-2">
                  <Icon className="mt-0.5 size-4 shrink-0 text-hint" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.title}</p>
                    {r.detail && <p className="text-sm text-muted-foreground">{r.detail}</p>}
                  </div>
                </div>
              );
              if (p)
                return (
                  <li key={r.id}>
                    <ProposalFrame p={p} className="p-3" testid="record-proposal">
                      {body}
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        {p.status === "proposed" ? <Strength strength={p.strength} /> : <Origin p={p} />}
                        <DecisionButtons p={p} decide={decide} />
                      </div>
                    </ProposalFrame>
                  </li>
                );
              return (
                <li key={r.id}>
                  {r.nodeId ? (
                    <Link to={sourcesUrl(projectId, r.nodeId)} className="block rounded-md p-1 hover:bg-generic" data-testid="record">{body}</Link>
                  ) : (
                    <div className="p-1" data-testid="record">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Column>
        <Column title="Tasks" hint="What you'll annotate">
          {s.tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No task yet. Confirm how your files fit together first.</p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="summary-tasks">
              {s.tasks.map((t) => (
                <TaskRowView key={t.id} projectId={projectId} t={t} p={t.proposalId ? byId.get(t.proposalId) : undefined} onPreview={onPreview} />
              ))}
            </ul>
          )}
        </Column>
      </div>
      {decide.error && <p className="text-sm text-danger" role="alert">{decide.error}</p>}
    </div>
  );
}

function Column({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <h2 className="text-body-2 font-semibold">{title}</h2>
      <p className="mb-3 text-xs text-hint">{hint}</p>
      {children}
    </Card>
  );
}

function TaskRowView({ projectId, t, p, onPreview }: { projectId: string; t: ExploreTaskRow; p?: Proposal; onPreview: (id: string) => void }) {
  if (t.status === "confirmed")
    return (
      <li className="flex items-start gap-2 rounded-md border border-border p-3" data-testid="task-row">
        <DoneIcon className="mt-0.5 size-4 shrink-0 text-positive" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{t.title}</p>
          {t.detail && <p className="text-sm text-muted-foreground">{t.detail}</p>}
        </div>
        {t.taskId && (
          <Button size="sm" variant="outline" asChild>
            <Link to={studioUrl(projectId, t.taskId)}>Open Studio</Link>
          </Button>
        )}
      </li>
    );
  if (!p) return null;
  return (
    <li>
      <ProposalFrame p={p} className="p-3" testid="dataset-proposal">
        <p className="truncate text-sm font-medium">{t.title}</p>
        {t.detail && <p className="text-sm text-muted-foreground">{t.detail}</p>}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <Origin p={p} />
          <Button size="sm" onClick={() => onPreview(p.id)} data-testid="dataset-review">
            Review & create <ChevronRightIcon />
          </Button>
        </div>
      </ProposalFrame>
    </li>
  );
}

// ---- Relationships and mappings ------------------------------------------------------------------

function ProposalList({ kind, projectId, proposals, selected, onSelect }: { kind: "relationship" | "mapping"; projectId: string; proposals: Proposal[]; selected: string | null; onSelect: (id: string | null) => void }) {
  const [showDismissed, setShowDismissed] = useState(false);
  const mine = proposals.filter((p) => p.kind === kind);
  const shown = mine.filter((p) => showDismissed || p.status !== "dismissed" || p.id === selected);
  const dismissed = mine.length - mine.filter((p) => p.status !== "dismissed").length;
  return (
    <div className="flex flex-col gap-3" data-testid={`${kind}-list`}>
      {shown.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {kind === "relationship" ? "No links between your tables and files yet. They appear here when a table column matches folder or file names." : "No label mappings yet. A table column with a few repeated values (like a diagnosis) becomes one."}
        </p>
      )}
      {shown.map((p) =>
        kind === "relationship" ? (
          <RelationshipRow key={p.id} projectId={projectId} p={p} selected={p.id === selected} onSelect={() => onSelect(p.id)} />
        ) : (
          <MappingRow key={p.id} projectId={projectId} p={p} selected={p.id === selected} onSelect={() => onSelect(p.id)} />
        ),
      )}
      {dismissed > 0 && (
        <label className="flex items-center gap-2 self-start text-sm text-muted-foreground">
          <Checkbox checked={showDismissed} onCheckedChange={(v) => setShowDismissed(v === true)} /> Show dismissed ({dismissed})
        </label>
      )}
    </div>
  );
}

const TARGET_WORDS = { files: "file names", folders: "folder names" } as const;
const RULE_WORDS = { exact: "Exactly as written", normalized: "Ignore case, spaces and dashes", numeric: "Ignore leading zeros and short prefixes (P001 = 1)" } as const;

function RelationshipRow({ projectId, p, selected, onSelect }: { projectId: string; p: Proposal; selected: boolean; onSelect: () => void }) {
  const ev = p.evidence as unknown as RelationshipEvidence;
  const payload = p.payload as { table?: string; tableNodeId?: string; column?: string; target?: "files" | "folders"; rule?: string; resolutions?: Record<string, string> };
  const [why, setWhy] = useState(false);
  const [editing, setEditing] = useState(false);
  const decide = useDecide(projectId);
  const recompute = (body: Record<string, unknown>) => decide.run(() => recomputeProposal(p.id, body));
  const open = (ev.unmatched ?? 0) + (ev.ambiguous ?? 0);
  return (
    <ProposalFrame p={p} selected={selected} testid="relationship-row">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2" onClick={onSelect}>
        <RelationshipIcon className="mt-0.5 size-4 shrink-0 text-hint" />
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <code className="font-medium">{payload.table}</code> › <code>{payload.column}</code> ↔ {payload.target === "folders" ? "folder names" : "file names"}
          </p>
          <p className="tnum mt-0.5 text-sm text-muted-foreground" data-testid="relationship-counts">
            {ev.matched} matched · {ev.unmatched} not found · {ev.ambiguous} ambiguous
            {(ev.resolved > 0 || ev.skipped > 0) && ` · ${[ev.resolved && `${ev.resolved} picked`, ev.skipped && `${ev.skipped} skipped`].filter(Boolean).join(", ")} by you`}
          </p>
        </div>
        {p.status === "proposed" ? <Strength strength={p.strength} /> : <Origin p={p} />}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="link" className="px-0" onClick={() => setWhy((v) => !v)} aria-expanded={why} data-testid="relationship-why">
          Why?
        </Button>
        <span className="flex-1" />
        <DecisionButtons p={p} decide={decide} editing={editing} onEdit={() => setEditing((v) => !v)} />
      </div>
      {why && (
        <div className="mt-2 rounded-md bg-background p-3 text-sm" data-testid="relationship-evidence">
          <ul className="list-disc pl-5">
            {ev.why?.map((w) => <li key={w}>{w}</li>)}
          </ul>
          {ev.examples?.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
              {ev.examples.map((x) => (
                <li key={x.row}>Row {x.row + 1}: “{x.value}” ↔ {x.target.path || x.target.name}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {editing && p.status === "proposed" && payload.tableNodeId && (
        <RelationshipEditor tableNodeId={payload.tableNodeId} column={payload.column ?? ""} target={payload.target ?? "files"} rule={payload.rule ?? "normalized"} onApply={(b) => void recompute(b).then(() => setEditing(false))} />
      )}
      {p.status === "proposed" && open > 0 && (
        <OpenRows projectId={projectId} ev={ev} onFix={(row, fix) => void recompute({ resolutions: { [String(row)]: fix } })} />
      )}
      {p.status === "proposed" && (ev.resolved > 0 || ev.skipped > 0) && (
        <Button size="xs" variant="ghost-secondary" className="mt-2" onClick={() => void recompute({ resolutions: Object.fromEntries(Object.keys(payload.resolutions ?? {}).map((k) => [k, null])) })} data-testid="relationship-reset">
          Undo my row fixes
        </Button>
      )}
      {decide.error && <p className="mt-2 text-sm text-danger" role="alert">{decide.error}</p>}
    </ProposalFrame>
  );
}

const field = "h-7 rounded-md border border-border bg-background px-2 text-sm";

function RelationshipEditor({ tableNodeId, column, target, rule, onApply }: { tableNodeId: string; column: string; target: string; rule: string; onApply: (b: Record<string, unknown>) => void }) {
  const table = useQuery({ queryKey: ["source-nodes", tableNodeId], queryFn: () => fetchNode(tableNodeId), staleTime: 60_000 });
  const columns = ((table.data?.facts.table as { columns?: { name: string }[] } | undefined)?.columns ?? []).map((c) => c.name);
  const [c, setC] = useState(column);
  const [t, setT] = useState(target);
  const [r, setR] = useState(rule);
  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-md bg-background p-3" data-testid="relationship-editor">
      <label className="flex flex-col gap-1 text-xs text-hint">
        Column
        <select className={field} value={c} onChange={(e) => setC(e.target.value)} data-testid="edit-column">
          {(columns.length ? columns : [column]).map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-hint">
        Matches
        <select className={field} value={t} onChange={(e) => setT(e.target.value)} data-testid="edit-target">
          {Object.entries(TARGET_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-hint">
        How IDs are written
        <select className={field} value={r} onChange={(e) => setR(e.target.value)} data-testid="edit-rule">
          {Object.entries(RULE_WORDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <Button size="sm" onClick={() => onApply({ column: c, target: t, rule: r })} data-testid="edit-apply">Recompute matches</Button>
    </div>
  );
}

/** Not found and ambiguous rows, each with a fix: pick the file or folder, or skip the row. */
function OpenRows({ projectId, ev, onFix }: { projectId: string; ev: RelationshipEvidence; onFix: (row: number, fix: string) => void }) {
  const rows = [
    ...ev.ambiguousRows.map((r) => ({ ...r, kind: "ambiguous" as const })),
    ...ev.unmatchedRows.map((r) => ({ ...r, candidates: [] as RelationshipTargetRef[], kind: "unmatched" as const })),
  ].sort((a, b) => a.row - b.row);
  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="open-rows">
      <p className="mb-2 flex items-center gap-1.5 text-sm">
        <WarningIcon className="size-4 text-warning" /> {rows.length} {rows.length === 1 ? "row needs" : "rows need"} matching. Nothing merges until you confirm.
      </p>
      <ul className="flex flex-col divide-y divide-border rounded-md bg-background">
        {rows.slice(0, 50).map((r) => (
          <li key={r.row} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid={`${r.kind}-row`} data-row={r.row}>
            <span className="tnum w-14 shrink-0 text-hint">Row {r.row + 1}</span>
            <code className="min-w-0 flex-1 truncate">{r.value}</code>
            <span className="text-muted-foreground">{r.kind === "ambiguous" ? `matches ${r.candidates.length}` : "not found"}</span>
            {r.kind === "ambiguous" ? (
              <select className={field} defaultValue="" onChange={(e) => e.target.value && onFix(r.row, e.target.value)} aria-label={`Pick the match for row ${r.row + 1}`} data-testid="pick-candidate">
                <option value="" disabled>Pick one…</option>
                {r.candidates.map((c) => <option key={c.nodeId} value={c.nodeId}>{c.path || c.name}</option>)}
              </select>
            ) : (
              <PickNode projectId={projectId} onPick={(id) => onFix(r.row, id)} />
            )}
            <Button size="xs" variant="ghost-secondary" onClick={() => onFix(r.row, "skip")} data-testid="skip-row">Skip row</Button>
          </li>
        ))}
      </ul>
      {rows.length > 50 && <p className="mt-1 text-xs text-hint">Showing the first 50.</p>}
    </div>
  );
}

function PickNode({ projectId, onPick }: { projectId: string; onPick: (nodeId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const found = useQuery({ queryKey: ["projects", projectId, "search", q], queryFn: () => searchNodes(projectId, q), enabled: open && q.trim().length > 0, staleTime: 10_000 });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline" data-testid="pick-node">Pick a file or folder…</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-hint" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names in this project" className="pl-7" />
        </div>
        <ul className="mt-2 max-h-60 overflow-y-auto">
          {(found.data ?? []).slice(0, 30).map((n) => {
            const Icon = kindIcon(n.kind === "folder" ? "folder" : n.detectedKind);
            return (
              <li key={n.id}>
                <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-generic" onClick={() => (setOpen(false), onPick(n.id))}>
                  <Icon className="size-4 shrink-0 text-hint" />
                  <span className="min-w-0 flex-1 truncate">{n.name}</span>
                  {n.folderPath && <span className="truncate text-xs text-hint">{n.folderPath}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function MappingRow({ projectId, p, selected, onSelect }: { projectId: string; p: Proposal; selected: boolean; onSelect: () => void }) {
  const payload = p.payload as { table?: string; column?: string; classes?: { value: string; id: string; count: number }[] };
  const ev = p.evidence as { examples?: string[]; conflicts?: { values: string[]; reason: string }[]; merged?: string[] };
  const classes = payload.classes ?? [];
  const [editing, setEditing] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const decide = useDecide(projectId);
  const conflicts = ev.conflicts ?? [];
  return (
    <ProposalFrame p={p} selected={selected} testid="mapping-row">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2" onClick={onSelect}>
        <TagIcon className="mt-0.5 size-4 shrink-0 text-hint" />
        <div className="min-w-0 flex-1">
          <p className="text-sm">
            <code className="font-medium">{payload.table}</code> › <code>{payload.column}</code> → label classes
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">e.g. {(ev.examples ?? []).map((x) => `“${x}”`).join(", ")}</p>
        </div>
        {conflicts.length > 0 && (
          <Badge theme="warning" data-testid="mapping-conflict">
            <WarningIcon /> {conflicts.length} {conflicts.length === 1 ? "conflict" : "conflicts"}
          </Badge>
        )}
        {p.status === "proposed" ? <Strength strength={p.strength} /> : <Origin p={p} />}
      </div>
      <ul className="mt-3 flex flex-wrap gap-2" data-testid="mapping-classes">
        {classes.map((c) => (
          <li key={c.value} className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-sm">
            <span className="text-muted-foreground">{c.value}</span>
            <ArrowRightIcon className="size-3 text-hint" />
            {editing ? (
              <input className="h-6 w-28 rounded-sm border border-border bg-background px-1" aria-label={`Class for ${c.value}`} defaultValue={c.id} onChange={(e) => setNames((n) => ({ ...n, [c.value]: e.target.value }))} />
            ) : (
              <span className="font-medium">{c.id}</span>
            )}
            <span className="tnum text-xs text-hint">{c.count}</span>
          </li>
        ))}
      </ul>
      {conflicts.length > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {conflicts.map((c) => `${c.values.map((v) => `“${v}”`).join(" and ")} ${c.reason}`).join("; ")}. Edit to merge them into one class.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {editing && (
          <Button size="sm" onClick={() => void decide.run(() => recomputeProposal(p.id, { classes: classes.map((c) => ({ value: c.value, id: names[c.value] ?? c.id })) })).then(() => setEditing(false))} data-testid="mapping-apply">
            Save class names
          </Button>
        )}
        <DecisionButtons p={p} decide={decide} editing={editing} onEdit={() => setEditing((v) => !v)} />
      </div>
      {decide.error && <p className="mt-2 text-sm text-danger" role="alert">{decide.error}</p>}
    </ProposalFrame>
  );
}

// ---- Quality -----------------------------------------------------------------------------------

const QUALITY_ICON: Record<QualityItem["type"], IconComponent> = { privacy: PrivacyIcon, unsupported: UnknownFileIcon, duplicate: WarningIcon, series: WarningIcon, mismatch: RelationshipIcon, missing: WarningIcon };

function QualityList({ projectId, items }: { projectId: string; items: QualityItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground" data-testid="quality-empty">No problems found in your files.</p>;
  return (
    <Card className="divide-y divide-border overflow-hidden" data-testid="quality-list">
      {items.map((q) => {
        const Icon = QUALITY_ICON[q.type] ?? ErrorIcon;
        return (
          <Link key={q.id} to={targetUrl(projectId, q.target)} className="flex items-center gap-3 px-4 py-3 hover:bg-generic" data-testid="quality-row" data-type={q.type}>
            <Icon className={cn("size-4 shrink-0", q.severity === "low" ? "text-hint" : "text-warning")} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{q.title}</p>
              {q.detail && <p className="truncate text-sm text-muted-foreground">{q.detail}</p>}
            </div>
            <ChevronRightIcon className="size-4 shrink-0 text-hint" />
          </Link>
        );
      })}
    </Card>
  );
}

// ---- Confirming a dataset proposal: the action preview -------------------------------------------

function ActionPreview({ projectId, proposal, onClose }: { projectId: string; proposal: Proposal; onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const preview = useQuery({ queryKey: [...exploreKeys.preview(proposal.id), proposal.payload], queryFn: () => fetchProposalPreview(proposal.id) });
  const pv = preview.data;
  const [title, setTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      if (title !== null && title.trim() && title.trim() !== pv?.title) await recomputeProposal(proposal.id, { title: title.trim() });
      return confirmProposal(proposal.id);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["projects", projectId] });
      if (r.task) navigate(studioUrl(projectId, r.task.id));
      else onClose();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const blocked = (pv?.blocking?.length ?? 0) > 0;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" data-testid="action-preview">
        <DialogHeader>
          <DialogTitle>Create the dataset and open the Studio</DialogTitle>
          <DialogDescription>Here is everything this will do. Your original files stay exactly as they are.</DialogDescription>
        </DialogHeader>
        {!pv ? (
          <Skeleton className="h-40 rounded-md" />
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-hint">Dataset name</span>
              <Input value={title ?? pv.title ?? ""} onChange={(e) => setTitle(e.target.value)} data-testid="preview-title" />
            </label>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2">
              <dt className="text-hint">Files</dt>
              <dd className="tnum" data-testid="preview-files">
                {pv.files?.toLocaleString()} {pv.files === 1 ? "file" : "files"}
                {pv.heldFiles ? ` (${pv.heldFiles} held for privacy review stay out until cleared)` : ""}
              </dd>
              <dt className="text-hint">Items</dt>
              <dd>{pv.grouping}</dd>
              <dt className="text-hint">Studio</dt>
              <dd>{pv.taskTitle} · {(pv.preset ?? "").replace(/^preset:/, "")}</dd>
              {(pv.labelClasses?.length ?? 0) > 0 && (
                <>
                  <dt className="text-hint">Label classes</dt>
                  <dd className="flex flex-wrap gap-1.5" data-testid="preview-classes">
                    {pv.labelClasses!.map((c) => (
                      <Badge key={c} theme="clear">{c}{pv.groups?.find((g) => g.label === c) ? ` · ${pv.groups!.find((g) => g.label === c)!.count}` : ""}</Badge>
                    ))}
                  </dd>
                </>
              )}
            </dl>
            {(pv.importedLabels ?? 0) > 0 && (
              <p className="flex items-start gap-2 rounded-md bg-info-tint p-3" data-testid="preview-imported">
                <ImportedIcon className="mt-0.5 size-4 shrink-0 text-info" />
                <span>
                  Imports {pv.importedLabels} {pv.importedLabels === 1 ? "label" : "labels"} from <code>{pv.labelsFrom}</code> as <em>imported</em> annotations. They count as unreviewed until you accept them.
                </span>
              </p>
            )}
            {(pv.alsoConfirms?.length ?? 0) > 0 && (
              <div>
                <p className="text-xs text-hint">Also confirms</p>
                <ul className="mt-1 list-disc pl-5" data-testid="preview-also">
                  {pv.alsoConfirms!.map((a) => <li key={a.id}>{String(a.payload.summary ?? a.kind)}</li>)}
                </ul>
              </div>
            )}
            {pv.blocking?.map((b) => (
              <p key={b.nodeId} className="flex items-start gap-2 text-warning" role="alert">
                <PrivacyIcon className="mt-0.5 size-4 shrink-0" /> <span>{b.reason}. <Link className="underline" to={sourcesUrl(projectId, b.nodeId)}>Open in Sources</Link></span>
              </p>
            ))}
            {error && <p className="text-danger" role="alert">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={create.isPending} disabled={!pv || blocked} onClick={() => create.mutate()} data-testid="create-and-open">
            Create & open Studio
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
