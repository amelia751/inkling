import { useMemo, useState } from "react";
import { Alert } from "@studio/ui/ui/alert";
import { Link, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, CheckIcon, DoneIcon, ErrorIcon, MergeIcon, TodoIcon, WarningIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { RadioGroup, RadioGroupItem } from "@studio/ui/ui/radio-group";
import { Textarea } from "@studio/ui/ui/textarea";
import type { Annotation } from "@studio/contracts/types";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { datasetUrl } from "@/studio/lib/routes";
import { diffPreviewFor } from "@/extension-host/trusted-renderers";
import { api, type Conflict, type DiffChange, type Resolution, type Review } from "./api";
import { registerBuiltinPreviews } from "./previews";
import { short, STATUS_THEME, VersioningOff } from "./VersionsPage";

registerBuiltinPreviews();

/** One review: checks, approvals, conflicts (ours / theirs / custom) and the diff by sample. */
export function ReviewPage() {
  const { projectId: routeProject, datasetId = routeProject ?? "", reviewId = "" } = useParams();
  const projectId = routeProject ?? datasetId;
  return (
    <VersioningOff>
      <ReviewBody datasetId={datasetId} projectId={projectId} reviewId={reviewId} />
    </VersioningOff>
  );
}

function ReviewBody({ datasetId, projectId, reviewId }: { datasetId: string; projectId: string; reviewId: string }) {
  const qc = useQueryClient();
  const review = useQuery({
    queryKey: ["versioning", datasetId, "review", reviewId],
    queryFn: () => api.review(datasetId, datasetId, reviewId),
    // Checks (the worker's de-identification check among them) finish asynchronously.
    refetchInterval: (q) => (["CHECKING", "OPEN", "MERGING"].includes(q.state.data?.status ?? "") ? 1500 : false),
  });
  const r = review.data;
  const diff = useQuery({
    queryKey: ["versioning", datasetId, "diff", r?.base_oid ?? r?.checked_target_oid, r?.source_oid],
    queryFn: () => api.diff(datasetId, datasetId, r!.base_oid ?? r!.checked_target_oid ?? r!.target_branch, r!.source_oid),
    enabled: !!r,
  });
  const [error, setError] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: (fn: () => Promise<Review>) => fn(),
    onSuccess: (next) => {
      setError(null);
      qc.setQueryData(["versioning", datasetId, "review", reviewId], next);
      void qc.invalidateQueries({ queryKey: ["versioning", datasetId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (!r) return <AppLayout><p className="p-8 text-sm text-muted-foreground">{review.error ? String(review.error) : "Loading review…"}</p></AppLayout>;
  const approvedHere = r.approvals.filter((a) => a.approved_source_oid === r.source_oid);
  const open = !["MERGED", "CLOSED"].includes(r.status);
  return (
    <AppLayout dataset={{ id: datasetId, title: datasetId }}>
      <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6" data-testid="review-page" data-status={r.status}>
        <PageHeading
          title={r.title}
          description={
            <span>
              <code className="font-mono text-xs">{r.source_branch}</code> ({short(r.source_oid)}) → <code className="font-mono text-xs">{r.target_branch}</code> · by {r.author_id}
              {r.author_on_behalf_of ? ` for ${r.author_on_behalf_of}` : ""}
            </span>
          }
          actions={
            <>
              <Button variant="outline" size="lg" asChild><Link to={datasetUrl(projectId, datasetId, "versions")}><ArrowLeftIcon />Versions</Link></Button>
              {open && (
                <Button variant="outline" size="lg" disabled={act.isPending} onClick={() => act.mutate(() => api.approve(datasetId, datasetId, r.id, r.source_oid))} data-testid="approve-review">
                  <CheckIcon /> Approve
                </Button>
              )}
              {open && (
                <Button size="lg" disabled={act.isPending || r.status !== "READY" || approvedHere.length < r.required_approvals} onClick={() => act.mutate(() => api.merge(datasetId, datasetId, r.id))} data-testid="merge-review">
                  <MergeIcon /> Merge
                </Button>
              )}
            </>
          }
        />
        {error && <Alert theme="danger" className="mb-3">{error}</Alert>}
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <Badge theme={STATUS_THEME[r.status]} size="sm">{r.status.toLowerCase()}</Badge>
          <span className="text-muted-foreground">
            {approvedHere.length} of {r.required_approvals} approvals on this version
            {approvedHere.length > 0 && ` (${approvedHere.map((a) => a.reviewer_id).join(", ")})`}
          </span>
        </div>

        <h2 className="mb-2 text-body-2 font-semibold">Checks</h2>
        <Card className="mb-6 divide-y divide-border" data-testid="review-checks">
          {r.checks.map((c) => (
            <div key={c.name} className="flex items-center gap-2 px-4 py-2 text-sm" data-check={c.name} data-outcome={c.outcome}>
              {c.outcome === "passed" ? <DoneIcon className="size-4 text-positive" /> : c.outcome === "pending" ? <TodoIcon className="size-4 text-muted-foreground" /> : <ErrorIcon className="size-4 text-danger" />}
              <span className="font-medium">{c.name.replaceAll("_", " ")}</span>
              {!c.mandatory && <Badge theme="clear">optional</Badge>}
              <span className="ml-auto truncate text-muted-foreground">{c.outcome}{c.details && Object.keys(c.details).length ? ` · ${summarize(c.details)}` : ""}</span>
            </div>
          ))}
          {r.checks.length === 0 && <p className="px-4 py-2 text-sm text-muted-foreground">Checks start when the review opens.</p>}
        </Card>

        {r.conflicts.length > 0 && <Conflicts review={r} busy={act.isPending} onResolve={(res) => act.mutate(() => api.resolve(datasetId, datasetId, r.id, r.source_oid, r.checked_target_oid, res))} />}

        <h2 className="mb-2 text-body-2 font-semibold">Changes</h2>
        <DiffBySample changes={diff.data?.changes ?? []} loading={diff.isLoading} />
      </div>
    </AppLayout>
  );
}

function summarize(d: Record<string, unknown>): string {
  if (typeof d.finding_count === "number") return d.finding_count ? `${d.finding_count} findings` : "no findings";
  if (Array.isArray(d.problems)) return d.problems.slice(0, 2).join("; ");
  return Object.entries(d).slice(0, 2).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ");
}

/** Conflict resolution: per conflict, keep ours (the target), take theirs (this review), or write a custom annotation. */
function Conflicts({ review, busy, onResolve }: { review: Review; busy: boolean; onResolve: (r: Resolution[]) => void }) {
  const [choice, setChoice] = useState<Record<string, Resolution["choice"]>>(() => Object.fromEntries(review.conflicts.map((c) => [c.conflict_key, (c.resolution?.choice ?? "theirs") as Resolution["choice"]])));
  const [custom, setCustom] = useState<Record<string, string>>(() => Object.fromEntries(review.conflicts.map((c) => [c.conflict_key, JSON.stringify(c.theirs_annotation ?? c.ours_annotation ?? {}, null, 2)])));
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    try {
      onResolve(review.conflicts.map((c) => (choice[c.conflict_key] === "custom" ? { conflict_key: c.conflict_key, choice: "custom", annotation: JSON.parse(custom[c.conflict_key]) as Annotation } : { conflict_key: c.conflict_key, choice: choice[c.conflict_key] })));
      setError(null);
    } catch {
      setError("A custom resolution isn't valid JSON");
    }
  };
  return (
    <>
      <h2 className="mb-2 flex items-center gap-2 text-body-2 font-semibold"><WarningIcon className="size-4 text-warning" /> Conflicts</h2>
      <Card className="mb-6 divide-y divide-border" data-testid="review-conflicts">
        {review.conflicts.map((c: Conflict) => (
          <div key={c.conflict_key} className="space-y-2 px-4 py-3 text-sm" data-conflict={c.conflict_key}>
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs">{c.conflict_key}</code>
              <Badge theme="warning">{c.kind.replaceAll("_", " ")}</Badge>
              {c.resolution && <Badge theme="success">resolved: {c.resolution.choice}</Badge>}
            </div>
            <RadioGroup value={choice[c.conflict_key]} onValueChange={(v) => setChoice((s) => ({ ...s, [c.conflict_key]: v as Resolution["choice"] }))} className="grid gap-2 md:grid-cols-3">
              {(["ours", "theirs", "custom"] as const).map((k) => (
                <label key={k} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2">
                  <RadioGroupItem value={k} aria-label={k} />
                  <span className="min-w-0">
                    <span className="font-medium">{k === "ours" ? `Keep ${review.target_branch}` : k === "theirs" ? "Take this review's" : "Custom"}</span>
                    {k !== "custom" && <AnnotationLine a={k === "ours" ? c.ours_annotation : c.theirs_annotation} />}
                  </span>
                </label>
              ))}
            </RadioGroup>
            {choice[c.conflict_key] === "custom" && (
              <Textarea className="font-mono text-xs" rows={6} value={custom[c.conflict_key]} onChange={(e) => setCustom((s) => ({ ...s, [c.conflict_key]: e.target.value }))} aria-label={`Custom annotation for ${c.conflict_key}`} />
            )}
          </div>
        ))}
        <div className="flex items-center gap-2 px-4 py-3">
          {error && <span className="text-sm text-danger">{error}</span>}
          <Button className="ml-auto" disabled={busy || review.status === "MERGED"} onClick={submit} data-testid="resolve-conflicts">Save resolutions</Button>
        </div>
      </Card>
    </>
  );
}

function AnnotationLine({ a }: { a?: Annotation }) {
  if (!a) return <span className="block text-muted-foreground">deleted</span>;
  const g = a.geometry as Record<string, unknown>;
  const nums = ["x", "y", "w", "h", "start", "end"].filter((k) => typeof g[k] === "number").map((k) => `${k}=${Math.round((g[k] as number) * 100) / 100}`);
  return <span className="block truncate text-muted-foreground">{a.label} · {String(g.type)} {nums.join(" ")}</span>;
}

const CHANGE_THEME: Record<string, "success" | "danger" | "warning" | "info"> = { added: "success", removed: "danger", changed: "warning", replaced: "warning" };

/** The semantic diff grouped by sample, with each module's diffPreview where one exists. */
function DiffBySample({ changes, loading }: { changes: DiffChange[]; loading: boolean }) {
  const groups = useMemo(() => {
    const m = new Map<string, DiffChange[]>();
    for (const c of changes) {
      const k = c.sample_id ?? "(dataset)";
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [changes]);
  if (loading) return <p className="text-sm text-muted-foreground">Computing the diff…</p>;
  if (!groups.length) return <p className="text-sm text-muted-foreground">No changes.</p>;
  return (
    <div className="space-y-3" data-testid="review-diff">
      {groups.map(([sample, cs]) => (
        <Card key={sample} className="divide-y divide-border" data-sample={sample}>
          <div className="px-4 py-2 text-sm font-medium"><code className="font-mono text-xs">{sample}</code> <span className="font-normal text-muted-foreground">· {cs.length} change{cs.length === 1 ? "" : "s"}</span></div>
          {cs.map((c, i) => {
            const geometry = (c.head_annotation ?? c.base_annotation)?.geometry.type;
            const Preview = diffPreviewFor(geometry)?.component;
            return (
              <div key={i} className="flex items-center gap-3 px-4 py-2 text-sm" data-change={c.type}>
                <Badge theme={CHANGE_THEME[c.type.split(".")[1]] ?? "info"}>{c.type}</Badge>
                <span className="min-w-0 flex-1 truncate">
                  {c.annotation_id && <code className="font-mono text-xs">{c.annotation_id}</code>} {c.class_id && <span className="text-muted-foreground">{c.class_id}</span>}
                  {c.fields?.length ? <span className="text-muted-foreground"> · {c.fields.join(", ")}</span> : null}
                </span>
                {Preview && <Preview change={{ type: c.type, sampleId: c.sample_id, annotationId: c.annotation_id, fields: c.fields }} base={c.base_annotation} head={c.head_annotation} />}
              </div>
            );
          })}
        </Card>
      ))}
    </div>
  );
}
