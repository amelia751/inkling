import { useMemo, useState } from "react";
import { registry } from "@/extension-host/registry";
import { kindFolder, reviewRunsByKind } from "@/studio/lib/per-kind";
import { EmptyState } from "@studio/ui/ui/empty-state";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { DoneIcon, ExportIcon, AnnotateIcon, WarningIcon } from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { describeGeometry, ProvenanceBadge } from "@/studio/components/annotation/provenance";
import { Button } from "@studio/ui/ui/button";
import { Card, CardHeader, CardTitle } from "@studio/ui/ui/card";
import { SegmentedControl } from "@studio/ui/ui/segmented-control";
import { fetchAnnotations, fetchTaskDocument } from "@/studio/lib/api";
import { projectItems } from "@/studio/lib/items";
import { labelColor } from "@studio/plugin-ui-sdk/labels";
import { envOf } from "@/studio/lib/environment";
import { labelNames } from "@studio/contracts/environment";
import { datasetUrl, projectUrl, studioUrl } from "@/studio/lib/routes";
import { fetchTask, projectKeys } from "@/studio/lib/projects-api";
import { FullPageMessage, useDatasetParam, useProjectParam } from "./shared";

/**
 * Annotation review of one task (`/projects/:p/review/:taskId`): what the server saved, the
 * environment's review rules and the annotation list. The project's Review page links here
 * from its "Annotation review" section (todo6 Phase 8).
 */
