import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { AnnotateIcon, ErrorIcon, UndoIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button, buttonVariants } from "@studio/ui/ui/button";
import { Spinner } from "@studio/ui/ui/spinner";
import { cn } from "@studio/ui/utils";
import { studioUrl } from "@/studio/lib/routes";
import { threadKey, useAgent } from "@/studio/stores/agent";
import { useBoots, type BootView } from "@/studio/stores/boots";
import { fetchDataset, fetchTask, projectKeys } from "@/studio/lib/projects-api";
import { useDrop } from "@/studio/core/drops";

/**
 * The boot card (todo11 §3, todo29 D7): one shimmering line while the boot runs, then
 * "{name} · {n} items · Open" (Undo and Publish on hover). No step rows, no kind list.
 * Fed by the project stream's `boot.*` events (the boots store), so the New Studio button and
 * `/studio` get the same card as the model's boots.
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

/** todo29 D7/D8: the card's one line, "Chest X-rays · 27 items"; the count only when it's known. */
export function bootLine(name: string, items: number | undefined): string {
  return items === undefined ? name : `${name} · ${items} ${items === 1 ? "item" : "items"}`;
}

/** The Studio's name and how many items went in: the drop's `inStudio` when a drop booted it, else the dataset's files. */
function useBootSummary(boot: BootView): { name?: string; items?: number } {
  const task = boot.taskIds[0];
  const dropId = (boot.initiator as { dropId?: string } | undefined)?.dropId;
  const t = useQuery({ queryKey: ["tasks", task], queryFn: () => fetchTask(task!), enabled: !!task && boot.state === "ready", staleTime: 5_000 });
  const datasetId = t.data?.datasetId;
  const d = useQuery({ queryKey: [...projectKeys.datasets(boot.projectId), datasetId], queryFn: () => fetchDataset(boot.projectId, datasetId!), enabled: !!datasetId && !dropId, staleTime: 5_000 });
  const drop = useDrop(boot.state === "ready" ? dropId : undefined);
  const inStudio = (drop.data?.summary as { inStudio?: number } | undefined)?.inStudio;
  return { name: t.data?.title, items: dropId ? inStudio : d.data?.fileCount };
}

function BootLedger({ boot }: { boot: BootView }) {
  const { taskId } = useParams();
  const [busy, setBusy] = useState<null | "undo" | "publish">(null);
  const [error, setError] = useState<string | null>(null);
  const task = boot.taskIds[0];
  const here = !!task && taskId === task;
  const refined = boot.steps.some((s) => s.step === "refine" && s.state === "done");
  const summary = useBootSummary(boot);
  const act = (kind: "undo" | "publish") => {
    setBusy(kind);
    setError(null);
    const s = useBoots.getState();
    (kind === "undo" ? s.undo(boot.bootId) : s.publish(boot.bootId))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  // todo29 D7: one line, "{name} · {n} items · Open"; no step list, no kind list.
  const header =
    boot.state === "running"
      ? "Setting up your Studio"
      : boot.state === "ready"
        ? bootLine(summary.name ?? "Studio ready", summary.items)
        : boot.state === "stopped"
          ? "Stopped · what was built is kept"
          : "Couldn't set up the Studio";

  return (
    <section className="group/boot overflow-hidden rounded-lg border border-border bg-background" data-testid="boot-card" data-state={boot.state} data-boot-id={boot.bootId}>
      <header className="flex h-9 items-center gap-2 px-3">
        {boot.state === "running" ? <Spinner className="size-3.5" /> : boot.state === "failed" ? <ErrorIcon className="size-4 shrink-0 text-danger" /> : <AnnotateIcon className="size-4 shrink-0 text-hint" />}
        <p role="status" aria-live="polite" className={cn("min-w-0 truncate font-semibold", boot.state === "running" && "shimmer-text")} data-testid="boot-card-status">
          {header}
        </p>
        {boot.published && <Badge theme="success" className="shrink-0">Published</Badge>}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {boot.state === "running" ? (
            <Button variant="ghost" size="xs" onClick={() => useBoots.getState().stop(boot.bootId)} data-testid="boot-stop">Stop</Button>
          ) : (
            <>
              {refined && !boot.undone && boot.state !== "failed" && (
                <Button variant="ghost" size="xs" className="opacity-0 group-hover/boot:opacity-100 focus-visible:opacity-100" disabled={!!busy} onClick={() => act("undo")} data-testid="boot-undo">
                  <UndoIcon />
                  Undo
                </Button>
              )}
              {task && !boot.published && boot.state !== "failed" && (
                <Button variant="ghost" size="xs" className="opacity-0 group-hover/boot:opacity-100 focus-visible:opacity-100" disabled={!!busy} onClick={() => act("publish")} data-testid="boot-publish">
                  Publish
                </Button>
              )}
              {task && !here && (
                <Link to={studioUrl(boot.projectId, task)} viewTransition className={buttonVariants({ variant: "secondary", size: "xs" })} data-testid="boot-open">
                  Open
                </Link>
              )}
            </>
          )}
        </div>
      </header>
      {boot.message && boot.state === "failed" && <p className="px-3 pb-2 text-danger">{boot.message}</p>}
      {error && <p className="px-3 pb-2 text-danger" role="alert">{error}</p>}
    </section>
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
