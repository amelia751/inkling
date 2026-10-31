import { Link } from "react-router";
import type { ImportSession, ImportState, SourceSummary } from "@studio/contracts/types";
import { CloseIcon, DoneIcon, ErrorIcon, QueuedIcon, WarningIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { Spinner } from "@studio/ui/ui/spinner";
import { cn } from "@studio/ui/utils";
import { formatBytes } from "@/studio/lib/format";
import { sourcesUrl } from "@/studio/lib/routes";
import { useImport } from "./queries";

/**
 * Import sessions (todo6 Phase 4.1): a quiet list under the tree (date, counts, state) and, in
 * the listing pane, one session's summary with what didn't make it and why.
 */
const STATE_LABEL: Record<ImportState, string> = {
  uploading: "Uploading",
  inspecting: "Checking files…",
  needs_review: "Ready · needs your review",
  ready: "Ready",
  imported: "Imported",
  failed: "Didn't finish",
  cancelled: "Cancelled",
};

function StateIcon({ state, className }: { state: ImportState; className?: string }) {
  if (state === "uploading" || state === "inspecting") return <Spinner className={cn("size-3.5", className)} />;
  if (state === "failed") return <ErrorIcon className={cn("size-3.5 text-danger", className)} aria-label="Didn't finish" />;
  if (state === "needs_review") return <WarningIcon className={cn("size-3.5 text-warning", className)} aria-label="Needs review" />;
  if (state === "cancelled") return <CloseIcon className={cn("size-3.5 text-hint", className)} aria-label="Cancelled" />;
  return <DoneIcon className={cn("size-3.5 text-positive", className)} aria-label="Ready" />;
}

const ok = (s: ImportSession) => (s.totals.byState.uploaded ?? 0) + (s.totals.byState.skipped_duplicate ?? 0);
const bad = (s: ImportSession) => (s.totals.byState.failed ?? 0) + (s.totals.byState.rejected ?? 0);

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ImportsList({ sessions, selectedId, onOpen }: { sessions: ImportSession[]; selectedId: string | null; onOpen: (id: string) => void }) {
  if (!sessions.length) return null;
  return (
    <section className="shrink-0 border-t border-border px-2 pb-2 pt-3" aria-label="Imports" data-testid="imports">
      <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-hint">Imports</h3>
      <ul className="thin-scrollbar max-h-40 overflow-y-auto">
        {sessions.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onOpen(s.id)}
              className={cn("flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm", selectedId === s.id ? "bg-selection" : "hover:bg-generic")}
              title={STATE_LABEL[s.state]}
              data-testid="import-row"
            >
              <StateIcon state={s.state} />
              <span className="min-w-0 flex-1 truncate">{when(s.startedAt)}</span>
              <span className="tnum shrink-0 text-xs text-muted-foreground">
                {ok(s).toLocaleString()} ✓{bad(s) > 0 && <span className="text-danger"> {bad(s)} ✕</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FILE_STATE: Record<string, string> = { pending: "Not uploaded yet", uploaded: "Uploaded", skipped_duplicate: "Already in this project", rejected: "Not accepted", failed: "Didn't upload" };

export function ImportSummary({ id, projectId, sources, onClose, onTrash, trashReason }: { id: string; projectId: string; sources: SourceSummary[]; onClose: () => void; onTrash?: (source: SourceSummary) => void; trashReason?: (source: SourceSummary) => string | null }) {
  const q = useImport(id);
  const s = q.data;
  const source = s ? sources.find((x) => x.id === s.sourceId) : undefined;
  const root = source?.rootNodeId ?? s?.targetNodeId ?? undefined;
  const why = source && trashReason ? trashReason(source) : null;
  return (
    <div className="thin-scrollbar h-full overflow-y-auto p-5" data-testid="import-summary">
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-header-1 font-semibold">Import · {s ? when(s.startedAt) : "…"}</h2>
          {s && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="import-state">
              <StateIcon state={s.state} /> {STATE_LABEL[s.state]}
            </p>
          )}
        </div>
        {root && (
          <Button variant="outline" asChild>
            <Link to={sourcesUrl(projectId, root)}>Show files</Link>
          </Button>
        )}
        {source?.rootNodeId && onTrash && (
          <Button variant="outline" disabled={!!why} title={why ?? undefined} onClick={() => onTrash(source)} data-testid="import-trash">
            Move import to Trash
          </Button>
        )}
        <Button variant="ghost-secondary" size="icon" onClick={onClose} aria-label="Close import summary">
          <CloseIcon />
        </Button>
      </div>
      {q.isLoading && <Skeleton className="h-24 w-full rounded-lg" />}
      {q.error && <p className="text-sm text-muted-foreground">{String((q.error as Error).message)}</p>}
      {s && (
        <>
          <dl className="mb-5 grid max-w-lg grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Files</dt>
            <dd className="tnum">{s.totals.files.toLocaleString()} · {formatBytes(s.totals.bytes)}</dd>
            <dt className="text-muted-foreground">Added</dt>
            <dd className="tnum">{(s.totals.byState.uploaded ?? 0).toLocaleString()}</dd>
            {(s.totals.byState.skipped_duplicate ?? 0) > 0 && (
              <>
                <dt className="text-muted-foreground">Already here</dt>
                <dd className="tnum">{s.totals.byState.skipped_duplicate!.toLocaleString()}</dd>
              </>
            )}
            {bad(s) > 0 && (
              <>
                <dt className="text-muted-foreground">Didn't upload</dt>
                <dd className="tnum text-danger">{bad(s).toLocaleString()}</dd>
              </>
            )}
            {(s.totals.skippedSystemFiles ?? 0) > 0 && (
              <>
                <dt className="text-muted-foreground">System files skipped</dt>
                <dd className="tnum">{s.totals.skippedSystemFiles}</dd>
              </>
            )}
          </dl>
          {s.error && <p className="mb-4 text-sm text-danger">{s.error}</p>}
          {s.files && s.files.length > 0 && (
            <ul className="max-w-3xl divide-y divide-border rounded-lg border border-border text-sm" data-testid="import-files">
              {s.files.map((f) => (
                <li key={f.clientFileId} className="flex items-center gap-3 px-3 py-1.5">
                  {f.state === "failed" || f.state === "rejected" ? <ErrorIcon className="size-3.5 shrink-0 text-danger" /> : f.state === "pending" ? <QueuedIcon className="size-3.5 shrink-0 text-hint" /> : <DoneIcon className="size-3.5 shrink-0 text-positive" />}
                  <span className="min-w-0 flex-1 truncate" title={f.relPath}>{f.relPath}</span>
                  <span className={cn("shrink-0 text-xs", f.state === "failed" || f.state === "rejected" ? "text-danger" : "text-muted-foreground")}>{f.reason ?? FILE_STATE[f.state]}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