export function ReviewPage() {
  const datasetId = useDatasetParam();
  const projectId = useProjectParam();
  const doc = useQuery({ queryKey: ["tasks", datasetId, "document"], queryFn: () => fetchTaskDocument(datasetId), staleTime: 30_000 });
  const project = doc.data;
  const isLoading = doc.isLoading;
  const task = useQuery({ queryKey: projectKeys.task(datasetId), queryFn: () => fetchTask(datasetId), staleTime: 30_000 });
  const datasetOf = task.data?.datasetId;
  // Review what the server has, not unsaved local edits.
  const saved = useQuery({ queryKey: ["annotations", datasetId, "review"], queryFn: () => fetchAnnotations(datasetId), enabled: !!project, staleTime: 0 });
  const [labelFilter, setLabelFilter] = useState("all");

  const items = useMemo(() => (project ? projectItems(project) : []), [project]);
  const itemName = useMemo(() => new Map(items.map((i) => [i.id, i.name])), [items]);

  if (isLoading || saved.isLoading) return <FullPageMessage title="Loading review" loading />;
  if (!project) return <FullPageMessage kind="not-found" title="Dataset not found" />;
  if (saved.error || !saved.data) return <FullPageMessage kind="error" title="Couldn't load annotations" body={String(saved.error)} />;

  const annotations = saved.data.annotations;
  const labels = labelNames(project.labels);
  const env = envOf(project);
  const annotated = new Set(annotations.map((a) => a.itemId));
  // Validation comes from the environment's review rules (modules/core/reviewRules.ts…).
  // todo19 D8: rules run over single-kind views (env rules ∪ the kind profile's), one run per kind.
  const runs = env ? reviewRunsByKind(env.spec, items, env.dataKind.id) : [];
  const issues = env
    ? runs.flatMap((run) => {
        const ids = new Set(run.items.map((i) => i.id));
        const scoped = annotations.filter((a) => ids.has(a.itemId));
        const rules = run.ruleIds.map((id) => env.reviewRules.find((r) => r.id === id) ?? registry.get("reviewRules", id)).filter((r) => !!r);
        return rules.flatMap((r) => r.check({ env, items: run.items, annotations: scoped })).map((i) => (runs.length > 1 ? `${kindFolder(run.kind)}: ${i.message}` : i.message));
      })
    : [];
  const rows = labelFilter === "all" ? annotations : annotations.filter((a) => a.label === labelFilter);
  const usedLabels = labels.filter((l) => annotations.some((a) => a.label === l));

  return (
    <AppLayout
      dataset={{ id: project.id, title: project.title }}
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6">
        <PageHeading
          title={<><Link to={projectUrl(projectId, "review")} className="text-muted-foreground hover:text-foreground">Review</Link> <span className="text-hint">/</span> {project.title}</>}
          description={<>Revision {saved.data.revision}{saved.data.savedAt && ` · saved ${new Date(saved.data.savedAt).toLocaleString()}`}</>}
          actions={
            <>
              <Button variant="outline" size="lg" asChild><Link to={studioUrl(projectId, project.id)}><AnnotateIcon />Continue annotating</Link></Button>
              {datasetOf && <Button size="lg" asChild><Link to={datasetUrl(projectId, datasetOf, "publish")}><ExportIcon />Export dataset</Link></Button>}
            </>
          }
        />

        <Card className="mb-4 grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Stat label="Items annotated" value={annotated.size} total={items.length} />
          <Stat label="Annotations" value={annotations.length} />
          <Stat label="Label classes used" value={usedLabels.length} total={labels.length} />
        </Card>

        <Card className="mb-4">
          <CardHeader className="pb-3">
            <CardTitle>Validation</CardTitle>
          </CardHeader>
          <ul className="space-y-2 px-4 pb-4">
            {issues.length ? (
              issues.map((text) => (
                <li key={text} className="flex items-start gap-2 rounded-md bg-warning-tint px-3 py-2 text-sm">
                  <WarningIcon className="mt-px size-4 shrink-0 text-warning" />
                  {text}
                </li>
              ))
            ) : (
              <li className="flex items-start gap-2 rounded-md bg-positive-tint px-3 py-2 text-sm">
                <DoneIcon className="mt-px size-4 shrink-0 text-positive" />
                Every item has at least one annotation.
              </li>
            )}
          </ul>
        </Card>

        <Card>
          <CardHeader className="flex-wrap justify-between pb-3">
            <CardTitle>
              Annotations <span className="font-normal text-hint">{rows.length}</span>
            </CardTitle>
            {usedLabels.length > 1 && (
              <SegmentedControl
                aria-label="Filter by label"
                value={labelFilter}
                onValueChange={setLabelFilter}
                options={[{ value: "all", label: "All" }, ...usedLabels.map((l) => ({ value: l, label: <span className="capitalize">{l}</span> }))]}
              />
            )}
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-border text-left text-muted-foreground">
                  <th className="py-2.5 pl-4 pr-2 font-normal">Label</th>
                  <th className="px-2 py-2.5 font-normal">Item</th>
                  <th className="px-2 py-2.5 font-normal">Shape</th>
                  <th className="px-2 py-2.5 font-normal">Provenance</th>
                  <th className="py-2.5 pl-2 pr-4 text-right font-normal">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((a) => (
                  <tr key={a.id} className="transition-colors hover:bg-generic">
                    <td className="pb-2.5 pl-4 pr-2 pt-[11px]">
                      <span className="flex items-center gap-2 capitalize">
                        <span className="size-2 shrink-0 rounded-full" style={{ background: labelColor(labels, a.label) }} />
                        {a.label}
                      </span>
                    </td>
                    <td className="max-w-56 truncate px-2 pb-2.5 pt-[11px]" title={itemName.get(a.itemId)}>{itemName.get(a.itemId)}</td>
                    <td className="whitespace-nowrap px-2 pb-2.5 pt-[11px] text-muted-foreground">{describeGeometry(a, env)}</td>
                    <td className="px-2 py-2"><ProvenanceBadge provenance={a.provenance} /></td>
                    <td className="tnum whitespace-nowrap pb-2.5 pl-2 pr-4 pt-[11px] text-right text-muted-foreground">{formatDate(a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <EmptyState art="annotation" title="No annotations yet" description="Annotations appear here once the Studio saves them." />}
          </div>
        </Card>
      </div>
    </AppLayout>
  );
}

function Stat({ label, value, total }: { label: string; value: number; total?: number }) {
  return (
    <div className="px-4 py-3">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="tnum mt-1 text-header-1 font-semibold">
        {value}
        {total !== undefined && <span className="text-body-3 font-normal text-hint"> / {total}</span>}
      </div>
    </div>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
