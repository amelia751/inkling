"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

/**
 * Gravity line tabs: 36px items, 24px apart, a 2px brand underline on the
 * active tab over a 1px baseline. Use SegmentedControl for mode switches.
 */
const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "flex items-end gap-6 overflow-x-auto shadow-[inset_0_-1px_0_0_var(--g-line)] hide-scrollbar",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "flex h-9 shrink-0 items-center gap-2 whitespace-nowrap border-b-2 border-transparent pt-0.5 text-sm text-muted-foreground transition-colors [outline-offset:-2px] hover:text-foreground disabled:pointer-events-none disabled:text-hint data-[state=active]:border-brand data-[state=active]:text-foreground [&_[data-counter]]:text-hint data-[state=active]:[&_[data-counter]]:text-muted-foreground",
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("[outline-offset:-2px]", className)}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
