import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { DoneIcon, ExportIcon, AnnotateIcon, WarningIcon } from "@/components/icons";
import { AppLayout, PageHeading } from "@/components/layout/app-layout";
import { describeGeometry, ProvenanceBadge } from "@/components/annotation/provenance";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { fetchAnnotations } from "@/lib/api";
import { projectItems } from "@/lib/items";
import { labelColor } from "@/lib/labels";
import { envOf } from "@/lib/environment";
import { labelNames } from "@/platform/environment";
import { FullPageMessage, useProject } from "./shared";

export function ReviewPage() {
  const { datasetId = "" } = useParams();
  const { project, isLoading } = useProject(datasetId);
  // Review what the server has, not unsaved local edits.
  const saved = useQuery({ queryKey: ["annotations", datasetId, "review"], queryFn: () => fetchAnnotations(datasetId), enabled: !!project, staleTime: 0 });
  const [labelFilter, setLabelFilter] = useState("all");

  const items = useMemo(() => (project ? projectItems(project) : []), [project]);
  const itemName = useMemo(() => new Map(items.map((i) => [i.id, i.name])), [items]);

  if (isLoading || saved.isLoading) return <FullPageMessage title="Loading review…" loading />;
  if (!project) return <FullPageMessage title="Dataset not found" />;
  if (saved.error || !saved.data) return <FullPageMessage title="Couldn't load annotations" body={String(saved.error)} />;

  const annotations = saved.data.annotations;
  const labels = labelNames(project.labels);
  const env = envOf(project);
  const annotated = new Set(annotations.map((a) => a.itemId));
  // Validation comes from the environment's review rules (modules/core/reviewRules.ts…).
  const issues = env ? env.reviewRules.flatMap((r) => r.check({ env, items, annotations })).map((i) => i.message) : [];
  const rows = labelFilter === "all" ? annotations : annotations.filter((a) => a.label === labelFilter);
  const usedLabels = labels.filter((l) => annotations.some((a) => a.label === l));

  return (
    <AppLayout
      dataset={{ id: project.id, title: project.title }}
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6">
        <PageHeading
          title="Review dataset"
          description={<>Revision {saved.data.revision}{saved.data.savedAt && ` · saved ${new Date(saved.data.savedAt).toLocaleString()}`}</>}
          actions={
            <>
              <Button variant="outline" size="lg" asChild><Link to={`/datasets/${project.id}`}><AnnotateIcon />Continue annotating</Link></Button>
              <Button size="lg" asChild><Link to={`/datasets/${project.id}/export`}><ExportIcon />Export dataset</Link></Button>
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
            {!rows.length && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing saved yet. Annotations appear here once the Studio saves them.</p>}
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
