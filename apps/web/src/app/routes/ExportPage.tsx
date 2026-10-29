import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { fetchAnnotations } from "@/lib/api";
import { projectItems } from "@/lib/items";
import { FullPageMessage, PageHeader, useProject } from "./shared";

/** Download-only export for the MVP; public publishing is out of scope (ui.md §11). */
export function ExportPage() {
  const { datasetId = "" } = useParams();
  const { project, isLoading } = useProject(datasetId);
  const saved = useQuery({ queryKey: ["annotations", datasetId, "export"], queryFn: () => fetchAnnotations(datasetId), enabled: !!project, staleTime: 0 });
  const [rights, setRights] = useState(false);

  const bundle = useMemo(() => {
    if (!project || !saved.data) return null;
    const items = projectItems(project);
    return {
      format: "inkling-annotations/v1",
      exportedAt: new Date().toISOString(),
      dataset: {
        id: project.id,
        title: project.title,
        task: project.task,
        labels: project.labels,
        source: project.source,
        license: project.license,
        revision: saved.data.revision,
        annotationMethod: "Manual annotation in Inkling Studio",
        limitations: "Development seed sample. Not for clinical use. Verify the source license before redistribution.",
      },
      items: items.map((i) => ({ id: i.id, name: i.name, files: i.assets.map((a) => ({ path: a.path, sha256: a.sha256 })), sourceLabel: i.sourceLabel })),
      annotations: saved.data.annotations,
    };
  }, [project, saved.data]);

  if (isLoading || saved.isLoading) return <FullPageMessage title="Preparing export…" />;
  if (!project || !bundle) return <FullPageMessage title="Dataset not found" />;

  const download = () => {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${project.id}-r${bundle.dataset.revision}.inkling.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <ChevronRight className="h-3.5 w-3.5" />
          <Link to={`/datasets/${project.id}`} className="hover:text-foreground">{project.title}</Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground">Export</span>
        </nav>
      </PageHeader>
      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 overflow-y-auto px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Export dataset</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Downloads the saved annotations (revision {bundle.dataset.revision}) with a dataset card and file checksums. Original files are referenced by path and sha256, never modified.
          </p>
        </div>

        <Card className="border-[var(--border-color)] p-4 shadow-none">
          <h2 className="mb-3 text-sm font-medium">Dataset card</h2>
          <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm">
            {[
              ["Task", bundle.dataset.task],
              ["Labels", bundle.dataset.labels?.join(", ")],
              ["Items", String(bundle.items.length)],
              ["Annotations", String(bundle.annotations.length)],
              ["Method", bundle.dataset.annotationMethod],
              ["Source", bundle.dataset.source],
              ["License", bundle.dataset.license],
              ["Limitations", bundle.dataset.limitations],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card className="flex flex-col gap-4 border-[var(--border-color)] p-4 shadow-none sm:flex-row sm:items-center">
          <div className="flex flex-1 items-start gap-2">
            <Checkbox id="rights" checked={rights} onCheckedChange={(v) => setRights(v === true)} className="mt-0.5" />
            <Label htmlFor="rights" className="text-sm font-normal leading-snug">
              I confirm I'm permitted to export these annotations under the source license above, and that the data is de-identified.
            </Label>
          </div>
          <Button onClick={download} disabled={!rights}>
            <Download className="h-4 w-4" /> Download JSON
          </Button>
        </Card>
      </main>
    </div>
  );
}
