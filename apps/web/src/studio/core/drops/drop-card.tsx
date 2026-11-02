import { useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CloseIcon, ErrorIcon, WarningIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";
import type { DropFileState } from "@studio/contracts/drops";
import { guessKind, kindIcon } from "@/studio/lib/file-kinds";
import { formatBytes } from "@/studio/lib/format";
import { filesUrl } from "@/studio/lib/routes";
import { fromFileList } from "@/studio/lib/uploads/walk";
import { dropsApi } from "./api";
import { dropKeys, useDropChips, useDropEvents, type Chip } from "./hooks";
import { resumeDrop } from "./start";

/**
 * A drop's card (todo13 §3.2): one chip per file with its live state (uploading, checking, ready,
 * kept, failed, "Already in Sources", "Deleted file") and, for images the person dropped in this
 * browser, a thumbnail from their own file. In a sent message a file can be removed from the
 * chat (the reference only: the File stays in Files, D4). After a reload an unfinished drop asks
 * for the same files again and resumes from the server's offset.
 */

const STATE_TEXT: Record<DropFileState | "preparing", string> = {
  preparing: "Preparing",
  uploading: "Uploading",
  checking: "Checking",
  ready: "Ready",
  kept: "Kept in Sources",
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
  const { local, server, trays, chips } = useDropChips(dropId);
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const paused = !!local && trays.length === 0 && local.uploadKeys.length === 0 && chips.some((c) => c.state === "uploading");
  const shown = showAll ? chips : chips.slice(0, MAX_CHIPS);
  const total = chips.reduce((n, c) => n + c.size, 0);
  const overall = local?.error ? "failed" : paused ? "paused" : summaryState(chips);
  const remove = async (nodeId: string) => {
    await dropsApi.removeFromChat(dropId, nodeId).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: dropKeys.drop(dropId) });
    void qc.invalidateQueries({ queryKey: ["drops", "list", projectId] });
  };

  if (!local && !server) return <div className="h-14 animate-pulse rounded-xl bg-generic" data-testid="drop-card" data-drop-id={dropId} data-state="loading" />;
  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border border-border bg-background p-2.5", variant === "composer" && "bg-float")} data-testid="drop-card" data-drop-id={dropId} data-state={overall}>
      <div className="flex items-center gap-2 px-0.5 text-caption text-hint">
        <span className="min-w-0 flex-1 truncate" data-testid="drop-card-summary">
          {chips.length.toLocaleString()} {chips.length === 1 ? "file" : "files"}
          {total ? ` · ${formatBytes(total)}` : ""} · {OVERALL_TEXT[overall]}
        </span>
        {variant === "composer" && onCancel && (
          <Button variant="ghost-secondary" size="icon-xs" onClick={onCancel} aria-label="Remove these files" data-testid="drop-cancel">
            <CloseIcon />
          </Button>
        )}
      </div>
      {local?.error && (
        <p className="flex items-start gap-1.5 px-0.5 text-caption text-danger" data-testid={local.overLimit ? "drop-over-limit" : "drop-error"}>
          <ErrorIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {local.error}
            {local.overLimit && (
              <>
                {" "}
                <Link to={filesUrl(projectId)} className="text-brand hover:underline">Open Sources</Link>
              </>
            )}
          </span>
        </p>
      )}
      {paused && local && (
        <div className="flex items-center gap-2 rounded-lg bg-generic px-2.5 py-2 text-caption" data-testid="drop-paused">
          <WarningIcon className="size-3.5 shrink-0 text-warning" />
          <span className="flex-1">Upload paused: choose the same files to continue.</span>
          <Button size="sm" variant="outline" onClick={() => picker.current?.click()} data-testid="drop-resume">Choose files</Button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            data-testid="drop-resume-input"
            onChange={(e) => {
              if (e.target.files?.length) resumeDrop(local, fromFileList(e.target.files));
              e.target.value = "";
            }}
          />
        </div>
      )}
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

const OVERALL_TEXT: Record<string, string> = {
  preparing: "Preparing",
  uploading: "Uploading",
  checking: "Checking",
  ready: "Ready",
  failed: "Some files didn't upload",
  paused: "Paused",
  empty: "Nothing to share",
};

function summaryState(chips: Chip[]): string {
  if (!chips.length) return "empty";
  if (chips.some((c) => c.state === "preparing")) return "preparing";
  if (chips.some((c) => c.state === "uploading")) return "uploading";
  if (chips.some((c) => c.state === "checking")) return "checking";
  if (chips.every((c) => c.state === "failed")) return "failed";
  return "ready";
}

function DropChip({ chip, onRemove }: { chip: Chip; onRemove?: () => void }) {
  const Icon = kindIcon(chip.kind ?? guessKind(chip.name));
  const gone = chip.state === "deleted" || chip.state === "removed";
  const [broken, setBroken] = useState(false);
  // A local preview only for what really is an image (a `.png` that's a ZIP gets its kind's icon).
  const preview = chip.preview && !gone && !broken && !chip.looksLike && (!chip.kind || chip.kind === "image") ? chip.preview : undefined;
  const text = chip.state === "uploading" && chip.progress !== undefined ? `${Math.round(chip.progress * 100)}%` : chip.state === "failed" && chip.reason ? chip.reason : STATE_TEXT[chip.state];
  return (
    <li className={cn("group relative flex min-w-0 items-center gap-2 rounded-lg bg-generic p-1.5 pr-2", gone && "opacity-60")} data-testid="drop-chip" data-state={chip.state} data-node-id={chip.nodeId ?? undefined}>
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
