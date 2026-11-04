import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CloseIcon, ErrorIcon, WarningIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";
import { guessKind, kindIcon } from "@/studio/lib/file-kinds";
import { formatBytes } from "@/studio/lib/format";
import { filesUrl } from "@/studio/lib/routes";
import { fromFileList } from "@/studio/lib/uploads/walk";
import { dropsApi } from "./api";
import { dropKeys, useDropChips, useDropEvents, type Chip } from "./hooks";
import { dropCounts, dropHeadline, waitingText, type ChipState, type DropProgressSummary } from "./progress";
import { failureText, useUploads } from "@/studio/stores/uploads";
import { findingLine, renamedExample } from "@/studio/lib/findings";
import { dismissDrop, resumeDrop } from "./start";
import { useDrops } from "./store";

/**
 * A drop's card (todo13 §3.2): one chip per file with its live state (uploading, checking, ready,
 * kept, failed, "Already in Sources", "Deleted file") and, for images the person dropped in this
 * browser, a thumbnail from their own file. In a sent message a file can be removed from the
 * chat (the reference only: the File stays in Files, D4). After a reload an unfinished drop asks
 * for the same files again and resumes from the server's offset.
 *
 * todo28 D8: the headline comes from counts ("12 in the Studio · 22 checking · 1 kept in
 * Sources"), never one "Checking" for the whole drop; a file that retries or waits for its kind
 * says so, and while the rights dialog is open the card says "Waiting for you to confirm".
 */

const STATE_TEXT: Record<ChipState, string> = {
  confirming: "Waiting for you to confirm",
  preparing: "Preparing",
  uploading: "Uploading",
  checking: "Checking",
  ready: "Ready",
  in_studio: "In the Studio",
  waiting_kind: "Waiting for the assistant",
  kept: "Kept in Sources",
  held: "Held for a privacy check",
  failed: "Didn't upload",
  duplicate: "Already in Sources",
  removed: "Removed from chat",
  deleted: "Deleted file",
};

const MAX_CHIPS = 12;

export interface DropCardProps {
  dropId: string;
  projectId: string;
  /** `composer`: before send (cancel); `message`: in the thread (remove a file from the chat). */
  variant?: "composer" | "message";
  onCancel?: () => void;
  /** The person may change this chat's files (not a viewer). */
  canEdit?: boolean;
}

