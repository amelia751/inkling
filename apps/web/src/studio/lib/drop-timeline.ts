import { RES } from "@studio/contracts/naming";
import { BOOT_MARK_PREFIX } from "@studio/plugin-ui-sdk/perf";
import { apiUrl } from "@/extension-host/runtime-config";
import { apiFetch } from "@/extension-host/http";

/**
 * The drop timeline (todo13 §6, Milestone 4 item 1): from the first gesture (a drop, a paste,
 * a send) to the first item interactive in a Studio, across pages of one document. Each step
 * is a `performance` mark named `<resourcePrefix>:drop:<step>`, so it survives SPA navigation
 * (Home → the new project → its Studio) and costs nothing when nobody reads it.
 *
 * Steps, in the order they usually happen:
 *
 * - `gesture`: the drop, paste or send (t = 0);
 * - `project-created`: Home made the project (D1);
 * - `upload-start`, `attested` (the person confirmed the attestation), `hashed` (SHA-256 of
 *   every file), `import-created` (the kernel's import session), `first-file-uploaded`,
 *   `upload-done`: the browser's side of the upload;
 * - `server:<event>`: the first time the project stream carried `import.updated`,
 *   `source.node.inspected`, `boot.started`, `boot.ready`, `item.ready` or a `drop.*` event
 *   (the server's own timestamps live in its `drop.*` log lines, §7.3);
 * - `studio:route-enter`, `studio:items-painted`, `studio:first-frame`: the Studio boot
 *   (`extension-host/boot-timing.ts`) after the gesture;
 * - `first-interactive`: the first frame of the first item (the J1 budget, §6);
 * - `drop:first-in-studio`, `drop:settled` (todo28): the first file of the timeline's drop that
 *   joined its Studio, and the moment every file of it ended (in a Studio, kept, failed), from
 *   the drop's `drop.file` / `drop.settled` events or its summary, whichever comes first.
 *
 * At `first-interactive` (or when the page hides) the durations are posted once to
 * `POST /api/v1/telemetry/timeline`: step names and milliseconds, never a name or a count of
 * anything in the files. `?timeline=1` shows the overlay (`TimelineOverlay`).
 */
export const DROP_MARK_PREFIX = `${RES}:drop:`;

export type TimelineOrigin = "home" | "projects" | "chat" | "files" | "studio" | "canvas" | "overview" | "datasets" | "send";
export type TimelineOutcome = "interactive" | "configured" | "abandoned" | "failed";

export interface TimelineStep {
  step: string;
  /** ms since the gesture. */
  ms: number;
}

export interface DropTimeline {
  active: boolean;
  origin: TimelineOrigin | null;
  dropId: string | null;
  steps: TimelineStep[];
  /** Posted to the api (once per gesture). */
  reported: boolean;
}

/** A timeline older than this is over: its late marks would only mislead. */
const MAX_AGE_MS = 10 * 60 * 1000;
const BOOT_STEPS: Record<string, string> = { "route-enter": "studio:route-enter", "items-painted": "studio:items-painted", "first-frame": "studio:first-frame" };

let current: { origin: TimelineOrigin; dropId: string | null; at: number; reported: boolean } | null = null;
let observer: PerformanceObserver | null = null;
const subscribers = new Set<() => void>();

const now = () => (typeof performance === "undefined" ? Date.now() : performance.now());
const notify = () => subscribers.forEach((fn) => fn());

function live(): boolean {
  return !!current && now() - current.at < MAX_AGE_MS;
}

function clearMarks(): void {
  if (typeof performance === "undefined") return;
  for (const m of performance.getEntriesByType("mark")) if (m.name.startsWith(DROP_MARK_PREFIX)) performance.clearMarks(m.name);
}

/** Start a timeline at the gesture: clears the previous one's marks. */
export function startTimeline(origin: TimelineOrigin, opts: { dropId?: string } = {}): void {
  if (typeof performance === "undefined") return;
  clearMarks();
  current = { origin, dropId: opts.dropId ?? null, at: now(), reported: false };
  markTimeline("gesture");
  watchBoot();
}

/** The drop's id once the api has one (drops workstream: `drop.received`). */
export function setTimelineDrop(dropId: string): void {
  if (current && !current.dropId) {
    current.dropId = dropId;
    notify();
  }
}

/** Mark a step once per timeline; ignored with no live timeline. */
export function markTimeline(step: string): void {
  if (!live() || typeof performance === "undefined" || typeof performance.mark !== "function") return;
  const name = DROP_MARK_PREFIX + step;
  if (performance.getEntriesByName(name, "mark").length) return;
  try {
    performance.mark(name);
  } catch {
    return;
  }
  notify();
  if (step === "first-interactive") void reportTimeline("interactive");
}

