import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloseIcon, ErrorIcon, RetryIcon } from "@studio/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@studio/ui/ui/popover";
import { Spinner } from "@studio/ui/ui/spinner";
import { cn } from "@studio/ui/utils";
import { guessKind, kindIcon } from "@/studio/lib/file-kinds";
import { fromFileList } from "@/studio/lib/uploads/walk";
import { useUploads } from "@/studio/stores/uploads";
import { dropsApi } from "./api";
import { dropKeys, useDropChips, useDropEvents, type Chip } from "./hooks";
import type { ChipState } from "./progress";
import { resumeDrop } from "./start";
import { useDrops } from "./store";

/**
 * todo29 D2: a drop in the chat is a row of attachment tiles, like the chat apps people know.
 * One look per file: `loading` (a small ring in the corner: upload and check alike), `done`
 * (plain) or `failed` (a red corner badge; tap says why in one line, with Retry and Remove where
 * they apply). No state words, no headline of counts: the per-file states stay in the data (they
 * drive routing) and in Sources › Imports (`DropCard`).
 */

export type TileState = "loading" | "done" | "failed";

/** Every chip state's look; `removed` is hidden (`null`). */
const TILE: Record<ChipState, TileState | null> = {
  confirming: "loading",
  preparing: "loading",
  uploading: "loading",
  checking: "loading",
  ready: "done",
  in_studio: "done",
  kept: "done",
  duplicate: "done",
  waiting_kind: "done",
  failed: "failed",
  held: "failed",
  deleted: "failed",
  removed: null,
};

export function tileState(state: ChipState): TileState | null {
  return state in TILE ? TILE[state] : "loading";
}

/** A failed tile's one line. */
export function tileReason(chip: Pick<Chip, "state" | "reason">): string {
  if (chip.state === "held") return "Held for a privacy check";
  if (chip.state === "deleted") return "This file was deleted";
  return chip.reason?.trim() || "Couldn't read this file";
}

/** More than this many tiles collapse into "+N". */
export const MAX_TILES = 8;

/** The tiles shown and how many are folded into "+N". */
export function visibleTiles<T>(tiles: T[], expanded: boolean): { shown: T[]; more: number } {
  if (expanded || tiles.length <= MAX_TILES) return { shown: tiles, more: 0 };
  return { shown: tiles.slice(0, MAX_TILES - 1), more: tiles.length - (MAX_TILES - 1) };
}

export interface AttachmentTilesProps {
  dropId: string;
  projectId: string;
  /** `composer`: before send (× removes the files); `message`: in the thread (Remove from chat). */
  variant: "composer" | "message";
  /** The composer's "remove these files" (the whole pending drop). */
  onCancel?: () => void;
  /** The person may change this chat's files (not a viewer). */
  canEdit?: boolean;
  className?: string;
}

export function AttachmentTiles({ dropId, projectId, variant, onCancel, canEdit = true, className }: AttachmentTilesProps) {
  useDropEvents(projectId);
  const { local, trays, chips, missing } = useDropChips(dropId);
  const dismissed = useDrops((s) => !!s.dismissed[dropId]);
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const tiles = chips.flatMap((c) => {
    const look = tileState(c.state);
    return look ? [{ chip: c, look }] : [];
  });
  const { shown, more } = visibleTiles(tiles, expanded);

  const remove = async (nodeId: string) => {
    await dropsApi.removeFromChat(dropId, nodeId).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: dropKeys.drop(dropId) });
    void qc.invalidateQueries({ queryKey: ["drops", "list", projectId] });
  };
  // Retry: a failed upload session goes again; a drop whose files are gone asks for them again.
  const failedTray = trays.find((t) => t.phase === "failed");
  const retry = () => {
    if (failedTray) void useUploads.getState().retry(failedTray.key);
    else if (local) picker.current?.click();
  };

  if (dismissed || missing) return null;
  if (!local && !chips.length) return <div className="h-14 w-10 animate-pulse rounded-lg bg-generic" data-testid="attachment-tiles" data-drop-id={dropId} data-state="loading" />;
  return (
    <div className={cn("flex flex-wrap items-start gap-2", variant === "message" && "justify-end", className)} data-testid="attachment-tiles" data-drop-id={dropId} data-variant={variant}>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        data-testid="drop-resume-input"
        onChange={(e) => {
          if (e.target.files?.length && local) void resumeDrop(local, fromFileList(e.target.files));
          e.target.value = "";
        }}
      />
      {shown.map(({ chip, look }) => (
        <Tile
          key={chip.key}
          chip={chip}
          look={look}
          onRetry={look === "failed" && chip.state !== "held" && chip.state !== "deleted" && (failedTray || local) ? retry : undefined}
          onRemove={variant === "message" && canEdit && chip.nodeId && chip.state !== "deleted" ? () => void remove(chip.nodeId!) : undefined}
        />
      ))}
      {more > 0 && (
        <button type="button" className="flex size-10 items-center justify-center rounded-lg bg-generic text-caption font-medium text-muted-foreground hover:text-foreground" onClick={() => setExpanded(true)} data-testid="attachment-more">
          +{more}
        </button>
      )}
      {variant === "composer" && onCancel && (
        <button type="button" onClick={onCancel} className="flex size-10 items-center justify-center rounded-lg text-hint hover:bg-generic hover:text-foreground" aria-label="Remove these files" data-testid="drop-cancel">
          <CloseIcon className="size-4" />
        </button>
      )}
    </div>
  );
}

