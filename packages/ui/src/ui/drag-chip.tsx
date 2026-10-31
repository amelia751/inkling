import * as React from "react"

import type { IconComponent } from "../icons"
import { cn } from "../utils"

/**
 * The drag ghost (todo7 §2 Drag and drop): a chip with the first item's icon and "3 items"
 * (or the one item's name), a `+` badge when ⌥ copies, and the reason under it when the
 * target refuses the drop. Positioned by the caller (fixed, at the pointer).
 */
export interface DragChipProps {
  icon?: IconComponent
  /** "3 items", or the single item's name. */
  label: string
  /** ⌥ held: the drop copies. */
  copy?: boolean
  /** Why the hovered target refuses the drop. */
  reason?: string | null
  className?: string
  style?: React.CSSProperties
}

export function DragChip({ icon: Icon, label, copy, reason, className, style }: DragChipProps) {
  return (
    <div className={cn("pointer-events-none flex flex-col items-start gap-1", className)} style={style} data-testid="drag-chip">
      <div className="relative flex h-7 max-w-64 items-center gap-1.5 rounded-md bg-popover px-2 text-sm text-popover-foreground shadow-popup">
        {Icon && <Icon className="size-4 shrink-0 text-hint" aria-hidden />}
        <span className="truncate">{label}</span>
        {copy && (
          <span className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-brand text-[11px] font-semibold leading-none text-background" aria-label="copy">
            +
          </span>
        )}
      </div>
      {reason && <div className="max-w-64 rounded-md bg-popover px-2 py-1 text-xs text-destructive shadow-popup" role="status">{reason}</div>}
    </div>
  )
}

/** "3 items" for several, else the one name. */
export const dragLabel = (count: number, firstName?: string) => (count === 1 && firstName ? firstName : `${count} items`)
