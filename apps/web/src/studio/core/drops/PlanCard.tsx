import { useEffect, useState } from "react";
import { problemMessage, toProblem } from "@/studio/lib/problem";
import { Link, useParams } from "react-router";
import { AnnotateIcon, ArchiveFileIcon, DatasetsIcon, DocumentIcon, DoneIcon, ErrorIcon, FileIcon, ImageIcon, PrivacyIcon, SearchIcon, TableFileIcon, UndoIcon, UnknownFileIcon, VideoIcon, VolumeIcon, WaveformIcon, SlideIcon } from "@studio/ui/icons";
import type { DropAction, DropActionType } from "@studio/contracts/drop-plan";
import { Button } from "@studio/ui/ui/button";
import { Spinner } from "@studio/ui/ui/spinner";
import { cn } from "@studio/ui/utils";
import { studioUrl } from "@/studio/lib/routes";
import { actionLabel, findPlugins, QUESTION_COPY, QUESTIONS, REFUSED_COPY, undoSecondsLeft, usePlans, type PlanView } from "./plans";

/**
 * The plan card (todo13 D5, D6, §3.2–3.4): a drop's groups and the one action each gets, with
 * Apply / Change / Undo. A plan the kernel applied on its own (D6: only the person's own drafts)
 * shows Undo for the window the server gives (30 s by default). Questions ("Is this a labels
 * table for these images?") are answered on the card; offers ("Find a plugin", "Attach as
 * documentation") sit beside their action.
 *
 * Rendered for each `drop.planned` (`DropPlanCards`); the drop card (todo13-drops) can embed
 * `<PlanCard dropId>` instead.
 */
export function PlanCard({ dropId }: { dropId: string }) {
  const plan = usePlans((s) => s.plans[dropId]);
  const load = usePlans((s) => s.load);
  useEffect(() => {
    if (!plan?.plan) void load(dropId);
  }, [dropId, plan?.plan, load]);
  if (!plan?.plan)
    return (
      <section className="rounded-lg border border-border bg-background px-3 py-2.5" data-testid="plan-card" data-drop-id={dropId} data-state="classified">
        <p role="status" aria-live="polite" className="shimmer-text font-semibold">Sorting what you dropped</p>
      </section>
    );
  return <PlanLedger plan={plan} />;
}

const ICON: Record<string, typeof FileIcon> = {
  image: ImageIcon,
  dicom: ImageIcon,
  "dicom-series": VolumeIcon,
  volume: VolumeIcon,
  mask: VolumeIcon,
  video: VideoIcon,
  waveform: WaveformIcon,
  slide: SlideIcon,
  table: TableFileIcon,
  document: DocumentIcon,
  annotations: DocumentIcon,
  archive: ArchiveFileIcon,
  unknown: UnknownFileIcon,
};

/** What "Change" may turn an action into (never other files: the kernel checks it too). */
function choices(a: DropAction): DropActionType[] {
  if (a.type === "link_existing") return ["link_existing"];
  if (a.type === "unpack") return ["unpack", "keep_reference"];
  if (a.type === "keep_unsupported") return ["keep_unsupported"];
  if (a.kind === "table" || a.kind === "document") return ["new_collection", "keep_reference"];
  return ["new_dataset", "new_collection", "keep_reference"];
}
const CHOICE_LABEL: Record<DropActionType, string> = {
  new_dataset: "New draft dataset",
  new_collection: "New collection",
  add_to_collection: "Add to the collection",
  unpack: "Unpack",
  keep_reference: "Keep in Sources as reference",
  keep_unsupported: "Keep in Sources",
  link_existing: "Link the existing File",
};

function useSecondsLeft(plan: PlanView) {
  const [now, setNow] = useState(() => Date.now());
  const left = undoSecondsLeft(plan, now);
  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [left]);
  return left;
}

