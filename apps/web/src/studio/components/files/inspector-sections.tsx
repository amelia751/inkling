import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { FsActivityEntry, NodeVersion, SourceNode } from "@studio/contracts/types";
import { DownloadIcon, HideIcon, RenameIcon, RestoreIcon, ShowIcon, UploadIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Input } from "@studio/ui/ui/input";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { KINDS, nodeKind } from "@/studio/lib/file-kinds";
import { formatBytes } from "@/studio/lib/format";
import { extensionOf, fullDate, plural, ReasonButton, relativeTime, stemEnd } from "./shared";

/**
 * Inspector pieces for Files (todo7 Phases 2, 6 and 7): the title with its Rename pencil,
 * Versions, Activity, the hidden original name, and the summary shown when several items are
 * selected. Same section look as today's inspector (uppercase hint heading, 14px body).
 */

function Section({ title, children, testid, action }: { title: string; children: ReactNode; testid?: string; action?: ReactNode }) {
  return (
    <section data-testid={testid}>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-hint">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---- Rename ---------------------------------------------------------------------------------------

export interface RenameableTitleProps {
  name: string;
  /** Shown instead of `name` when not editing (a compact chain: "MRI / patient_002"). */
  displayName?: string;
  kind: SourceNode["kind"];
  /** Set: the pencil is inert with this reason ("Sample data can't be changed…", "Needs the full stack"). */
  disabledReason?: string | null;
  /** Live check (D10): the sentence to show under the field, or null. Runs on the trimmed name. */
  validate?: (name: string) => string | null;
  /** Advice that never blocks (Windows-reserved, a person's name), shown when there's no error. */
  warn?: (name: string) => string | null;
  /** Saves the trimmed name. Reject with an Error to keep the field open with its message. */
  onRename: (name: string) => void | Promise<void>;
  /** Controlled editing (F2 or Enter-on-name from the page); uncontrolled when left out. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}

/** The stem's range (Finder selects the name without its extension); a folder is all name. */
export function stemRange(name: string, kind: SourceNode["kind"]): [number, number] {
  return [0, stemEnd(name, kind === "folder" ? "folder" : "file")];
}

/** The two extensions when a rename changes a file's extension (D10 asks first), else null. */
export function extensionChange(from: string, to: string, kind: SourceNode["kind"]): { from: string; to: string } | null {
  if (kind !== "file") return null;
  const a = extensionOf(from);
  const b = extensionOf(to);
  return a !== b ? { from: a, to: b } : null;
}

/**
 * The inspector title with a Rename pencil. Editing selects the stem; Enter saves, Esc cancels,
 * blur saves (or cancels when the name is invalid). An extension change asks first ("The file's
 * content won't change"). The error sits under the field.
 */
export function RenameableTitle({ name, displayName, kind, disabledReason, validate, warn, onRename, editing: editingProp, onEditingChange }: RenameableTitleProps) {
  const [own, setOwn] = useState(false);
  const editing = editingProp ?? own;
  const setEditing = (v: boolean) => {
    if (editingProp === undefined) setOwn(v);
    onEditingChange?.(v);
  };
  const [value, setValue] = useState(name);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmExt, setConfirmExt] = useState<{ from: string; to: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const errId = useId();

  useEffect(() => {
    if (!editing) return;
    setValue(name);
    setServerError(null);
    setConfirmExt(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(...stemRange(name, kind));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on entering edit mode
  }, [editing]);

  const trimmed = value.replace(/[ .]+$/, "").trim();
  const problem = !trimmed ? "A name can't be empty" : (validate?.(trimmed) ?? null);
  const error = serverError ?? (trimmed !== name ? problem : null);
  const warning = !error && trimmed && trimmed !== name ? (warn?.(trimmed) ?? null) : null;

  const cancel = () => {
    setConfirmExt(null);
    setEditing(false);
  };
  const save = async (confirmed = false) => {
    if (saving) return;
    if (trimmed === name) return cancel();
    if (problem) return;
    const ext = extensionChange(name, trimmed, kind);
    if (ext && !confirmed) return setConfirmExt(ext);
    setSaving(true);
    try {
      await onRename(trimmed);
      setEditing(false);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Couldn't rename it");
      setConfirmExt(null);
      input.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  if (!editing)
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <h2 className="min-w-0 truncate text-sm font-semibold" title={displayName ?? name} data-testid="inspector-title">
          {displayName ?? name}
        </h2>
        <ReasonButton variant="ghost-secondary" size="icon-sm" reason={disabledReason} tip="Rename" aria-label="Rename" onClick={() => setEditing(true)} data-testid="inspector-rename">
          <RenameIcon />
        </ReasonButton>
      </div>
    );

  return (
    <div className="min-w-0 flex-1 py-1">
      <Input
        ref={input}
        value={value}
        inputSize="sm"
        disabled={saving}
        aria-label={kind === "folder" ? "Folder name" : "File name"}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? errId : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setServerError(null);
          setConfirmExt(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save(!!confirmExt);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          }
        }}
        onBlur={(e) => {
          // Moving to the extension confirmation keeps the field open.
          if (confirmExt || (e.relatedTarget instanceof Node && e.currentTarget.parentElement?.contains(e.relatedTarget))) return;
          if (problem && trimmed !== name) cancel();
          else void save();
        }}
        className="font-semibold"
        data-testid="inspector-rename-input"
      />
      {error && (
        <p id={errId} className="mt-1 text-xs text-danger" data-testid="rename-error">
          {error}
        </p>
      )}
      {warning && (
        <p role="status" className="mt-1 text-xs text-warning" data-testid="rename-warning">
          {warning}
        </p>
      )}
      {confirmExt && (
        <div className="mt-1.5 space-y-1.5 text-xs" data-testid="rename-extension-confirm">
          <p>
            Change the extension from <b>{confirmExt.from || "none"}</b> to <b>{confirmExt.to || "none"}</b>? The file's content won't change.
          </p>
          <div className="flex gap-1.5">
            <Button size="xs" onMouseDown={(e) => e.preventDefault()} onClick={() => void save(true)} data-testid="rename-extension-yes">
              Use {confirmExt.to || "no extension"}
            </Button>
            <Button size="xs" variant="outline" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
              Keep {confirmExt.from || "no extension"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Versions -------------------------------------------------------------------------------------

export interface VersionsSectionProps {
  versions: NodeVersion[];
  loading?: boolean;
  onRestore?: (version: number) => void;
  onDownload?: (version: number) => void;
  /** Opens the file picker for "Replace with new version…" (D6). */
  onReplace?: () => void;
  /** Set: Replace and Restore are inert with this reason. */
  disabledReason?: string | null;
}

/** Version, who, when, size, a "Current" chip; Restore and Download per version; Replace below. */
export function VersionsSection({ versions, loading, onRestore, onDownload, onReplace, disabledReason }: VersionsSectionProps) {
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  return (
    <Section title="Versions" testid="inspector-versions">
      {loading && <Skeleton className="h-10 w-full" />}
      {!loading && sorted.length <= 1 && <p className="text-muted-foreground">Only the version as uploaded.</p>}
      {!loading && sorted.length > 1 && (
        <ul className="space-y-1">
          {sorted.map((v) => (
            <li key={v.version} className="flex min-w-0 items-center gap-2 rounded-md py-0.5" data-testid="version-row" data-version={v.version}>
              <span className="tnum w-7 shrink-0 font-semibold">v{v.version}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {v.createdBy} · <span title={fullDate(v.createdAt)}>{relativeTime(v.createdAt)}</span>
                </span>
                {v.size !== null && <span className="tnum block text-xs text-muted-foreground">{formatBytes(v.size)}</span>}
              </span>
              {v.current ? (
                <Badge theme="info" className="shrink-0">
                  Current
                </Badge>
              ) : (
                onRestore && (
                  <ReasonButton variant="ghost-secondary" size="icon-sm" reason={disabledReason} tip={`Restore v${v.version}`} aria-label={`Restore version ${v.version}`} onClick={() => onRestore(v.version)} data-testid="version-restore">
                    <RestoreIcon />
                  </ReasonButton>
                )
              )}
              {onDownload && (
                <ReasonButton variant="ghost-secondary" size="icon-sm" tip={`Download v${v.version}`} aria-label={`Download version ${v.version}`} onClick={() => onDownload(v.version)} data-testid="version-download">
                  <DownloadIcon />
                </ReasonButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {onReplace && (
        <ReasonButton variant="outline" size="sm" className="mt-2" reason={disabledReason} onClick={onReplace} data-testid="version-replace">
          <UploadIcon /> Replace with new version…
        </ReasonButton>
      )}
    </Section>
  );
}

// ---- Activity -------------------------------------------------------------------------------------

export interface ActivitySectionProps {
  items: FsActivityEntry[];
  loading?: boolean;
  /** Rows shown before "Show all" (default 6). */
  limit?: number;
}

/** "Renamed from Smith_J_MRI · Lam · 2 h ago", newest first. */
export function ActivitySection({ items, loading, limit = 6 }: ActivitySectionProps) {
  const [all, setAll] = useState(false);
  const sorted = [...items].sort((a, b) => b.at.localeCompare(a.at));
  const shown = all ? sorted : sorted.slice(0, limit);
  if (!loading && !items.length) return null;
  return (
    <Section title="Activity" testid="inspector-activity">
      {loading && <Skeleton className="h-8 w-full" />}
      <ul className="space-y-1.5">
        {shown.map((a) => (
          <li key={a.id} className="min-w-0" data-testid="activity-row" data-kind={a.kind}>
            <p className="break-words">{a.text}</p>
            <p className="text-xs text-muted-foreground">
              {a.actor} · <span title={fullDate(a.at)}>{relativeTime(a.at)}</span>
            </p>
          </li>
        ))}
      </ul>
      {sorted.length > limit && (
        <Button variant="link" size="xs" className="mt-1 px-0" onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : `Show all ${sorted.length}`}
        </Button>
      )}
    </Section>
  );
}

// ---- Original name ---------------------------------------------------------------------------------

export interface OriginalNameRevealProps {
  /** The path as uploaded (members only; sensitive, Phase 7). Nothing renders when it's missing. */
  originalPath: string | null | undefined;
}

/** "Uploaded as …", behind a "Show original name" button: original names may hold identifiers. Hidden again when the node changes. */
export function OriginalNameReveal({ originalPath }: OriginalNameRevealProps) {
  const [shown, setShown] = useState(false);
  useEffect(() => setShown(false), [originalPath]);
  if (!originalPath) return null;
  return (
    <div className="text-sm" data-testid="original-name">
      {shown ? (
        <div className="flex min-w-0 items-start gap-1">
          <p className="min-w-0 flex-1 break-all">
            <span className="text-muted-foreground">Uploaded as </span>
            <span data-testid="original-name-value">{originalPath}</span>
          </p>
          <Button variant="ghost-secondary" size="icon-xs" aria-label="Hide original name" onClick={() => setShown(false)}>
            <HideIcon />
          </Button>
        </div>
      ) : (
        <Button variant="link" size="xs" className="px-0" onClick={() => setShown(true)} data-testid="original-name-show">
          <ShowIcon /> Show original name
        </Button>
      )}
    </div>
  );
}

// ---- Several selected ------------------------------------------------------------------------------

/** Count, bytes (file sizes, folder totals) and distinct kinds of a selection. */
export function summarize(items: SourceNode[]): { count: number; bytes: number; kinds: number } {
  let bytes = 0;
  const kinds = new Set<string>();
  for (const n of items) {
    bytes += n.kind === "folder" ? (n.totalBytes ?? 0) : (n.size ?? 0);
    kinds.add(nodeKind(n));
  }
  return { count: items.length, bytes, kinds: kinds.size };
}

export interface MultiSummaryProps {
  items: SourceNode[];
}

/** "12 items · 1.4 GB · 3 kinds", then the kinds by count. */
export function MultiSummary({ items }: MultiSummaryProps) {
  const s = summarize(items);
  const byKind = new Map<string, number>();
  for (const n of items) {
    const k = KINDS[nodeKind(n)]?.plural ?? "Files";
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  const top = [...byKind].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return (
    <div className="space-y-2 text-sm" data-testid="multi-summary">
      <p className="font-semibold" data-testid="multi-summary-line">
        {[plural(s.count, "item"), s.bytes > 0 ? formatBytes(s.bytes) : null, plural(s.kinds, "kind")].filter(Boolean).join(" · ")}
      </p>
      <ul className="space-y-0.5 text-muted-foreground">
        {top.map(([k, c]) => (
          <li key={k} className="flex justify-between gap-2">
            <span className="truncate">{k}</span>
            <span className="tnum">{c.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
