import { useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ExportIcon, FileIcon } from "@studio/ui/icons";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card, CardHeader, CardTitle } from "@studio/ui/ui/card";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Label } from "@studio/ui/ui/label";
import { fetchAnnotations } from "@/studio/lib/api";
import { projectItems } from "@/studio/lib/items";
import { envOf } from "@/studio/lib/environment";
import { labelNames } from "@studio/contracts/environment";
import { FormatExports } from "@/studio/components/studio/FormatExports";
import { cn } from "@studio/ui/utils";
import { FullPageMessage, useProject } from "./shared";
import { NAMING, NS, RES } from "@studio/contracts/naming";

/** Download-only export for the MVP; public publishing is out of scope (ui.md §11). */
export function ExportPage() {
  const { datasetId = "" } = useParams();
  const { project, isLoading } = useProject(datasetId);
  const saved = useQuery({ queryKey: ["annotations", datasetId, "export"], queryFn: () => fetchAnnotations(datasetId), enabled: !!project, staleTime: 0 });
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const env = project ? envOf(project) : undefined;

  const bundle = useMemo(() => {
    if (!project || !saved.data) return null;
    const items = projectItems(project);
    return {
      annotationsVersion: saved.data.annotationsVersion ?? 1,
      format: `${RES}-annotations/v1`,
      exportedAt: new Date().toISOString(),
      dataset: {
        id: project.id,
        title: project.title,
        task: env?.task ?? project.task,
        labels: labelNames(project.labels),
        labelGroups: project.labels,
        source: project.source,
        license: project.license,
        revision: saved.data.revision,
        annotationMethod: `Manual annotation in ${NAMING.displayName} Studio`,
        limitations: "Development seed sample. Not for clinical use. Verify the source license before redistribution.",
      },
      items: items.map((i) => ({ id: i.id, name: i.name, files: i.assets.map((a) => ({ path: a.path, sha256: a.sha256 })), sourceLabel: i.sourceLabel })),
      annotations: saved.data.annotations,
      // Exactly which modules (and versions) produced this export.
      environment: env ? { id: env.id, extends: env.spec.extends, modules: env.modules, dataKind: env.dataKind.id, renderers: env.viewports.map((v) => v.renderer.id), tools: env.tools.map((t) => t.id) } : null,
    };
  }, [project, saved.data, env]);

  if (isLoading || saved.isLoading) return <FullPageMessage title="Preparing export…" loading />;
  if (!project || !bundle) return <FullPageMessage title="Dataset not found" />;

  const fileName = `${project.id}-r${bundle.dataset.revision}.${NS}.json`;
  const download = () => {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const rows: [string, ReactNode][] = [
    ["Task", <span className="capitalize">{bundle.dataset.task?.replace("-", " ") ?? "–"}</span>],
    ["Labels", <span className="flex flex-wrap gap-1">{bundle.dataset.labels?.map((l) => <Badge key={l} className="capitalize">{l}</Badge>)}</span>],
    ["Items", String(bundle.items.length)],
    ["Annotations", String(bundle.annotations.length)],
    ["Method", bundle.dataset.annotationMethod],
    ["Source", <a href={bundle.dataset.source} target="_blank" rel="noreferrer" className="break-all text-brand hover:underline">{bundle.dataset.source}</a>],
    ["License", bundle.dataset.license],
    ["Limitations", bundle.dataset.limitations],
  ];

  return (
    <AppLayout
      dataset={{ id: project.id, title: project.title }}
    >
      <div className="mx-auto w-full max-w-3xl px-4 py-5 md:px-6 md:py-6">
        <PageHeading
          title="Export dataset"
          description={<>Downloads the saved annotations (revision {bundle.dataset.revision}) with a dataset card and file checksums. Original files are referenced by path and sha256, never modified.</>}
        />

        <Card className="mb-4">
          <CardHeader className="pb-1">
            <CardTitle>Dataset card</CardTitle>
          </CardHeader>
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 px-4 pb-2 text-sm sm:grid-cols-[160px_1fr]">
            {rows.map(([k, v], i) => (
              <div key={k} className="contents">
                <dt className={cn("py-2.5 text-muted-foreground", i < rows.length - 1 && "border-b border-border")}>{k}</dt>
                <dd className={cn("min-w-0 py-2.5 break-words", i < rows.length - 1 && "border-b border-border")}>{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="p-4">
          <div className="flex items-start gap-3">
            <Checkbox id="rights" checked={rights} onCheckedChange={(v) => setRights(v === true)} className="mt-px" />
            <Label htmlFor="rights" className="text-sm font-normal">
              I confirm I'm permitted to export these annotations under the source license above, and that the data is de-identified.
            </Label>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
              <FileIcon className="size-4 shrink-0" />
              <span className="truncate font-mono text-code">{fileName}</span>
            </span>
            <Button size="lg" onClick={download} disabled={!rights}>
              <ExportIcon /> Download JSON
            </Button>
          </div>
        </Card>

        <FormatExports project={project} enabled={rights} />
      </div>
    </AppLayout>
  );
}
