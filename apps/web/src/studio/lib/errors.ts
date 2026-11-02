import { isRouteErrorResponse } from "react-router";
import type { ErrorStateKind } from "@studio/ui/ui/error-state";
import { ApiError, NeedsApiError } from "@/studio/lib/projects-api";

/**
 * One way to name what went wrong, wherever it surfaces (page, section, alert, toast). Each kind
 * has its own illustration and next step, following the Nebius console:
 *
 * - `not-found`: "Not found" + Go to homepage (bad URL, deleted item, an id from another org).
 * - `access-denied`: "No access" + who to ask.
 * - `offline`: the browser or the server is unreachable + Retry.
 * - `stale`: a new version was deployed under an open tab (lazy chunk 404) + Reload.
 * - `needs-api`: the dev seed server can't do this; points at docs/running.md.
 * - `error`: anything else + Retry and Copy error details (with the request id).
 */
export type ErrorKindName = "not-found" | "access-denied" | "offline" | "stale" | "needs-api" | "error";

export interface DescribedError {
  name: ErrorKindName;
  illustration: ErrorStateKind;
  title: string;
  description: string;
  /** Retrying can help (network, server errors); not for 403/404. */
  retry: boolean;
  status?: number;
  requestId?: string;
  /** Plain text for "Copy error details": no annotation content, just what a bug report needs. */
  details: string;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : isRouteErrorResponse(e) ? `${e.status} ${e.statusText}` : "Unknown error");

const statusOf = (e: unknown): number | undefined => {
  if (e instanceof ApiError) return e.status;
  if (isRouteErrorResponse(e)) return e.status;
  const m = /^(\d{3})\b/.exec(messageOf(e));
  return m ? Number(m[1]) : undefined;
};

export function describeError(e: unknown, what = "page"): DescribedError {
  const status = statusOf(e);
  const message = messageOf(e);
  const requestId = e instanceof ApiError ? e.requestId : undefined;
  const details = [
    `Error: ${message}`,
    status ? `Status: ${status}` : null,
    requestId ? `Request ID: ${requestId}` : null,
    `Page: ${typeof location !== "undefined" ? location.pathname : ""}`,
    `Time: ${new Date().toISOString()}`,
  ]
    .filter(Boolean)
    .join("\n");
  const base = { status, requestId, details };

  if (e instanceof NeedsApiError)
    return { ...base, name: "needs-api", illustration: "error", title: "Needs the full stack", description: "The dev seed server can't do this. Start the API: see docs/running.md.", retry: false };
  if (status === 410)
    return { ...base, name: "not-found", illustration: "not-found", title: "Moved to Trash", description: `This ${what} is in Trash. Restore it from the project's Trash to open it again.`, retry: false };
  if (status === 404)
    return { ...base, name: "not-found", illustration: "not-found", title: "Not found", description: `We couldn't find this ${what}. It may have been deleted, or the link is wrong.`, retry: false };
  if (status === 401 || status === 403)
    return { ...base, name: "access-denied", illustration: "access-denied", title: "No access", description: `You don't have permission to open this ${what}. Ask an organization admin to give you access.`, retry: false };
  if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message))
    return { ...base, name: "stale", illustration: "error", title: "A new version is available", description: "This tab is running an older version of the app. Reload to get the new one.", retry: true };
  if ((typeof navigator !== "undefined" && navigator.onLine === false) || /Failed to fetch|NetworkError|Load failed|ERR_CONNECTION/i.test(message))
    return { ...base, name: "offline", illustration: "error", title: "Can't reach the server", description: "Check your connection, then try again. Nothing you've saved is lost.", retry: true };
  return {
    ...base,
    name: "error",
    illustration: "error",
    title: "Something went wrong",
    description: status && status >= 500 ? "The server ran into a problem. Try again in a moment; if it keeps happening, send us the error details." : "Try again; if it keeps happening, send us the error details.",
    retry: true,
  };
}
