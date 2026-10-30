import { Link } from "react-router";
import { LockIcon, LicenseIcon } from "@/components/icons";
import { AppLayout, PageHeading } from "@/components/layout/app-layout";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { envLabel, formatBytes, itemNoun, plural, pluralWord, projectIcon } from "@/lib/format";
import { envOf } from "@/lib/environment";
import { projectItems } from "@/lib/items";
import { cn } from "@/lib/utils";
import type { Project } from "@/types";
import { FullPageMessage, useProjects, useSavedAnnotations } from "./shared";
import { NAMING } from "@studio/plugin-contracts/naming";

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
    <AppLayout>
      <div className="mx-auto w-full max-w-6xl px-4 py-5 md:px-6 md:py-6">
        <PageHeading
          title="Datasets"
          description="Open a dataset to annotate it in the Studio. These development seeds are small, license-tracked samples. Each one opens in the viewer built for its data type."
        />

        <section aria-labelledby="seed-heading">
          <h2 id="seed-heading" className="mb-3 flex items-center gap-2 text-body font-semibold">
            Ready to annotate
            {!isLoading && <span className="font-normal text-hint">{available.length}</span>}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {isLoading && [0, 1, 2].map((i) => <DatasetCardSkeleton key={i} />)}
            {available.map((p) => <DatasetCard key={p.id} project={p} />)}
          </div>
        </section>

        {byo.length > 0 && (
          <section aria-labelledby="byo-heading" className="mt-10">
            <h2 id="byo-heading" className="mb-1 text-body font-semibold">Bring your own data</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              These sources restrict redistribution, so {NAMING.displayName} doesn't bundle them. You'll be able to open your own authorized copy when their viewers ship.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {byo.map((p) => <DatasetCard key={p.id} project={p} />)}
            </div>
          </section>
        )}
      </div>
    </AppLayout>
  );
}

function progressStatus(done: number, total: number): { label: string; theme: BadgeProps["theme"] } {
  if (total > 0 && done >= total) return { label: "Fully annotated", theme: "success" };
  if (done > 0) return { label: "In progress", theme: "info" };
  return { label: "Not started", theme: "unknown" };
}

/** Same frame as DatasetCard so the grid doesn't jump when projects arrive. */
function DatasetCardSkeleton() {
  return (
    <Card view="outlined" className="flex flex-col p-4" aria-busy>
      <div className="flex items-start gap-3">
        <Skeleton className="size-10 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <SkeletonText variant="subheader" className="w-3/5" />
          <Skeleton className="mt-1 h-5 w-20" />
          <SkeletonText className="mt-1 w-2/5" />
        </div>
      </div>
      <div className="mt-4">
        <SkeletonText className="w-1/4" />
        <Skeleton className="mt-1.5 h-1 rounded-none" />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <SkeletonText variant="body-1" className="w-3/4" />
            <SkeletonText variant="subheader" className="w-1/2" />
          </div>
        ))}
      </div>
      <div className="mt-4 border-t border-border pt-3">
        <SkeletonText variant="body-1" className="w-4/5" />
        <SkeletonText variant="body-1" className="w-1/2" />
      </div>
    </Card>
  );
}

function DatasetCard({ project }: { project: Project }) {
  const Icon = projectIcon(project);
  const env = envOf(project);
  const noun = itemNoun(env);
  const available = project.status === "available";
  const items = available ? projectItems(project) : [];
  const bytes = project.assets.reduce((n, a) => n + a.bytes, 0);
  const saved = useSavedAnnotations(project.id, available);
  const annotations = saved.data?.annotations ?? [];
  const itemIds = new Set(items.map((i) => i.id));
  const done = new Set(annotations.map((a) => a.itemId).filter((id) => itemIds.has(id))).size;
  const status = progressStatus(done, items.length);
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  const body = (
    <Card view={available ? "selection" : "outlined"} className={cn("flex h-full flex-col p-4", !available && "opacity-70")}>
      <div className="flex items-start gap-3">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg", available ? "tile-gradient text-foreground" : "bg-generic text-muted-foreground")}>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-body-2 font-semibold" title={project.title}>{project.title}</h3>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            {available ? (
              saved.isLoading ? <Skeleton className="h-5 w-20 rounded-xs" /> : <Badge theme={status.theme}>{status.label}</Badge>
            ) : (
              <Badge theme="unknown"><LockIcon />Restricted</Badge>
            )}
            {project.restricted && (
              <Badge theme="warning" title="The source license restricts commercial use or redistribution"><LockIcon />Local dev only</Badge>
            )}
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{envLabel(env)}{(env?.task ?? project.task) && <> · {(env?.task ?? project.task)!.replace("-", " ")}</>}</p>
        </div>
      </div>

      {available && (
        <>
          <div className="mt-4">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">Annotated</span>
              <span className="tnum">{done} <span className="text-hint">/ {items.length}</span></span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden bg-generic-hover" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Items annotated">
              <div className={cn("h-full transition-[width] duration-600", done >= items.length && items.length ? "bg-positive" : "bg-primary")} style={{ width: `${pct}%` }} />
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-3">
            <Metric label={capitalize(pluralWord(2, noun))} value={String(items.length)} />
            <Metric label="Annotations" value={saved.isLoading ? "–" : String(annotations.length)} />
            <Metric label="Size" value={formatBytes(bytes)} />
          </dl>
        </>
      )}

      <div className="mt-auto pt-4">
        <div className="flex items-start gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
          <LicenseIcon className="mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-2">{project.license}</span>
        </div>
      </div>
    </Card>
  );

  return available ? (
    <Link to={`/datasets/${project.id}`} className="block rounded-lg" aria-label={`Open ${project.title}, ${plural(items.length, noun)}, ${status.label}`}>
      {body}
    </Link>
  ) : (
    <div aria-disabled>{body}</div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-sm text-muted-foreground">{label}</dt>
      <dd className="tnum mt-0.5 truncate text-body-2 font-semibold">{value}</dd>
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
