import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../utils"

/**
 * Gravity UI Label: a soft tinted pill for status and metadata. Color carries
 * the meaning, so always pair it with a word (never a bare dot).
 */
const badgeVariants = cva(
  "inline-flex max-w-full shrink-0 items-center whitespace-nowrap text-body-short font-normal [&_svg]:shrink-0",
  {
    variants: {
      theme: {
        normal: "bg-generic text-complementary",
        info: "bg-info-tint text-info",
        success: "bg-positive-tint text-positive",
        warning: "bg-warning-tint text-warning",
        danger: "bg-danger-tint text-danger",
        utility: "bg-utility-tint text-utility",
        unknown: "bg-generic text-muted-foreground",
        clear: "text-complementary shadow-[inset_0_0_0_1px_var(--g-line)]",
        ai: "bg-ai-tint text-ai-text",
      },
      size: {
        xs: "h-5 gap-1 rounded-xs px-2 [&_svg]:size-3",
        sm: "h-6 gap-1.5 rounded-sm px-2.5 [&_svg]:size-3.5",
        md: "h-7 gap-1.5 rounded-md px-3 [&_svg]:size-4",
      },
    },
    defaultVariants: {
      theme: "normal",
      size: "xs",
    },
  }
)

/** shadcn variant names still used by older call sites, mapped onto Gravity themes. */
const LEGACY_THEME = { default: "utility", secondary: "normal", outline: "clear", destructive: "danger" } as const

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** @deprecated use `theme` */
  variant?: keyof typeof LEGACY_THEME
  /** A live process (running, generating): a soft highlight sweeps across the label. */
  running?: boolean
}

function Badge({ className, theme, size, variant, running = false, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ theme: theme ?? (variant && LEGACY_THEME[variant]), size }), running && "label-sweep", className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
