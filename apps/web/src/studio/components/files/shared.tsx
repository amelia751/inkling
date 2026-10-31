import { forwardRef, type ReactNode } from "react";
import { Button, type ButtonProps } from "@studio/ui/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@studio/ui/ui/tooltip";
import { cn } from "@studio/ui/utils";
import { extensionOf as fileExtension } from "@/studio/lib/file-kinds";

/**
 * Small pieces shared by the Files components (todo7 §2): the drop-target look, relative times,
 * name helpers and a button that stays focusable while disabled so its reason can be read.
 */

/**
 * "This goes here": the `--g-selection-hover` fill and a 1px `--g-line-focus` ring, the same
 * visual as the tree's drop row and today's OS-file drop (§2 Drag and drop).
 */
export const DROP_HIGHLIGHT = "bg-selection-hover ring-1 ring-inset ring-ring";

/** "just now", "5 min ago", "2 h ago", "yesterday", "3 days ago", "Oct 30". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.round((now - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return "yesterday";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

/** A full date for `title` attributes. */
export function fullDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d.toLocaleString();
}

/**
 * Where a file's extension starts (the index of the last dot), or the name's length when it has
 * none. A leading dot (`.env`) is not an extension. Folders never have one.
 */
export function stemEnd(name: string, kind: "file" | "folder" | "sequence" = "file"): number {
  if (kind === "folder") return name.length;
  // Double extensions (`.nii.gz`, `.tar.gz`) count as one, as the kernel's kinds do.
  return name.length - fileExtension(name).length;
}

/** `.dcm` (lowercase, with the dot), or "" when there is none. */
export function extensionOf(name: string, kind: "file" | "folder" | "sequence" = "file"): string {
  const end = stemEnd(name, kind);
  return end < name.length ? name.slice(end).toLowerCase() : "";
}

/** "scan001.dcm" → "scan001 (2).dcm" (Keep both, §2 Conflict dialog). */
export function keepBothName(name: string, kind: "file" | "folder" = "file", n = 2): string {
  const end = stemEnd(name, kind);
  return `${name.slice(0, end)} (${n})${name.slice(end)}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

type ReasonButtonProps = Omit<ButtonProps, "disabled"> & {
  /** Why the action can't run now; set, the button is inert (but focusable) and the reason is its tooltip. */
  reason?: string | null;
  /** The tooltip when enabled (usually the action's name, for icon buttons). */
  tip?: ReactNode;
};

/**
 * A button that explains itself when it can't act: `aria-disabled` instead of `disabled`, so it
 * keeps focus and hover and the tooltip can say why ("Sample data can't be changed…").
 */
export const ReasonButton = forwardRef<HTMLButtonElement, ReasonButtonProps>(function ReasonButton({ reason, tip, onClick, className, ...rest }, ref) {
  const inert = !!reason;
  const button = (
    <Button
      ref={ref}
      aria-disabled={inert || undefined}
      onClick={(e) => {
        if (inert) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={cn(inert && "cursor-not-allowed text-hint hover:bg-transparent hover:text-hint", className)}
      {...rest}
    />
  );
  const content = reason ?? tip;
  if (!content) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
});