function PlanLedger({ plan }: { plan: PlanView }) {
  const { taskId } = useParams();
  const { apply, change, undo } = usePlans.getState();
  const [busy, setBusy] = useState<null | "apply" | "undo" | "change">(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, DropActionType>>({});
  const left = useSecondsLeft(plan);
  const actions = plan.plan!.actions;
  const asking = actions.filter((a) => a.asks && QUESTIONS.has(a.asks));
  const held = actions.reduce((n, a) => n + (a.held ?? 0), 0);
  const spoofed = plan.groups.reduce((n, g) => n + (g.spoofed ?? 0), 0);
  const refused = Object.values(plan.refused);
  const studio = plan.taskIds.find((t) => t !== taskId);

  const run = (kind: "apply" | "undo" | "change", fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    fn()
      .catch((e: unknown) => setError(kind === "undo" ? undoBlockedReason(e) : problemMessage(e)))
      .finally(() => setBusy(null));
  };
  const answer = (a: DropAction, yes: boolean) =>
    run("change", () => (yes ? change(plan.dropId, [{ groupId: a.groupId, answer: "yes" } as Partial<DropAction>]) : change(plan.dropId, [{ groupId: a.groupId, ...QUESTION_COPY[a.asks!]!.noChange }])));
  const saveChange = () =>
    run("change", async () => {
      await change(
        plan.dropId,
        Object.entries(draft).map(([groupId, type]) => ({ groupId, type, ...(type === "new_dataset" ? { datasetId: null as unknown as undefined } : {}) })),
      );
      setEditing(false);
      setDraft({});
    });

  const header =
    plan.state === "applying"
      ? "Applying"
      : plan.state === "applied"
        ? plan.fastPath
          ? plan.waitingFirstItem
            ? "Preparing your first item"
            : "Studio opened · sorted on its own"
          : plan.auto
            ? "Sorted on its own"
            : "Applied"
        : plan.state === "undone"
          ? "Undone · your files are still in Sources"
          : plan.state === "failed"
            ? `Couldn't ${plan.failed?.step === "classify" ? "sort these files" : "apply this"}`
            : asking.length
              ? "A question before this is applied"
              : "Here's what happens to these files";

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-background" data-testid="plan-card" data-drop-id={plan.dropId} data-state={plan.state} data-auto={plan.auto ? "true" : "false"}>
      <header className="flex min-h-9 items-center gap-2 px-3 py-1.5">
        {plan.state === "applying" ? <Spinner className="size-3.5" /> : plan.state === "failed" ? <ErrorIcon className="size-4 shrink-0 text-danger" /> : plan.state === "applied" ? <DoneIcon className="size-4 shrink-0 text-success" /> : <DatasetsIcon className="size-4 shrink-0 text-hint" />}
        <p role="status" aria-live="polite" className={cn("min-w-0 flex-1 truncate font-semibold", plan.state === "applying" && "shimmer-text")} data-testid="plan-status">
          {header}
        </p>
      </header>
      {isFollowUp(plan.dropId) && (
        <p className="border-t border-border px-3 py-1.5 text-caption text-muted-foreground" data-testid="plan-follow-up">
          More files arrived after the first plan was applied. This plan covers only those.
        </p>
      )}
      <ul className="flex flex-col border-t border-border">
        {actions.map((a) => {
          const Icon = ICON[a.kind ?? "unknown"] ?? FileIcon;
          return (
            <li key={a.groupId} className="flex flex-col gap-1 px-3 py-2 not-last:border-b not-last:border-border" data-testid="plan-action" data-type={a.type} data-group={a.groupId} data-asks={a.asks ?? ""}>
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-hint" aria-hidden />
                <span className="min-w-0 flex-1 text-sm">{actionLabel(a)}</span>
                {editing && choices(a).length > 1 && (
                  <select
                    aria-label="Action"
                    className="h-6 rounded-sm border border-border bg-background px-1 text-sm"
                    value={draft[a.groupId] ?? a.type}
                    onChange={(e) => setDraft((d) => ({ ...d, [a.groupId]: e.target.value as DropActionType }))}
                    data-testid="plan-action-select"
                  >
                    {choices(a).map((c) => (
                      <option key={c} value={c}>
                        {CHOICE_LABEL[c]}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {a.asks && QUESTIONS.has(a.asks) && plan.state === "planned" && !editing && (
                <div className="ml-6 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">{QUESTION_COPY[a.asks]!.question}</span>
                  <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => answer(a, true)} data-testid="plan-question-yes">
                    {QUESTION_COPY[a.asks]!.yes}
                  </Button>
                  <Button size="sm" variant="ghost-secondary" disabled={!!busy} onClick={() => answer(a, false)} data-testid="plan-question-no">
                    {QUESTION_COPY[a.asks]!.no}
                  </Button>
                </div>
              )}
              {a.asks === "attach_documentation" && plan.state === "planned" && !editing && (
                <div className="ml-6">
                  <Button size="sm" variant="link" className="h-auto px-0" disabled={!!busy} onClick={() => run("change", () => change(plan.dropId, [{ groupId: a.groupId, type: "new_collection" }]))} data-testid="plan-attach-docs">
                    Attach to the dataset as documentation
                  </Button>
                </div>
              )}
              {a.type === "keep_unsupported" && <FindPlugin kind={a.findPluginKind ?? a.kind ?? "unknown"} />}
            </li>
          );
        })}
      </ul>
      {(held > 0 || spoofed > 0 || refused.length > 0 || plan.pipelineRunIds?.length) && (
        <div className="flex flex-col gap-1 border-t border-border px-3 py-2 text-sm">
          {held > 0 && (
            <p className="flex items-center gap-1.5 text-muted-foreground" data-testid="plan-held">
              <PrivacyIcon className="size-3.5 shrink-0" aria-hidden />
              {held === 1 ? "1 file is" : `${held} files are`} held for privacy review: usable here, not in a release until reviewed.
            </p>
          )}
          {spoofed > 0 && (
            <p className="text-muted-foreground" data-testid="plan-spoofed">
              {spoofed === 1 ? "1 file isn't" : `${spoofed} files aren't`} what its extension says; sorted by what it really is.
            </p>
          )}
          {refused.map((r, i) => (
            <p key={i} className="flex items-center gap-1.5 text-danger" data-testid="plan-refused" data-reason={r}>
              <ErrorIcon className="size-3.5 shrink-0" aria-hidden />
              {REFUSED_COPY[r] ?? REFUSED_COPY.unreadable}
            </p>
          ))}
          {!!plan.pipelineRunIds?.length && <p className="text-muted-foreground">Checks are running on these files before they reach the dataset.</p>}
        </div>
      )}
      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        {plan.state === "planned" && !editing && (
          <>
            <Button size="sm" loading={busy === "apply"} disabled={!!busy} onClick={() => run("apply", () => apply(plan.dropId))} data-testid="plan-apply">
              Apply
            </Button>
            <Button size="sm" variant="ghost-secondary" disabled={!!busy} onClick={() => setEditing(true)} data-testid="plan-change">
              Change
            </Button>
          </>
        )}
        {editing && (
          <>
            <Button size="sm" loading={busy === "change"} disabled={!!busy || !Object.keys(draft).length} onClick={saveChange} data-testid="plan-change-save">
              Save
            </Button>
            <Button size="sm" variant="ghost-secondary" onClick={() => (setEditing(false), setDraft({}))}>
              Cancel
            </Button>
          </>
        )}
        {plan.state === "failed" && (
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => run("apply", () => apply(plan.dropId))} data-testid="plan-apply">
            Try again
          </Button>
        )}
        {plan.state === "applied" && studio && (
          <Link to={studioUrl(plan.projectId, studio)} className="inline-flex h-6 items-center gap-1 rounded-sm bg-generic px-2 text-sm hover:bg-generic-hover" data-testid="plan-open-studio">
            <AnnotateIcon className="size-3.5" aria-hidden />
            Open Studio
          </Link>
        )}
        {left > 0 && (
          <Button size="sm" variant="ghost-secondary" loading={busy === "undo"} disabled={!!busy} onClick={() => run("undo", () => undo(plan.dropId))} data-testid="plan-undo">
            <UndoIcon aria-hidden />
            Undo · {left} s
          </Button>
        )}
        {error && (
          <span className="text-sm text-danger" role="alert">
            {error}
          </span>
        )}
      </footer>
    </section>
  );
}

function FindPlugin({ kind }: { kind: string }) {
  const [state, setState] = useState<"idle" | "searching" | { id: string; label?: string; description: string }[]>("idle");
  if (state === "idle")
    return (
      <div className="ml-6">
        <Button size="sm" variant="link" className="h-auto px-0" onClick={() => (setState("searching"), void findPlugins(kind).then(setState, () => setState([])))} data-testid="plan-find-plugin">
          <SearchIcon aria-hidden />
          Find a plugin
        </Button>
      </div>
    );
  if (state === "searching") return <Spinner className="ml-6 size-3.5" />;
  if (!state.length)
    return (
      <p className="ml-6 text-sm text-muted-foreground" data-testid="plan-no-plugin">
        No plugin for this kind yet. See docs/plugins.md to build one.
      </p>
    );
  return (
    <ul className="ml-6 flex flex-col gap-0.5 text-sm" data-testid="plan-plugin-results">
      {state.map((p) => (
        <li key={p.id}>
          <span className="font-medium">{p.label ?? p.id}</span> <span className="text-muted-foreground">· {p.description}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every plan seen on this page's project stream, newest last (the integration point in the chat
 * until the drop card embeds `PlanCard`).
 */
export function DropPlanCards({ projectId }: { projectId: string }) {
  const ids = usePlans((s) =>
    Object.values(s.plans)
      .filter((p) => p.projectId === projectId)
      .sort((a, b) => a.seenAt - b.seenAt)
      .map((p) => p.dropId)
      .join(" "),
  );
  if (!ids) return null;
  return (
    <div className="flex flex-col gap-3 px-4 pb-2" data-testid="plan-cards">
      {ids.split(" ").map((id) => (
        <PlanCard key={id} dropId={id} />
      ))}
    </div>
  );
}

/** A follow-up plan for files that arrived after the first was applied (`<dropId>-<n>`, drops_plan.py). */
export const isFollowUp = (dropId: string) => /^drp[-_][0-9a-z]+-\d+$/i.test(dropId);

/** Why Undo can't run, in the kernel's words made plain (todo18), never a generic error. */
export function undoBlockedReason(e: unknown): string {
  const p = toProblem(e);
  const d = (p.detail ?? "").toLowerCase();
  if (d.includes("annotations")) return "Undo isn't available: the Studio this drop made already has annotations. Your files stay in Sources.";
  if (d.includes("published")) return "Undo isn't available: the Studio this drop made was published. Your files stay in Sources.";
  if (d.includes("undo window")) return "Undo isn't available any more: its window has passed. Your files stay in Sources.";
  return problemMessage(e);
}
