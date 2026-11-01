import * as React from "react"

import { ILLUSTRATIONS, type IllustrationName } from "../illustrations"
import { cn } from "../utils"
import { Button } from "./button"

const SIZES = {
  /** Page or table area (Nebius `n-empty-state` size l): 160px art beside the text, 24px apart. */
  l: { root: "gap-6 sm:flex-row sm:text-left", art: "size-40", text: "max-w-[340px] sm:items-start", title: "text-header-1 font-semibold", desc: "mt-3", actions: "mt-4" },
  /** Cards and narrower sections. */
  m: { root: "gap-5 sm:flex-row sm:text-left", art: "size-28", text: "max-w-[300px] sm:items-start", title: "text-body-2 font-semibold", desc: "mt-2", actions: "mt-3" },
  /** Sidebars, panels, popovers: stacked and centred. */
  s: { root: "gap-3", art: "size-18", text: "max-w-[260px]", title: "text-sm font-semibold", desc: "mt-1", actions: "mt-3" },
} as const

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Illustration: the kind of thing that is missing, or an error/no-results picture. */
  art?: IllustrationName
  /** "No datasets yet", "No results". */
  title: React.ReactNode
  /** One sentence: what the thing is for, or how to get results. */
  description?: React.ReactNode
  /** Usually one outlined button: "Create dataset", "Clear filters". */
  actions?: React.ReactNode
  size?: keyof typeof SIZES
  /** `page` fills its container and centres; `section` sits in a table, card or list. */
  variant?: "page" | "section"
}

/**
 * The empty state, as the Nebius console draws it: illustration, title, one-sentence description,
 * one action. Use it whenever a list, table, page or panel has nothing to show (docs/ui.md,
 * "Errors and empty states").
 */
function EmptyState({ art, title, description, actions, size = "l", variant = "section", className, ...props }: EmptyStateProps) {
  const s = SIZES[size]
  const Art = art ? ILLUSTRATIONS[art] : null
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        s.root,
        variant === "page" ? "min-h-full flex-1 px-6 py-12" : size === "s" ? "px-4 py-6" : "px-5 py-10",
        className
      )}
      data-art={art}
      {...props}
    >
      {Art && <Art className={cn("shrink-0", s.art)} />}
      <div className={cn("flex flex-col items-center", s.text)}>
        <h2 className={s.title}>{title}</h2>
        {description && <div className={cn("text-sm leading-5 text-muted-foreground", s.desc)}>{description}</div>}
        {actions && <div className={cn("flex flex-wrap items-center justify-center gap-2 sm:justify-start", s.actions, size === "s" && "sm:justify-center")}>{actions}</div>}
      </div>
    </div>
  )
}

/**
 * A search or filter hid everything (Nebius "No results"): one wording everywhere, and the way
 * back is always "Clear filters".
 */
function NoResults({ what, onClear, ...props }: { what?: string; onClear?: () => void } & Omit<EmptyStateProps, "art" | "title">) {
  return (
    <EmptyState
      art="no-results"
      title={what ? `No ${what} found` : "No results"}
      description="Try a different search or clear all filters."
      actions={onClear && <Button variant="outline" size={props.size === "s" ? "sm" : "lg"} onClick={onClear}>Clear filters</Button>}
      data-testid="no-results"
      {...props}
    />
  )
}

export { EmptyState, NoResults }
