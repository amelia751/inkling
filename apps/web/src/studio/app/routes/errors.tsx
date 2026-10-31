import { useState } from "react";
import { Link, useRouteError } from "react-router";
import { CheckIcon, CopyIcon, HomeIcon, RetryIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { ErrorState } from "@studio/ui/ui/error-state";
import { AppLayout } from "@/studio/components/layout/app-layout";
import { describeError } from "@/studio/lib/errors";
import { homeUrl } from "@/studio/lib/routes";

function HomeButton() {
  return (
    <Button variant="outline" size="lg" asChild>
      <Link to={homeUrl()}>
        <HomeIcon /> Go to homepage
      </Link>
    </Button>
  );
}

function CopyDetails({ details }: { details: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost-secondary"
      size="lg"
      onClick={() => {
        void navigator.clipboard?.writeText(details).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      data-testid="copy-error-details"
    >
      {copied ? <CheckIcon className="text-positive" /> : <CopyIcon />} {copied ? "Copied" : "Copy error details"}
    </Button>
  );
}

/**
 * An error where a page or section would be: illustration, what happened, the next step.
 * `onRetry` re-runs the failed query; without it, Retry reloads the page.
 */
export function ErrorView({ error, what, onRetry, variant = "page" }: { error: unknown; what?: string; onRetry?: () => void; variant?: "page" | "section" }) {
  const d = describeError(error, what);
  return (
    <ErrorState
      variant={variant}
      kind={d.illustration}
      title={d.title}
      description={d.description}
      data-testid="error-view"
      data-error={d.name}
      actions={
        <>
          {d.retry && (
            <Button variant="outline" size="lg" onClick={onRetry ?? (() => location.reload())}>
              <RetryIcon /> {d.name === "stale" ? "Reload" : "Try again"}
            </Button>
          )}
          {!d.retry && <HomeButton />}
          {d.name === "error" && <CopyDetails details={d.details} />}
        </>
      }
    />
  );
}

/** Unknown URL: the Nebius "Not found" page, inside the shell so navigation stays. */
export function NotFoundPage() {
  return (
    <AppLayout>
      <ErrorState variant="page" kind="not-found" title="Not found" description="We couldn't find a page at this URL." actions={<HomeButton />} data-testid="not-found" />
    </AppLayout>
  );
}

/**
 * The router's error element: a page that threw while rendering or loading. Rendered without
 * the shell, since the shell itself may be what failed.
 */
export function RouteError() {
  const error = useRouteError();
  if (import.meta.env.DEV) console.error(error);
  return (
    <div className="flex h-full flex-col bg-background text-foreground" data-testid="route-error">
      <ErrorView error={error} />
    </div>
  );
}
