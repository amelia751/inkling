import type { ReactNode } from "react";
import { Button } from "@studio/ui/ui/button";
import { Loader } from "@studio/ui/ui/loader";
import { isUnauthorized, useSessionQuery, useSignIn } from "@/studio/lib/session";

/**
 * Renders the app once someone is signed in (todo9 Phase 4). In `dev` mode that's immediate
 * (the mock account stands in until the API answers); in `workos` mode it waits for
 * `/api/auth/session`, and a 401 there (or anywhere later) shows "Signing you in…" while the
 * browser goes to the sign-in page.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const session = useSessionQuery();
  const redirecting = useSignIn((s) => s.redirecting);
  if (redirecting) return <Status title="Signing you in…" testId="signing-in" />;
  if (session.data) return children;
  if (session.error && !isUnauthorized(session.error))
    return (
      <Status title="Couldn't check who's signed in" body={session.error instanceof Error ? session.error.message : String(session.error)} testId="session-error">
        <Button variant="outline" onClick={() => void session.refetch()}>
          Try again
        </Button>
      </Status>
    );
  // Loading, or a 401 whose redirect is under way.
  return <Status title={session.error ? "Signing you in…" : "Loading…"} testId={session.error ? "signing-in" : "session-loading"} />;
}

function Status({ title, body, testId, children }: { title: string; body?: string; testId: string; children?: ReactNode }) {
  const busy = !children;
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-background p-8 text-center" role={busy ? "status" : "alert"} aria-busy={busy} data-testid={testId}>
      {busy && <Loader className="mb-2" />}
      <h1 className="text-body-2 font-semibold">{title}</h1>
      {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
      {children}
    </div>
  );
}
