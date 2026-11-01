import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { DoneIcon, ErrorIcon } from "@studio/ui/icons";
import { Spinner } from "@studio/ui/ui/spinner";
import { cn } from "@studio/ui/utils";
import { studioUrl } from "@/studio/lib/routes";
import { useStudio } from "@/studio/stores/studio";
import { bootSeconds, formatSeconds, useBoots, type BootView } from "@/studio/stores/boots";

/** How long the pill stays after a boot finishes ("Studio ready · 0.4 s"). */
const LINGER_MS = 8000;

/**
 * Makes the navigation the boots store asks for (D6: the tab that started a boot opens its
 * Studio, SPA, with a view transition). One per page, inside the router.
 */
export function BootNavigator() {
  const nav = useBoots((s) => s.pendingNav);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!nav) return;
    useBoots.getState().clearNav();
    const boot = useBoots.getState().boots[nav.bootId];
    // The conversation that asked carries on beside the new Studio.
    if (boot?.initiator?.kind === "agent" && !useStudio.getState().aiOpen) useStudio.getState().toggleAi();
    if (pathname !== nav.url) navigate(nav.url, { viewTransition: true });
  }, [nav, navigate, pathname]);
  return null;
}

/** The project's latest boot while it runs, and for a moment after. */
function useCurrentBoot(projectId: string | undefined): BootView | undefined {
  const boot = useBoots((s) => {
    let best: BootView | undefined;
    for (const b of Object.values(s.boots)) if (b.projectId === projectId && (!best || b.seenAt > best.seenAt)) best = b;
    return best;
  });
  const [, tick] = useState(0);
  const until = boot?.finishedAt ? boot.finishedAt + LINGER_MS : undefined;
  useEffect(() => {
    if (!until) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [until]);
  if (!boot || (until && Date.now() > until)) return undefined;
  return boot;
}

/** The compact top-bar pill while a boot runs (todo11 item 9). */
export function BootPill({ className }: { className?: string }) {
  const { projectId, taskId } = useParams();
  const boot = useCurrentBoot(projectId);
  if (!boot) return null;
  const task = boot.taskIds[0];
  const text =
    boot.state === "running" ? "Setting up Studio" : boot.state === "ready" ? `Studio ready · ${formatSeconds(bootSeconds(boot))} s` : boot.state === "stopped" ? "Studio stopped" : "Studio failed";
  const body = (
    <>
      {boot.state === "running" ? <Spinner className="size-3" /> : boot.state === "failed" ? <ErrorIcon className="size-3.5 text-danger" /> : <DoneIcon className="size-3.5 text-hint" />}
      <span className={cn("truncate", boot.state === "running" && "shimmer-text")}>{text}</span>
    </>
  );
  const cls = cn("inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-2.5 text-caption text-muted-foreground", className);
  return task && task !== taskId ? (
    <Link to={studioUrl(boot.projectId, task)} viewTransition className={cn(cls, "hover:bg-generic hover:text-foreground")} data-testid="boot-pill" data-state={boot.state} role="status" aria-live="polite">
      {body}
    </Link>
  ) : (
    <span className={cls} data-testid="boot-pill" data-state={boot.state} role="status" aria-live="polite">
      {body}
    </span>
  );
}