function Tile({ chip, look, onRetry, onRemove }: { chip: Chip; look: TileState; onRetry?: () => void; onRemove?: () => void }) {
  const Icon = kindIcon(chip.kind ?? guessKind(chip.name));
  const [broken, setBroken] = useState(false);
  // A local preview only for what really is an image (a `.png` that's a ZIP gets its kind's icon), as `DropCard`.
  const preview = chip.preview && !broken && !chip.looksLike && chip.state !== "deleted" && (!chip.kind || chip.kind === "image") ? chip.preview : undefined;
  const face = (
    <span className={cn("relative flex size-10 items-center justify-center overflow-hidden rounded-lg border bg-background text-hint", look === "failed" ? "border-danger" : "border-border")}>
      {preview ? <img src={preview} alt="" className="size-full object-cover" onError={() => setBroken(true)} /> : <Icon className="size-4" />}
    </span>
  );
  return (
    <div className="group relative flex w-14 flex-col items-center gap-1" data-testid="attachment-tile" data-state={look} data-file-state={chip.state} data-node-id={chip.nodeId ?? undefined} title={look === "failed" ? undefined : chip.name}>
      {look === "failed" ? (
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${chip.name}: ${tileReason(chip)}`} title={tileReason(chip)} data-testid="attachment-tile-open">
              {face}
            </button>
          </PopoverTrigger>
          <PopoverContent className="flex w-60 flex-col gap-2 p-3 text-caption" data-testid="attachment-tile-reason">
            <span className="truncate font-medium">{chip.name}</span>
            <span className="text-danger">{tileReason(chip)}</span>
            {(onRetry || onRemove) && (
              <span className="flex gap-2">
                {onRetry && (
                  <button type="button" onClick={onRetry} className="flex items-center gap-1 text-brand hover:underline" data-testid="attachment-tile-retry">
                    <RetryIcon className="size-3.5" /> Retry
                  </button>
                )}
                {onRemove && (
                  <button type="button" onClick={onRemove} className="flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline" data-testid="attachment-tile-remove">
                    <CloseIcon className="size-3.5" /> Remove
                  </button>
                )}
              </span>
            )}
          </PopoverContent>
        </Popover>
      ) : (
        face
      )}
      {look === "loading" && (
        <span className="absolute -top-1 right-1 flex size-4 items-center justify-center rounded-full bg-background shadow-float" data-testid="attachment-tile-loading">
          <Spinner className="size-3 text-brand" />
        </span>
      )}
      {look === "failed" && (
        <span className="pointer-events-none absolute -top-1 right-1 flex size-4 items-center justify-center rounded-full bg-danger text-primary-foreground" aria-hidden>
          <ErrorIcon className="size-3" />
        </span>
      )}
      {onRemove && look !== "failed" && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -top-1.5 left-0.5 hidden size-4 items-center justify-center rounded-full bg-background text-hint shadow-float group-hover:flex hover:text-foreground focus-visible:flex"
          aria-label={`Remove ${chip.name} from the chat`}
          data-testid="attachment-tile-remove"
        >
          <CloseIcon className="size-3" />
        </button>
      )}
      <span className="w-full truncate text-center text-caption text-hint">{chip.name}</span>
    </div>
  );
}
