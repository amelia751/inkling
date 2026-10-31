import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { SourceNode, SourceNodeDetail } from "@studio/contracts/types";
import { AnnotateIcon, CheckIcon, CloseIcon, CopyIcon, DatasetsIcon, PrivacyIcon, UnknownFileIcon, WarningIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import type { NodePreview } from "@/studio/lib/projects-api";
import { kindLabel, nodeIcon, STATUS_LABEL } from "@/studio/lib/file-kinds";
import { formatBytes } from "@/studio/lib/format";
import { InTasks } from "@/studio/components/files/in-tasks";
import { datasetUrl, projectUrl, sourcesUrl, studioUrl } from "@/studio/lib/routes";
import { useActivity, useVersions } from "@/studio/lib/files/api";
import { ActivitySection, MultiSummary, OriginalNameReveal, RenameableTitle, VersionsSection } from "@/studio/components/files";
import { shortDate } from "./listing";
import { useNode, usePreview } from "./queries";

/** What the Files page lets the inspector do (todo7 Phases 2 and 6); all optional, so it stays read-only without them. */
export interface InspectorActions {
  /** Why this node can't be renamed or replaced (sample data, "Needs the full stack", the root), or null. */
  editReason?: (n: SourceNode) => string | null;
  validate?: (name: string, n: SourceNode) => string | null;
  /** Advice under the rename field that never blocks (Windows-reserved, a person's name). */
  warn?: (name: string, n: SourceNode) => string | null;
  /** Saves a rename; reject with an Error to keep the field open with its message. */
  onRename?: (n: SourceNode, name: string) => Promise<void>;
  /** F2 from the page: the title's rename field is open. */
  renaming?: boolean;
  onRenamingChange?: (v: boolean) => void;
  onReplace?: (n: SourceNode) => void;
  onRestoreVersion?: (n: SourceNode, version: number) => void;
  onDownloadVersion?: (n: SourceNode, version: number, current: boolean) => void;
  /** The project's root folder ("Files"). */
  rootId?: string | null;
}

/**
 * The inspector (todo6 Phase 4.3): Preview, Detected, Used in, Flags, Provenance, each left out
 * when it has nothing to show. Never a patient identifier: DICOM shows a fixed list of
 * acquisition facts, and other facts named like identifiers are not shown.
 */
export function Inspector({ projectId, item, items, onClose, actions = {} }: { projectId: string; item: SourceNode | null; items?: SourceNode[]; onClose: () => void; actions?: InspectorActions }) {
  const multi = items && items.length > 1 ? items : null;
  const one = multi ? null : item;
  const detail = useNode(one?.id);
  const preview = usePreview(one?.id, !!one && one.kind === "file");
  const full: SourceNodeDetail | undefined = detail.data && detail.data.id === one?.id ? detail.data : undefined;
  const n: SourceNode | null = full ? { ...full, ...(one && one.name !== full.name ? { name: one.name } : {}) } : one;
  const isRoot = !!n && !!actions.rootId && n.id === actions.rootId;
  const file = !!n && n.kind === "file";
  const versions = useVersions(file ? n!.id : null);
  const activity = useActivity(n && !isRoot && !n.id.startsWith("seq:") ? n.id : null);
  const reason = n ? (isRoot ? "The project's top folder keeps its name" : n.kind === "sequence" ? "Open the run to rename its files" : (actions.editReason?.(n) ?? null)) : null;
  return (
    <aside className="flex h-full min-h-0 flex-col" aria-label="Details" data-testid="inspector">
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        {multi ? (
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="inspector-title">{multi.length.toLocaleString()} items</h2>
        ) : n && actions.onRename ? (
          <RenameableTitle
            key={n.id}
            name={isRoot ? "Files" : n.name}
            displayName={isRoot ? "Files" : (n.displayPath ?? n.name)}
            kind={n.kind}
            disabledReason={reason}
            validate={actions.validate ? (name) => actions.validate!(name, n) : undefined}
            warn={actions.warn ? (name) => actions.warn!(name, n) : undefined}
            onRename={(name) => actions.onRename!(n, name)}
            editing={actions.renaming}
            onEditingChange={actions.onRenamingChange}
          />
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={n ? n.displayPath ?? n.name : undefined}>
            {n ? n.displayPath ?? n.name : "Details"}
          </h2>
        )}
        <Button variant="ghost-secondary" size="icon" onClick={onClose} aria-label="Hide details" data-testid="inspector-close">
          <CloseIcon />
        </Button>
      </header>
      <div className="thin-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-sm">
        {multi && <MultiSummary items={multi} />}
        {!multi && !n && <p className="text-muted-foreground">Select a file or folder to see what's in it.</p>}
        {!multi && n && (
          <>
            {n.kind === "file" && <PreviewSection n={n} preview={preview.data} loading={preview.isLoading} />}
            <Detected n={n} />
            {full ? <UsedIn projectId={projectId} detail={full} /> : detail.isLoading && <SkeletonText className="w-2/3" />}
            {full && <InTasks projectId={projectId} detail={full} />}
            <Flags projectId={projectId} n={n} />
            {file && (
              <VersionsSection
                versions={versions.data ?? []}
                loading={versions.isLoading}
                disabledReason={reason}
                onRestore={actions.onRestoreVersion ? (v) => actions.onRestoreVersion!(n, v) : undefined}
                onDownload={actions.onDownloadVersion ? (v) => actions.onDownloadVersion!(n, v, !!versions.data?.find((x) => x.version === v)?.current) : undefined}
                onReplace={actions.onReplace ? () => actions.onReplace!(n) : undefined}
              />
            )}
            <ActivitySection items={activity.data ?? []} loading={activity.isLoading} />
            {full && !isRoot && <Provenance projectId={projectId} detail={full} />}
          </>
        )}
      </div>
    </aside>
  );
}

function Section({ title, children, testid }: { title: string; children: ReactNode; testid?: string }) {
  return (
    <section data-testid={testid}>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-hint">{title}</h3>
      {children}
    </section>
  );
}

function PreviewSection({ n, preview, loading }: { n: SourceNode; preview?: NodePreview; loading: boolean }) {
  if (loading) return <Skeleton className="aspect-[4/3] w-full rounded-lg" />;
  if (!preview || !hasPreview(preview)) return null;
  return (
    <Section title="Preview" testid="inspector-preview">
      <PreviewBody n={n} preview={preview} />
    </Section>
  );
}

export function hasPreview(p: NodePreview): boolean {
  return !!(p.url || p.thumbnailUrl || p.table?.columns.length || (p.dicom && Object.keys(safeDicom(p.dicom)).length) || (p.video && Object.keys(p.video).length));
}

/** The preview itself, small in the inspector and large in Quick Look. */
export function PreviewBody({ n, preview, large = false }: { n: SourceNode; preview: NodePreview; large?: boolean }) {
  const img = preview.url ?? preview.thumbnailUrl;
  const Icon = nodeIcon(n);
  return (
    <div className="space-y-3">
      {img ? (
        <div className={cn("flex items-center justify-center overflow-hidden rounded-lg bg-canvas", large ? "h-[min(64vh,640px)]" : "aspect-[4/3]")}>
          <img src={img} alt={n.name} className="max-h-full max-w-full object-contain" data-testid="preview-image" />
        </div>
      ) : (
        large &&
        !preview.table && (
          <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg bg-canvas text-canvas-foreground/70">
            <Icon className="size-10" aria-hidden />
            <span>{kindLabel(n)}</span>
          </div>
        )
      )}
      {preview.table && preview.table.columns.length > 0 && <TableHead table={preview.table} large={large} />}
      {preview.dicom && <Facts facts={safeDicom(preview.dicom)} />}
      {preview.video && <Facts facts={preview.video} />}
    </div>
  );
}

function TableHead({ table, large }: { table: NonNullable<NodePreview["table"]>; large: boolean }) {
  const rows = table.rows.slice(0, large ? 50 : 8);
  return (
    <div className="space-y-1.5" data-testid="preview-table">
      <p className="text-xs text-muted-foreground">
        {table.rowCount !== undefined ? `${table.rowCount.toLocaleString()}${table.truncated ? "+" : ""} rows · ` : ""}
        {table.columns.length} columns
      </p>
      <div className={cn("thin-scrollbar overflow-auto rounded-md border border-border", large ? "max-h-[60vh]" : "max-h-56")}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background">
            <tr>
              {table.columns.map((c) => (
                <th key={c.name} className="whitespace-nowrap border-b border-border px-2 py-1 text-left font-semibold">
                  {c.name}
                  <span className="ml-1 font-normal text-hint">{c.type}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tnum">
            {rows.map((r, i) => (
              <tr key={i} className="odd:bg-generic/40">
                {table.columns.map((c, j) => (
                  <td key={c.name} className="max-w-48 truncate whitespace-nowrap px-2 py-0.5">{r[j] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// DICOM: acquisition facts only, never who the patient is (todo6 Phase 4.3).
const DICOM_KEYS: Record<string, string> = {
  modality: "Modality",
  seriesDescription: "Series",
  bodyPart: "Body part",
  rows: "Rows",
  columns: "Columns",
  size: "Size",
  pixelSpacing: "Pixel spacing",
  spacing: "Spacing",
  sliceThickness: "Slice thickness",
  slices: "Slices",
  frames: "Frames",
};

function safeDicom(d: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(DICOM_KEYS).flatMap(([k]) => (d[k] !== undefined && d[k] !== null ? [[k, d[k]]] : [])));
}

const HIDDEN_FACTS = new Set(["thumbnail", "dicom", "video", "source", "path"]);
const IDENTIFYING = /patient|birth|\bdob\b|mrn|accession|address|phone|email|(^|_)name$/i;

function Facts({ facts }: { facts: Record<string, unknown> }) {
  const shown = (v: unknown) => (Array.isArray(v) ? v.length > 0 && v.every((x) => x !== null && typeof x !== "object") : v !== null && v !== undefined && v !== "" && typeof v !== "object");
  const rows = Object.entries(facts).filter(([k, v]) => !HIDDEN_FACTS.has(k) && !IDENTIFYING.test(k) && shown(v));
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{DICOM_KEYS[k] ?? humanize(k)}</dt>
          <dd className="tnum truncate" title={String(v)}>{Array.isArray(v) ? v.join(" × ") : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function humanize(k: string): string {
  const s = k.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Detected({ n }: { n: SourceNode }) {
  const Icon = nodeIcon(n);
  const checking = n.status === "checking";
  return (
    <Section title="Detected" testid="inspector-detected">
      <p className="mb-2 flex items-center gap-2">
        <Icon className="size-4 text-hint" aria-hidden />
        <span data-testid="inspector-kind">{checking && n.kind === "file" ? `${kindLabel(n)} · Checking…` : kindLabel(n)}</span>
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {n.kind !== "folder" && n.size !== null && (
          <>
            <dt className="text-muted-foreground">Size</dt>
            <dd className="tnum">{formatBytes(n.size)}</dd>
          </>
        )}
        {n.kind === "folder" && (
          <>
            <dt className="text-muted-foreground">Contains</dt>
            <dd className="tnum" data-testid="inspector-contains">
              {n.descendantCount.toLocaleString()} {n.descendantCount === 1 ? "file" : "files"}
              {typeof n.totalBytes === "number" && ` · ${formatBytes(n.totalBytes)}`}
            </dd>
          </>
        )}
        {n.kind !== "folder" && (
          <>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{STATUS_LABEL[n.status]}</dd>
          </>
        )}
      </dl>
      <div className="mt-2">
        <Facts facts={n.facts} />
      </div>
    </Section>
  );
}

function UsedIn({ projectId, detail }: { projectId: string; detail: SourceNodeDetail }) {
  if (!detail.usedIn.length) {
    return (
      <Section title="Used in">
        <p className="text-muted-foreground">Not in a dataset yet.</p>
      </Section>
    );
  }
  return (
    <Section title="Used in" testid="inspector-used-in">
      <ul className="space-y-1.5">
        {detail.usedIn.map((d) => (
          <li key={d.id}>
            <Link to={datasetUrl(projectId, d.id)} className="flex items-center gap-2 hover:underline">
              <DatasetsIcon className="size-4 text-hint" aria-hidden /> {d.title}
            </Link>
            {d.tasks.map((t) => (
              <Link key={t.id} to={studioUrl(projectId, t.id)} className="ml-6 flex items-center gap-2 text-muted-foreground hover:text-foreground hover:underline">
                <AnnotateIcon className="size-3.5" aria-hidden /> {t.title}
              </Link>
            ))}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Flags({ projectId, n }: { projectId: string; n: SourceNode }) {
  const f = n.flags;
  const rows: ReactNode[] = [];
  if (f.privacy) {
    rows.push(
      <Flag key="privacy" icon={<PrivacyIcon className="size-4 text-warning" />} title={f.privacy.clearedBy ? "Privacy hold cleared" : "Held for privacy review"}>
        {f.privacy.reason}
        {!f.privacy.clearedBy && (
          <Link to={projectUrl(projectId, "review")} className="mt-1 block text-brand hover:underline">Review it</Link>
        )}
      </Flag>,
    );
  }
  if (f.duplicate_of) {
    rows.push(
      <Flag key="dup" icon={<WarningIcon className="size-4 text-warning" />} title="Same file as another one">
        Its bytes match{" "}
        <Link to={sourcesUrl(projectId, f.duplicate_of.nodeId)} className="text-brand hover:underline" data-testid="duplicate-link">{f.duplicate_of.name}</Link>. It's kept, and stored once.
      </Flag>,
    );
  }
  if (n.status === "unsupported" || f.unsupported) {
    rows.push(
      <Flag key="unsupported" icon={<UnknownFileIcon className="size-4 text-hint" />} title="We can't read this file yet">
        {typeof f.unsupported === "string" ? `${f.unsupported}. ` : ""}It stays in the project as it is. You can still use it once a plugin reads this kind.
      </Flag>,
    );
  }
  for (const q of f.quality ?? []) {
    rows.push(
      <Flag key={q} icon={<WarningIcon className="size-4 text-warning" />} title="Needs attention">{q}</Flag>,
    );
  }
  if (!rows.length) return null;
  return (
    <Section title="Flags" testid="inspector-flags">
      <ul className="space-y-2.5">{rows}</ul>
    </Section>
  );
}

function Flag({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

function Provenance({ projectId, detail }: { projectId: string; detail: SourceNodeDetail }) {
  const p = detail.provenance;
  return (
    <Section title="Provenance" testid="inspector-provenance">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        {p.sourceTitle && (
          <>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="truncate">{p.sourceTitle}</dd>
          </>
        )}
        {p.importSessionId && (
          <>
            <dt className="text-muted-foreground">Import</dt>
            <dd>
              <Link to={sourcesUrl(projectId, null, { import: p.importSessionId })} className="text-brand hover:underline">Show import</Link>
            </dd>
          </>
        )}
        {p.addedBy && (
          <>
            <dt className="text-muted-foreground">Added by</dt>
            <dd className="truncate">{personName(p.addedBy)}</dd>
          </>
        )}
        {p.addedAt && (
          <>
            <dt className="text-muted-foreground">Added</dt>
            <dd>{shortDate(p.addedAt)}</dd>
          </>
        )}
        {p.sha256 && (
          <>
            <dt className="text-muted-foreground">SHA-256</dt>
            <dd>
              <CopyHash value={p.sha256} />
            </dd>
          </>
        )}
      </dl>
      <div className="mt-2">
        <OriginalNameReveal originalPath={detail.originalPath} />
      </div>
    </Section>
  );
}

function CopyHash({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-mono text-xs hover:text-foreground"
      title={value}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      aria-label="Copy SHA-256"
    >
      {value.slice(0, 12)}…{copied ? <CheckIcon className="size-3 text-positive" /> : <CopyIcon className="size-3 text-hint" />}
    </button>
  );
}

function personName(principal: string): string {
  if (/(^|:)seed$/.test(principal)) return "Sample data";
  return principal.replace(/^user:/, "");
}
