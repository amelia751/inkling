import type { ReactNode } from "react";
import { CloseIcon, CopyIcon, DownloadIcon, MoveIcon, StarFillIcon, StarIcon, TrashIcon, type IconComponent } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { ReasonButton } from "./shared";

/**
 * The selection bar (todo7 §2, Drive): replaces the Files toolbar while anything is selected.
 * "3 selected" · Move to… · Copy · Download · Star · Move to Trash · ✕. An action that can't run
 * stays in place, inert, with its reason as the tooltip (locked sample data, "Needs the full
 * stack"). Same height as the toolbar (48px); on a phone the labels fold into icon buttons.
 */

export type SelectionAction = "move" | "copy" | "download" | "star" | "trash";

export interface SelectionBarProps {
  count: number;
  onMove: () => void;
  onCopy: () => void;
  onDownload: () => void;
  /** Stars every selected item, or (when `starred`) removes them from Starred. */
  onStar: () => void;
  onTrash: () => void;
  onClear: () => void;
  /** Every selected item is starred already: the button reads "Unstar". */
  starred?: boolean;
  /** A reason disables that action and becomes its tooltip. */
  disabled?: Partial<Record<SelectionAction, string | null>>;
  /** Extra controls at the end (e.g. Paste when the clipboard has something). */
  children?: ReactNode;
}

const ACTIONS: { id: SelectionAction; label: string; icon?: IconComponent; destructive?: boolean }[] = [
  { id: "move", label: "Move to…", icon: MoveIcon },
  { id: "copy", label: "Copy", icon: CopyIcon },
  { id: "download", label: "Download", icon: DownloadIcon },
  { id: "star", label: "Star", icon: StarIcon },
  { id: "trash", label: "Move to Trash", icon: TrashIcon, destructive: true },
];

export function SelectionBar({ count, onMove, onCopy, onDownload, onStar, onTrash, onClear, starred, disabled = {}, children }: SelectionBarProps) {
  const handlers: Record<SelectionAction, () => void> = { move: onMove, copy: onCopy, download: onDownload, star: onStar, trash: onTrash };
  return (
    <div role="toolbar" aria-label="Selection" className="flex min-h-12 min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-selection px-4 py-2" data-testid="selection-bar">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost-secondary" size="icon" onClick={onClear} aria-label="Clear selection" data-testid="selection-clear">
            <CloseIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Clear selection</TooltipContent>
      </Tooltip>
      <span className="tnum mr-2 text-sm font-semibold" data-testid="selection-count">
        {count.toLocaleString()} selected
      </span>
      {ACTIONS.map((a) => {
        const label = a.id === "star" && starred ? "Unstar" : a.label;
        const Icon = a.id === "star" && starred ? StarFillIcon : a.icon;
        const reason = disabled[a.id] ?? null;
        return (
          <ReasonButton
            key={a.id}
            variant="ghost"
            reason={reason}
            onClick={handlers[a.id]}
            aria-label={label}
            className={a.destructive && !reason ? "text-danger hover:text-danger" : undefined}
            data-testid={`selection-${a.id}`}
          >
            {Icon && <Icon aria-hidden />}
            <span className={Icon ? "hidden sm:inline" : undefined}>{label}</span>
          </ReasonButton>
        );
      })}
      {children && <div className="ml-auto flex items-center gap-1">{children}</div>}
    </div>
  );
}
