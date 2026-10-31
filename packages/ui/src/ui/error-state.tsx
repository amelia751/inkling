import * as React from "react"

import {
  AccessDeniedIllustration,
  InternalErrorIllustration,
  NoSearchResultsIllustration,
  NotFoundIllustration,
  SuccessIllustration,
} from "../illustrations"
import { cn } from "../utils"

const ILLUSTRATIONS = {
  "not-found": NotFoundIllustration,
  "access-denied": AccessDeniedIllustration,
  error: InternalErrorIllustration,
  "no-results": NoSearchResultsIllustration,
  success: SuccessIllustration,
} as const

export type ErrorStateKind = keyof typeof ILLUSTRATIONS

/**
 * Gravity's error page / empty state, as the Nebius console uses it: a 160px illustration with
 * the title (header-1, 20/24 semibold), description (secondary) and actions beside it, 24px apart;
 * stacked and centered below `sm`. `page` fills and centers in its container; `section` sits in a
 * table or list area.
 */
function ErrorState({
  kind,
  title,
  description,
  actions,
  variant = "section",
  className,
  ...props
}: {
  kind?: ErrorStateKind
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  variant?: "page" | "section"
} & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
  const Illustration = kind ? ILLUSTRATIONS[kind] : null
  return (
    <div
      role={kind === "error" || kind === "access-denied" ? "alert" : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-6 text-center sm:flex-row sm:text-left",
        variant === "page" ? "min-h-full flex-1 px-6 py-12" : "px-5 py-10",
        className
      )}
      data-kind={kind}
      {...props}
    >
      {Illustration && <Illustration aria-hidden className="size-40 shrink-0" />}
      <div className="flex max-w-[360px] flex-col items-center sm:items-start">
        <h2 className="text-header-1 font-semibold">{title}</h2>
        {description && <div className="mt-3 text-sm leading-5 text-muted-foreground">{description}</div>}
        {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}

export { ErrorState }
