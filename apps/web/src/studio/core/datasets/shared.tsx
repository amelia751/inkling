import type { ReactNode } from "react";
import { Link } from "react-router";
import type { DatasetCollection } from "@studio/contracts/types";
import { AiIcon, ChevronRightIcon, CloseIcon, ErrorIcon, PrivacyIcon, QueueIcon, RelationshipIcon, WarningIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Sheet, SheetContent } from "@studio/ui/ui/sheet";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";
import { usePreview } from "@/studio/components/sources/queries";
import { targetUrl } from "@/studio/lib/routes";
import type { DatasetAttentionItem } from "./api";
import { kindIcon } from "@/studio/lib/file-kinds";
import { useViewport } from "@/studio/lib/use-media-query";

/**
 * Building blocks shared by the Datasets views, drawn like the rest of the app: section headings
 * as on the project Overview, the inspector as in Sources (uppercase hint headings, 14px body).
 */

/** A titled block of a page: "Collections", "Needs attention", with an optional link on the right. */
export function DatasetSection({ id, title, link, children, testid }: { id: string; title: ReactNode; link?: { to: string; label: string }; children: ReactNode; testid?: string }) {
  return (
    <section aria-labelledby={id} data-testid={testid}>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 id={id} className="text-body-2 font-semibold">{title}</h2>
        {link && <Link to={link.to} className="text-sm text-brand hover:underline">{link.label}</Link>}
      </div>
      {children}
    </section>
  );
}

/**
 * Inferred, not confirmed (§3: "Do not present inferred facts as verified"). Utility, not the AI
 * lime: inspection inferred it, a model didn't necessarily.
 */
export function SuggestedBadge({ what = "This" }: { what?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge theme="utility" size="xs" tabIndex={0} data-testid="suggested">Suggested</Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{what} was inferred from what we found in the files. Nothing relies on it until someone confirms it.</TooltipContent>
    </Tooltip>
  );
}

/** The collection's representative item, or its kind's icon on the dark canvas well. */
export function CollectionThumb({ collection, className }: { collection: Pick<DatasetCollection, "kind" | "previewNodeId">; className?: string }) {
  const preview = usePreview(collection.previewNodeId);
  const Icon = kindIcon(collection.kind);
  const img = preview.data?.thumbnailUrl ?? preview.data?.url;
  return (
    <div className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-canvas", className)} aria-hidden>
      {preview.isLoading ? <Skeleton className="size-full rounded-none" /> : img ? <img src={img} alt="" className="size-full object-cover" /> : <Icon className="size-6 text-canvas-foreground/60" />}
    </div>
  );
}

export function InspectorSection({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <section data-testid={testid}>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-hint">{title}</h3>
      {children}
    </section>
  );
}

/** Label/value rows inside an inspector section. */
export function Facts({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The inspector's frame: title, close, scrolling body. */
export function DatasetInspector({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <aside className="flex h-full min-h-0 flex-col" aria-label="Details" data-testid="dataset-inspector">
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        <Button variant="ghost-secondary" size="icon" onClick={onClose} aria-label="Hide details" data-testid="inspector-close">
          <CloseIcon />
        </Button>
      </header>
      <div className="thin-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-sm">{children}</div>
    </aside>
  );
}

/**
 * Main work area plus an optional inspector (§3 layout): a column on the right on desktop, a
 * drawer from the right below it. The inspector opens on selection, never permanently.
 */
export function Workspace({ inspector, onCloseInspector, inspectorTitle, children }: { inspector: ReactNode | null; onCloseInspector: () => void; inspectorTitle: string; children: ReactNode }) {
  const desktop = useViewport() === "desktop";
  if (!desktop)
    return (
      <>
        {children}
        <Sheet open={!!inspector} onOpenChange={(o) => !o && onCloseInspector()}>
          <SheetContent side="right" title={inspectorTitle} showClose={false} className="flex w-[min(380px,92vw)] flex-col p-0">
            {inspector}
          </SheetContent>
        </Sheet>
      </>
    );
  return (
    <div className={cn("grid items-start gap-5", inspector && "grid-cols-[minmax(0,1fr)_320px]")}>
      <div className="min-w-0">{children}</div>
      {inspector && <InspectorColumn>{inspector}</InspectorColumn>}
    </div>
  );
}

function InspectorColumn({ children }: { children: ReactNode }) {
  return <div className="sticky top-4 max-h-[calc(100dvh-8rem)] overflow-hidden rounded-lg border border-border bg-card">{children}</div>;
}

/** Selectable rows (collections, relationships, fields, issues): a full-width button, keyboard first. */
export function SelectableRow({ selected, onSelect, children, className, ...rest }: { selected: boolean; onSelect: () => void; children: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn("flex w-full items-center gap-3 px-4 py-3 text-left text-sm [outline-offset:-2px] hover:bg-generic", selected && "bg-selection hover:bg-selection-hover", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

const ATTENTION_ICON = { malformed: WarningIcon, pipeline: QueueIcon, plan: AiIcon, suggestion: RelationshipIcon } as const;
const KIND_WORD = { malformed: "Files", pipeline: "Pipeline", plan: "Plan waiting", suggestion: "To confirm" } as const;

/**
 * One thing that needs a person (§2.1 "Needs attention"): what, how much it matters in words
 * (never colour alone), and where to go. Keyboard: a link per row.
 */
export function AttentionLine({ projectId, item: i, showDataset = false }: { projectId: string; item: DatasetAttentionItem; showDataset?: boolean }) {
  const Icon = i.blocking ? PrivacyIcon : i.severity === "high" ? ErrorIcon : ATTENTION_ICON[i.kind];
  return (
    <Link to={targetUrl(projectId, i.action.target)} className="flex items-center gap-3 px-4 py-3 text-sm hover:bg-generic" data-testid="attention-item" data-kind={i.kind} data-severity={i.severity}>
      <Icon className={cn("size-4 shrink-0", i.blocking || i.severity === "high" ? "text-warning" : i.kind === "plan" ? "text-ai-text" : "text-hint")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{i.title}</span>
        <span className="block truncate text-muted-foreground">
          {showDataset && i.datasetTitle && <>{i.datasetTitle} · </>}
          {i.detail}
        </span>
      </span>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{KIND_WORD[i.kind]}</span>
      {i.blocking && <Badge theme="danger" size="xs">Blocks release</Badge>}
      <ChevronRightIcon className="size-4 shrink-0 text-hint" aria-hidden />
    </Link>
  );
}

/** "View only": a viewer browses, never changes (§12.2). Says so once, near the actions. */
export function ReadOnlyBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge theme="unknown" tabIndex={0} data-testid="read-only">View only</Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">You can browse this dataset. Ask a contributor to add data or change its structure.</TooltipContent>
    </Tooltip>
  );
}
