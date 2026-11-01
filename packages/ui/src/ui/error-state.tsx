import * as React from "react"

import type { IllustrationName } from "../illustrations"
import { EmptyState, type EmptyStateProps } from "./empty-state"

export type ErrorStateKind = Extract<IllustrationName, "not-found" | "access-denied" | "error" | "no-results" | "success" | "empty">

/**
 * An error page or failed section: `EmptyState` with an error picture. Errors and denied access
 * are announced (`role="alert"`).
 */
function ErrorState({ kind, ...props }: { kind?: ErrorStateKind } & Omit<EmptyStateProps, "art">) {
  return <EmptyState art={kind} role={kind === "error" || kind === "access-denied" ? "alert" : undefined} data-kind={kind} {...props} />
}

export { ErrorState }
