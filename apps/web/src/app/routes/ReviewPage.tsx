import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { describeGeometry, ProvenanceBadge } from "@/components/studio/LeftSidebar";
import { fetchAnnotations } from "@/lib/api";
import { projectItems } from "@/lib/items";
import { labelColor } from "@/lib/labels";
import { FullPageMessage, PageHeader, useProject } from "./shared";

export function ReviewPage() {
  const { datasetId = "" } = useParams();
  const { project, isLoading } = useProject(datasetId);
  // Review what the server has, not unsaved local edits.
  const saved = useQuery({ queryKey: ["annotations", datasetId, "review"], queryFn: () => fetchAnnotations(datasetId), enabled: !!project, staleTime: 0 });

  if (isLoading || saved.isLoading) return <FullPageMessage title="Loading review…" />;
  if (!project) return <FullPageMessage title="Dataset not found" />;
  if (saved.error || !saved.data) return <FullPageMessage title="Couldn't load annotations" body={String(saved.error)} />;

  const items = projectItems(project);
  const annotations = saved.data.annotations;
  const labels = project.labels ?? [];
  const annotated = new Set(annotations.map((a) => a.itemId));
  const unlabeled = items.filter((i) => !annotated.has(i.id));
  const disagreements = project.task === "classification"
    ? annotations.filter((a) => a.geometry.type === "class" && items.find((i) => i.id === a.itemId)?.sourceLabel && items.find((i) => i.id === a.itemId)?.sourceLabel !== a.label)
    : [];

  const issues = [
    unlabeled.length > 0 && { text: `${unlabeled.length} of ${items.length} items have no annotations yet.`, tone: "warn" as const },
    disagreements.length > 0 && { text: `${disagreements.length} image labels differ from the source dataset's label. Worth a second look.`, tone: "warn" as const },
  ].filter(Boolean) as { text: string; tone: "warn" }[];

  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <ChevronRight className="h-3.5 w-3.5" />
          <Link to={`/datasets/${project.id}`} className="hover:text-foreground">{project.title}</Link>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground">Review</span>
        </nav>
      </PageHeader>
      <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 overflow-y-auto px-4 py-8 sm:px-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Dataset review</h1>
            <p className="mt-1 text-sm text-muted-foreground">Revision {saved.data.revision}{saved.data.savedAt && ` · saved ${new Date(saved.data.savedAt).toLocaleString()}`}</p>
          </div>
          <Button asChild><Link to={`/datasets/${project.id}/export`}>Continue to export</Link></Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Items annotated" value={`${annotated.size} / ${items.length}`} />
          <Stat label="Annotations" value={String(annotations.length)} />
          <Stat label="Label classes used" value={`${new Set(annotations.map((a) => a.label)).size} / ${labels.length}`} />
        </div>

        <Card className="border-[var(--border-color)] p-4 shadow-none">
          <h2 className="mb-3 text-sm font-medium">Validation</h2>
          {issues.length ? (
            <ul className="space-y-2">
              {issues.map((i) => (
                <li key={i.text} className="flex gap-2 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-state-human" />{i.text}</li>
              ))}
            </ul>
          ) : (
            <p className="flex gap-2 text-sm"><CheckCircle2 className="h-4 w-4 text-state-pass" />Every item has at least one annotation.</p>
          )}
        </Card>

        <Card className="border-[var(--border-color)] p-0 shadow-none">
          <h2 className="border-b border-[var(--border-color)] px-4 py-3 text-sm font-medium">Annotations</h2>
          <div className="divide-y divide-[var(--border-color)]">
            {annotations.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: labelColor(labels, a.label) }} />
                <span className="w-32 truncate capitalize">{a.label}</span>
                <span className="flex-1 truncate text-muted-foreground">{items.find((i) => i.id === a.itemId)?.name} · {describeGeometry(a)}</span>
                <ProvenanceBadge provenance={a.provenance} />
              </div>
            ))}
            {!annotations.length && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing saved yet.</p>}
          </div>
        </Card>
      </main>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="border-[var(--border-color)] p-4 shadow-none">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="tnum mt-1 text-xl font-semibold">{value}</div>
    </Card>
  );
}