export function dropTimeline(): DropTimeline {
  if (!current || typeof performance === "undefined") return { active: false, origin: null, dropId: null, steps: [], reported: false };
  const start = current.at;
  const steps = performance
    .getEntriesByType("mark")
    .filter((m) => m.name.startsWith(DROP_MARK_PREFIX))
    .map((m) => ({ step: m.name.slice(DROP_MARK_PREFIX.length), ms: Math.max(0, Math.round(m.startTime - start)) }))
    .sort((a, b) => a.ms - b.ms);
  return { active: live(), origin: current.origin, dropId: current.dropId, steps, reported: current.reported };
}

/** For the overlay: re-render on every new mark. */
export function subscribeTimeline(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** The body the api accepts: durations only (routes/features.py). */
export function timelinePayload(t: DropTimeline, outcome: TimelineOutcome) {
  return {
    ...(t.dropId ? { dropId: t.dropId } : {}),
    origin: t.origin ?? "home",
    outcome,
    steps: Object.fromEntries(t.steps.slice(0, 40).map((s) => [s.step, s.ms])),
  };
}

/** Post the durations once per gesture. Best-effort: a failed post is dropped. */
export async function reportTimeline(outcome: TimelineOutcome): Promise<void> {
  if (!current || current.reported) return;
  const t = dropTimeline();
  if (t.steps.length < 2) return;
  current.reported = true;
  notify();
  try {
    await apiFetch(apiUrl("/v1/telemetry/timeline"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(timelinePayload(t, outcome)), keepalive: true });
  } catch {
    /* telemetry never gets in the way */
  }
}

/** The Studio's boot marks after the gesture become timeline steps; its first frame ends it. */
function watchBoot(): void {
  if (observer || typeof PerformanceObserver === "undefined") return;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.name.startsWith(BOOT_MARK_PREFIX) || !current || e.startTime < current.at) continue;
        const step = BOOT_STEPS[e.name.slice(BOOT_MARK_PREFIX.length)];
        if (!step) continue;
        markTimeline(step);
        if (step === "studio:first-frame") markTimeline("first-interactive");
      }
    });
    observer.observe({ type: "mark", buffered: false });
  } catch {
    observer = null;
  }
}

/** Project stream events that tell the server's side of the story (first occurrence each). */
export const SERVER_EVENTS = ["import.updated", "source.node.inspected", "boot.started", "boot.ready", "item.ready", "drop.received", "drop.file", "drop.classified", "drop.planned", "drop.applied", "drop.failed", "drop.kind_waiting", "drop.files_failed", "drop.settled"] as const;

/** States a file of a drop ends in (todo28): nothing more will happen to it on its own. */
const FILE_DONE = new Set(["in_studio", "ready", "kept", "failed", "duplicate", "removed", "deleted", "waiting_kind"]);

/**
 * todo28: what a fetched drop says about the timeline's drop: the first file in its Studio and
 * the drop settled. Other drops (and no timeline) are ignored. Takes the kernel's drop loosely.
 */
export function noteDropProgress(d: { id: string; state?: string; files?: { state: string }[]; summary?: { inStudio?: number } } | undefined): void {
  if (!d || !live() || !current?.dropId || current.dropId !== d.id) return;
  const files = d.files ?? [];
  if ((d.summary?.inStudio ?? 0) > 0 || files.some((f) => f.state === "in_studio")) markTimeline("drop:first-in-studio");
  if (files.length && files.every((f) => FILE_DONE.has(f.state))) markTimeline("drop:settled");
}

/** Called by the project stream's subscriber (`useTimelineServerEvents`). */
export function onServerEvent(type: string, data: unknown): void {
  if (!live()) return;
  if (type === "drop.received") {
    const id = (data as { dropId?: unknown } | null)?.dropId;
    if (typeof id === "string") setTimelineDrop(id);
  }
  markTimeline(`server:${type}`);
  // todo28: time to the first item in the Studio, and to the drop settled.
  const e = data as { dropId?: unknown; state?: unknown } | null;
  if (current?.dropId && e?.dropId === current.dropId) {
    if (type === "drop.file" && e.state === "in_studio") markTimeline("drop:first-in-studio");
    if (type === "drop.settled") markTimeline("drop:settled");
  }
}

if (typeof window !== "undefined") {
  // Scripts and e2e budgets read it from the page, like the boot timeline.
  (window as unknown as Record<string, unknown>)[`__${RES}DropTimeline`] = dropTimeline;
  window.addEventListener("pagehide", () => {
    if (live() && !current?.reported) void reportTimeline("abandoned");
  });
}

/** Test seam: forget the current timeline. */
export function resetTimeline(): void {
  clearMarks();
  current = null;
  notify();
}
