import * as React from "react"
import * as ToggleGroup from "@radix-ui/react-toggle-group"

import { cn } from "@/lib/utils"

/**
 * Gravity SegmentedRadioGroup. `filled`: a generic track with a float "plate"
 * on the chosen option. `outline`: bordered cells, the chosen one ringed in
 * brand (the Nebius header theme switch). For switching a mode or view, not
 * for page sections.
 */
interface SegmentedControlProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: readonly { value: T; label: React.ReactNode; title?: string; "aria-label"?: string }[]
  size?: "sm" | "md"
  variant?: "filled" | "outline"
  className?: string
  "aria-label": string
}

export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  size = "sm",
  variant = "filled",
  className,
  ...props
}: SegmentedControlProps<T>) {
  const outline = variant === "outline"
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as T)}
      className={cn(
        "inline-flex shrink-0 items-stretch",
        outline ? "rounded-lg border border-border" : "bg-generic p-0.5",
        size === "sm" ? "h-6" : "h-7",
        !outline && (size === "sm" ? "rounded-sm" : "rounded-md"),
        className
      )}
      {...props}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          title={o.title}
          aria-label={o["aria-label"]}
          className={cn(
            "press flex items-center justify-center whitespace-nowrap text-sm [outline-offset:-2px] [&_svg]:size-4",
            outline
              ? "min-w-[40px] border-l border-border px-3 text-complementary first:rounded-l-[7px] first:border-l-0 last:rounded-r-[7px] hover:bg-generic hover:text-foreground data-[state=on]:bg-generic data-[state=on]:text-brand-heavy data-[state=on]:shadow-[inset_0_0_0_1px_var(--g-text-brand)]"
              : "text-muted-foreground hover:text-foreground data-[state=on]:bg-float data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_var(--g-shadow)]",
            !outline && (size === "sm" ? "rounded-xs px-2" : "rounded-[5px] px-3")
          )}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
