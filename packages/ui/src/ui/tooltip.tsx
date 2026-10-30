"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { Kbd, Shortcut } from "./kbd"
import { resolveShortcut, type ShortcutId } from "../shortcuts"
import { cn } from "../utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

/** Gravity tooltip: a float surface with a soft shadow, never a brand fill. */
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-72 overflow-hidden rounded-[4px] bg-float px-2 py-1 text-sm text-foreground shadow-float animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-tooltip-content-transform-origin]",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

type ActionTooltipProps = Omit<React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>, "title"> & {
  title: React.ReactNode
  /** A registry shortcut id, or a raw combo such as a tool key. */
  shortcut?: ShortcutId | (string & {})
  description?: React.ReactNode
}

/**
 * Gravity ActionTooltip, for buttons and tools: a dark float-heavy surface in
 * both themes with a title, an optional shortcut and an optional description.
 */
function ActionTooltipContent({ title, shortcut, description, className, ...props }: ActionTooltipProps) {
  return (
    <TooltipContent className={cn("max-w-64 bg-float-heavy px-3 py-2 text-white/95", className)} {...props}>
      <div className="flex items-baseline justify-between gap-3">
        <span>{title}</span>
        {shortcut && <ShortcutChips value={shortcut} />}
      </div>
      {description && <p className="mt-0.5 text-white/70">{description}</p>}
    </TooltipContent>
  )
}

function ShortcutChips({ value }: { value: string }) {
  return resolveShortcut(value) ? <Shortcut id={value} dark /> : <Shortcut combo={value} dark />
}

export { Tooltip, TooltipTrigger, TooltipContent, ActionTooltipContent, TooltipProvider, Kbd }
