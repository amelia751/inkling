import { useState } from "react";
import { Link, useParams } from "react-router";
import { AnnotateIcon, ChevronDownIcon, DoneIcon, DotIcon, ErrorIcon, UndoIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button, buttonVariants } from "@studio/ui/ui/button";
import { Spinner } from "@studio/ui/ui/spinner";
import { cn } from "@studio/ui/utils";
import { studioUrl } from "@/studio/lib/routes";
import { threadKey, useAgent } from "@/studio/stores/agent";
import { readySeconds } from "@/studio/components/layout/boot-status";
import { bootRows, formatSeconds, useBoots, type BootStep, type BootView } from "@/studio/stores/boots";

/**
 * The boot card / ledger (todo11 §3): one shimmering header line while the boot runs, then
 * "Studio ready · N s · Undo · Publish". Rows name artefacts ("Added 5 labels"), fixed height,
 * expandable when they carry one. Fed by the project stream's `boot.*` events (the boots
 * store), so the New Studio button and `/studio` get the same card as the model's boots.
 */
export function BootCard({ bootId }: { bootId: string }) {
  const boot = useBoots((s) => s.boots[bootId]);
  if (!boot)
    return (
      <section className="rounded-lg border border-border bg-background px-3 py-2.5" data-testid="boot-card" data-state="running">
        <p role="status" aria-live="polite" className="shimmer-text self-start font-semibold">Setting up your Studio</p>
      </section>
    );
  return <BootLedger boot={boot} />;
}

function BootLedger({ boot }: { boot: BootView }) {
  const { taskId } = useParams();
  const [busy, setBusy] = useState<null | "undo" | "publish">(null);
  const [error, setError] = useState<string | null>(null);
  const task = boot.taskIds[0];
  const here = !!task && taskId === task;
  const rows = bootRows(boot);
  const refined = boot.steps.some((s) => s.step === "refine" && s.state === "done");
  const act = (kind: "undo" | "publish") => {
    setBusy(kind);
    setError(null);
    const s = useBoots.getState();
    (kind === "undo" ? s.undo(boot.bootId) : s.publish(boot.bootId))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  const header =
    boot.state === "running"
      ? "Setting up your Studio"
      : boot.state === "ready"
        ? readySeconds(boot) !== undefined
          ? `Studio ready · ${formatSeconds(readySeconds(boot)!)} s`
          : "Studio ready"
        : boot.state === "stopped"
          ? "Stopped · what was built is kept"
          : "Couldn't set up the Studio";

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background" data-testid="boot-card" data-state={boot.state} data-boot-id={boot.bootId}>
      <header className="flex h-9 items-center gap-2 px-3">
        {boot.state === "running" ? <Spinner className="size-3.5" /> : boot.state === "failed" ? <ErrorIcon className="size-4 shrink-0 text-danger" /> : <AnnotateIcon className="size-4 shrink-0 text-hint" />}
        <p role="status" aria-live="polite" className={cn("min-w-0 truncate font-semibold", boot.state === "running" && "shimmer-text")} data-testid="boot-card-status">
          {header}
        </p>
        {boot.published && <Badge theme="success" className="ml-auto shrink-0">Published</Badge>}
      </header>
      <ul className="flex flex-col px-3 pb-2">
        {rows.map((r) => (
          <BootRow key={r.step} row={r} />
        ))}
      </ul>
      {boot.message && boot.state === "failed" && <p className="px-3 pb-2 text-danger">{boot.message}</p>}
      {error && <p className="px-3 pb-2 text-danger" role="alert">{error}</p>}
      {(boot.state === "running" || task) && (
        <footer className="flex items-center gap-1.5 border-t border-border px-3 py-1.5">
          {boot.state === "running" ? (
            <Button variant="ghost" size="xs" onClick={() => useBoots.getState().stop(boot.bootId)} data-testid="boot-stop">Stop</Button>
          ) : (
            <>
              {task && !here && (
                <Link to={studioUrl(boot.projectId, task)} viewTransition className={buttonVariants({ variant: "secondary", size: "xs" })} data-testid="boot-open">
                  Open Studio
                </Link>
              )}
              {refined && !boot.undone && boot.state !== "failed" && (
                <Button variant="ghost" size="xs" disabled={!!busy} onClick={() => act("undo")} data-testid="boot-undo">
                  <UndoIcon />
                  Undo
                </Button>
              )}
              {task && !boot.published && boot.state !== "failed" && (
                <Button variant="ghost" size="xs" className="ml-auto" disabled={!!busy} onClick={() => act("publish")} data-testid="boot-publish">
                  Publish
                </Button>
              )}
            </>
          )}
        </footer>
      )}
    </section>
  );
}

function BootRow({ row }: { row: BootStep }) {
  const [open, setOpen] = useState(false);
  const icon =
    row.state === "active" ? (
      <Spinner className="size-3.5" />
    ) : row.state === "done" ? (
      <DoneIcon className="size-3.5 shrink-0 text-hint" />
    ) : row.state === "failed" ? (
      <ErrorIcon className="size-3.5 shrink-0 text-danger" />
    ) : (
      <DotIcon className="size-3.5 shrink-0 text-hint" />
    );
  return (
    <li data-testid="boot-step" data-state={row.state} data-step={row.step}>
      <button
        type="button"
        onClick={() => row.artefact && setOpen(!open)}
        aria-expanded={row.artefact ? open : undefined}
        className={cn("group flex h-6 w-full min-w-0 items-center gap-2 text-left", row.state === "pending" ? "text-hint" : "text-muted-foreground", row.artefact && "hover:text-foreground")}
      >
        {icon}
        <span className={cn("min-w-0 truncate", row.state === "active" && "shimmer-text")}>{row.label}</span>
        {row.artefact && <ChevronDownIcon className={cn("ml-auto size-3 shrink-0 text-hint opacity-0 transition group-hover:opacity-100", open && "rotate-180 opacity-100")} />}
      </button>
      {open && row.artefact && <p className="ml-5.5 truncate pb-1 text-caption text-hint">{row.artefact}</p>}
    </li>
  );
}

/**
 * "Create X-ray Studio" (`offer_studio`, D5): the model offered a Studio; the click is the
 * explicit intent and calls the boot route directly (no second model turn).
 */
export function OfferCard({ projectId, messageId, offerId, offer }: { projectId: string; messageId: string; offerId: string; offer: { preset: string; title: string; reason?: string } }) {
  // One boot per offer (a second click replays it on the server instead of making another task).
  const bootId = `boot_${messageId.replace(/[^A-Za-z0-9]/g, "")}_${offerId.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
  const booted = useAgent((s) => !!s.threads[threadKey(s, projectId)]?.find((m) => m.id === messageId)?.parts.some((p) => p.type === "boot" && p.id === bootId));
  const create = () => {
    useAgent.getState().addPart(projectId, messageId, { type: "boot", id: bootId });
    void useBoots.getState().start(projectId, { bootId, preset: offer.preset, name: offer.title });
  };
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-background px-3 py-2.5" data-testid="studio-offer">
      <div>
        <h4 className="font-semibold">{offer.title}</h4>
        {offer.reason && <p className="text-muted-foreground">{offer.reason}</p>}
      </div>
      <Button size="sm" className="self-start" disabled={booted} onClick={create} data-testid="studio-offer-create">
        Create {offer.title}
      </Button>
    </section>
  );
}