export function DropCard({ dropId, projectId, variant = "message", onCancel, canEdit = true }: DropCardProps) {
  useDropEvents(projectId);
  const { local, server, trays, chips: raw, interrupted, missing } = useDropChips(dropId);
  // todo26 W2d: the rights dialog for this project is open: the files wait on the person.
  const confirming = useUploads((s) => s.attestation?.projectId === projectId);
  const chips = confirming ? raw.map((c) => (c.state === "preparing" ? { ...c, state: "confirming" as const } : c)) : raw;
  const dismissed = useDrops((s) => !!s.dismissed[dropId]);
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const paused = !!local && trays.length === 0 && local.uploadKeys.length === 0 && chips.some((c) => c.state === "uploading");
  const shown = showAll ? chips : chips.slice(0, MAX_CHIPS);
  const total = chips.reduce((n, c) => n + c.size, 0);
  const overall = interrupted ? "interrupted" : local?.error ? "failed" : paused ? "paused" : summaryState(chips);
  const headline = overall === "interrupted" || overall === "paused" || (overall === "failed" && local?.error) ? OVERALL_TEXT[overall] : dropHeadline(dropCounts(chips, server?.summary as DropProgressSummary | undefined));
  const again = (list: FileList) => {
    if (local) void resumeDrop(local, fromFileList(list));
  };
  const remove = async (nodeId: string) => {
    await dropsApi.removeFromChat(dropId, nodeId).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: dropKeys.drop(dropId) });
    void qc.invalidateQueries({ queryKey: ["drops", "list", projectId] });
  };

  if (dismissed || missing) return null;
  if (!local && !server) return <div className="h-14 animate-pulse rounded-xl bg-generic" data-testid="drop-card" data-drop-id={dropId} data-state="loading" />;
  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border border-border bg-background p-2.5", variant === "composer" && "bg-float")} data-testid="drop-card" data-drop-id={dropId} data-state={overall}>
      <div className="flex items-center gap-2 px-0.5 text-caption text-hint">
        <span className="min-w-0 flex-1 truncate" data-testid="drop-card-summary">
          {chips.length.toLocaleString()} {chips.length === 1 ? "file" : "files"}
          {total ? ` · ${formatBytes(total)}` : ""} · {headline}
        </span>
        {variant === "composer" && onCancel && (
          <Button variant="ghost-secondary" size="icon-xs" onClick={onCancel} aria-label="Remove these files" data-testid="drop-cancel">
            <CloseIcon />
          </Button>
        )}
      </div>
      {interrupted && local && !local.overLimit && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-generic px-2.5 py-2 text-caption" data-testid="drop-error" data-interrupted="true">
          <ErrorIcon className="size-3.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1" data-testid="drop-error-text">{failureText(local.error, [])}</span>
          <span className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => picker.current?.click()} data-testid="drop-again">Drop again</Button>
            <Button size="sm" variant="ghost-secondary" onClick={() => void dismissDrop(dropId)} data-testid="drop-dismiss">Dismiss</Button>
          </span>
        </div>
      )}
      {local?.error && local.overLimit && (
        <p className="flex items-start gap-1.5 px-0.5 text-caption text-danger" data-testid="drop-over-limit">
          <ErrorIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {local.error} <Link to={filesUrl(projectId)} className="text-brand hover:underline">Open Sources</Link>
          </span>
        </p>
      )}
      {local?.error && !local.overLimit && !interrupted && (
        <p className="flex items-start gap-1.5 px-0.5 text-caption text-danger" data-testid="drop-error">
          <ErrorIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{local.retryAt ? <RetryCountdown at={local.retryAt} /> : failureText(local.error, [])}</span>
        </p>
      )}
      {server?.state === "failed" && server.failure && !local?.error && (
        <p className="flex items-start gap-1.5 px-0.5 text-caption text-danger" data-testid="drop-failure">
          <ErrorIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{server.failure.reason}</span>
        </p>
      )}
      {!!server?.findings?.length && (
        // todo20 D8: one line per rule with a count, never one per file; a fixed name shown once.
        <ul className="flex flex-col gap-1 px-0.5 text-caption" data-testid="drop-findings">
          {server.findings.map((g) => {
            const example = g.outcome === "renamed" ? renamedExample(g) : undefined;
            return (
              <li key={`${g.rule}:${g.outcome}`} className={cn("flex items-start gap-1.5", g.outcome === "refused" ? "text-danger" : "text-hint")} data-testid="drop-finding" data-rule={g.rule} data-outcome={g.outcome} data-count={g.count}>
                {g.outcome === "refused" ? <ErrorIcon className="mt-0.5 size-3.5 shrink-0" /> : <WarningIcon className="mt-0.5 size-3.5 shrink-0" />}
                <span>
                  {findingLine(g)}
                  {example ? ` (${example})` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {paused && local && (
        <div className="flex items-center gap-2 rounded-lg bg-generic px-2.5 py-2 text-caption" data-testid="drop-paused">
          <WarningIcon className="size-3.5 shrink-0 text-warning" />
          <span className="flex-1">Upload paused: choose the same files to continue.</span>
          <Button size="sm" variant="outline" onClick={() => picker.current?.click()} data-testid="drop-resume">Choose files</Button>
        </div>
      )}
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        data-testid="drop-resume-input"
        onChange={(e) => {
          if (e.target.files?.length) again(e.target.files);
          e.target.value = "";
        }}
      />
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-1.5">
        {shown.map((c) => (
          <DropChip key={c.key} chip={c} onRemove={variant === "message" && canEdit && c.nodeId && c.state !== "removed" && c.state !== "deleted" ? () => void remove(c.nodeId!) : undefined} />
        ))}
      </ul>
      {chips.length > MAX_CHIPS && !showAll && (
        <button type="button" className="self-start px-0.5 text-caption text-brand hover:underline" onClick={() => setShowAll(true)}>
          Show {chips.length - MAX_CHIPS} more
        </button>
      )}
    </div>
  );
}

/** The headline when the drop as a whole stopped (otherwise it's the counts, `dropHeadline`). */
const OVERALL_TEXT: Record<string, string> = {
  failed: "Some files didn't upload",
  interrupted: "Not uploaded",
  paused: "Paused",
};

/**
 * The card's `data-state`: where the drop stands as a whole, for tests and styling. Never
 * "checking" once a file is ready: a drop with ready files is `filling`.
 */
export function summaryState(chips: Pick<Chip, "state">[]): string {
  if (!chips.length) return "empty";
  if (chips.some((c) => c.state === "confirming")) return "confirming";
  const ready = chips.some((c) => c.state === "ready" || c.state === "in_studio" || c.state === "waiting_kind");
  const moving = chips.some((c) => c.state === "preparing" || c.state === "uploading" || c.state === "checking");
  if (ready && moving) return "filling";
  if (chips.some((c) => c.state === "preparing")) return "preparing";
  if (chips.some((c) => c.state === "uploading")) return "uploading";
  if (chips.some((c) => c.state === "checking")) return "checking";
  if (chips.every((c) => c.state === "failed")) return "failed";
  return "ready";
}

/** What one chip says under its name (todo28: retrying and waiting-for-a-kind files say so). */
export function chipText(chip: Pick<Chip, "state" | "progress" | "reason" | "retrying" | "kind">): string {
  if (chip.state === "uploading" && chip.progress !== undefined) return `${Math.round(chip.progress * 100)}%`;
  if (chip.state === "failed" && chip.reason) return chip.reason;
  if (chip.state === "checking" && chip.retrying) return "Still checking (retrying)";
  if (chip.state === "waiting_kind") return waitingText(chip.kind);
  return STATE_TEXT[chip.state];
}

function DropChip({ chip, onRemove }: { chip: Chip; onRemove?: () => void }) {
  const Icon = kindIcon(chip.kind ?? guessKind(chip.name));
  const gone = chip.state === "deleted" || chip.state === "removed";
  const [broken, setBroken] = useState(false);
  // A local preview only for what really is an image (a `.png` that's a ZIP gets its kind's icon).
  const preview = chip.preview && !gone && !broken && !chip.looksLike && (!chip.kind || chip.kind === "image") ? chip.preview : undefined;
  const text = chipText(chip);
  return (
    <li className={cn("group relative flex min-w-0 items-center gap-2 rounded-lg bg-generic p-1.5 pr-2", gone && "opacity-60")} data-testid="drop-chip" data-state={chip.state} data-retrying={chip.retrying ? "true" : undefined} data-node-id={chip.nodeId ?? undefined}>
      <span className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background text-hint">
        {preview ? <img src={preview} alt="" className="size-full object-cover" onError={() => setBroken(true)} /> : <Icon className="size-4" />}
        {chip.state === "uploading" && chip.progress !== undefined && (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-brand" style={{ width: `${Math.round(chip.progress * 100)}%` }} aria-hidden />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-caption", chip.state === "deleted" && "line-through")} title={chip.name}>
          {chip.state === "deleted" ? "Deleted file" : chip.name}
        </span>
        <span className={cn("truncate text-caption text-hint", chip.state === "failed" && "text-danger")} data-testid="drop-chip-state">
          {chip.looksLike ? `Looks like ${chip.looksLike}` : text}
        </span>
      </span>
      {onRemove && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onRemove}
              className="absolute -top-1.5 -right-1.5 hidden size-5 items-center justify-center rounded-full bg-background text-hint shadow-float group-hover:flex hover:text-foreground focus-visible:flex"
              aria-label={`Remove ${chip.name} from the chat`}
              data-testid="drop-chip-remove"
            >
              <CloseIcon className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Remove from chat (stays in Sources)</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

/** "Too many drops at once. Try again in 12 s" (a 429's `Retry-After`, todo18). */
export function retryLine(at: number, now: number): string {
  const s = Math.max(0, Math.ceil((at - now) / 1000));
  return s ? `Too many drops at once. Try again in ${s} s` : "Too many drops at once. Try again now";
}

function RetryCountdown({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= at) return;
    const t = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(t);
  }, [now, at]);
  return <span data-testid="drop-retry-countdown">{retryLine(at, now)}</span>;
}
