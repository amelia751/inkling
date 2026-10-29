import * as React from "react"

import { comboParts, SHORTCUTS, type ShortcutDef, type ShortcutId } from "@/lib/shortcuts"
import { cn } from "@/lib/utils"

/** Gravity Hotkey chip: body-1 text, 1px 5px padding, 3px radius. `dark` sits on dark tooltips. */
function Kbd({ className, dark = false, ...props }: React.HTMLAttributes<HTMLElement> & { dark?: boolean }) {
  return (
    <kbd
      className={cn(
        "inline-flex min-w-5 shrink-0 items-center justify-center rounded-xs px-[5px] py-px font-sans text-sm",
        dark ? "bg-white/10 text-white/80" : "bg-generic text-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * A shortcut from the registry, or a raw combo, rendered as key chips.
 * Shows the first combo only; the "?" sheet lists alternates.
 */
function Shortcut({ id, combo, dark, className }: { id?: ShortcutId; combo?: string; dark?: boolean; className?: string }) {
  const def: ShortcutDef | undefined = id ? SHORTCUTS[id] : undefined
  const parts = def?.display ? [def.display] : comboParts(combo ?? def?.keys[0] ?? "")
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5", className)}>
      {parts.map((p, i) => (
        <Kbd key={i} dark={dark}>{p}</Kbd>
      ))}
    </span>
  )
}

export { Kbd, Shortcut }
