import * as React from "react"
import { Group, Panel, Separator } from "react-resizable-panels"

import { cn } from "../utils"

/**
 * shadcn's resizable split over react-resizable-panels (v4: Group / Panel / Separator).
 * Pages outside the Studio use it for panes (Sources: tree · listing · inspector); the Studio
 * keeps dockview. Sizes take pixels ("260px") or percentages.
 */
function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof Group>) {
  return <Group className={cn("flex h-full w-full", className)} {...props} />
}

const ResizablePanel = Panel

/** A 1px line in `--g-line` with a wider invisible hit area; focusable, arrow keys resize. */
function ResizableHandle({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn(
        "relative w-px shrink-0 bg-border outline-none transition-colors after:absolute after:inset-y-0 after:-left-1 after:-right-1 hover:bg-border-hover data-[separator=active]:bg-ring focus-visible:bg-ring",
        className,
      )}
      {...props}
    />
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
