import { Link } from "react-router";
import { ArrowUpRight, Lock, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, ITEM_NOUN, plural, projectIcon, VIEWER_META } from "@/lib/format";
import { projectItems } from "@/lib/items";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";
import { FullPageMessage, PageHeader, useProjects } from "./shared";

export function WorkspacePage() {
  const { data: projects, isLoading, error } = useProjects();

  if (error) {
    return (
      <FullPageMessage
        title="No seed data found"
        body="Fetch the development seeds with `pnpm seeds` (requires the Kaggle CLI), then reload this page."
      />
    );
  }

  const available = projects?.filter((p) => p.status === "available") ?? [];
  const byo = projects?.filter((p) => p.status === "bring-your-own") ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto px-4 py-8 sm:px-6">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Datasets</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Open a dataset to annotate it in the Studio. These development seeds are small, license-tracked samples. Each one opens in the viewer built for its data type.
          </p>
        </div>

        <section aria-labelledby="seed-heading">
          <h2 id="seed-heading" className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Ready to annotate</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-44" />)}
            {available.map((p) => <DatasetCard key={p.id} project={p} />)}
          </div>
        </section>

        {byo.length > 0 && (
          <section aria-labelledby="byo-heading" className="mt-10">
            <h2 id="byo-heading" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Bring your own data</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              These sources restrict redistribution, so Inkling doesn't bundle them. You'll be able to open your own authorized copy when their viewers ship.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {byo.map((p) => <DatasetCard key={p.id} project={p} />)}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function DatasetCard({ project }: { project: Project }) {
  const Icon = projectIcon(project);
  const meta = VIEWER_META[project.viewer];
  const available = project.status === "available";
  const items = available ? projectItems(project) : [];
  const bytes = project.assets.reduce((n, a) => n + a.bytes, 0);

  const body = (
    <Card
      className={cn(
        "group flex h-full flex-col gap-4 border-[var(--border-color)] bg-card p-4 shadow-none transition-colors",
        available ? "hover:border-primary/60" : "opacity-75",
      )}
    >
      <div className="flex items-start justify-between">
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-lg", available ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
          <Icon className="h-[18px] w-[18px]" />
        </span>
        {available ? (
          <div className="flex items-center gap-2">
            {project.restricted && (
              <Badge variant="outline" className="gap-1 border-state-human/40 font-normal text-state-human" title="The source license restricts commercial use or redistribution">
                <Lock className="h-3 w-3" />Local dev only
              </Badge>
            )}
            <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-primary" />
          </div>
        ) : (
          <Badge variant="outline" className="gap-1 font-normal text-muted-foreground"><Lock className="h-3 w-3" />Restricted</Badge>
        )}
      </div>
      <div>
        <h3 className="font-medium leading-tight">{project.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {meta.label}
          {project.task && <> · {project.task.replace("-", " ")}</>}
          {available && <> · {plural(items.length, ITEM_NOUN[project.viewer])} · {formatBytes(bytes)}</>}
        </p>
      </div>
      <div className="mt-auto flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
        <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" />
        <span className="line-clamp-2">{project.license}</span>
      </div>
    </Card>
  );

  return available ? (
    <Link to={`/datasets/${project.id}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">{body}</Link>
  ) : (
    <div aria-disabled>{body}</div>
  );
}
