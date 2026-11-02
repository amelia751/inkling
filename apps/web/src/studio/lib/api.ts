import type { EnvironmentSpec, LabelGroup } from "@studio/contracts/environment";
import { migrateDocument } from "@studio/contracts/migrations/annotations-v1-to-v2";
import type { AnnotationDocument, Project } from "@studio/contracts/types";
import { canonicalId } from "@studio/contracts/naming";
import { apiUrl, runtimeConfig } from "@/extension-host/runtime-config";
import { apiFetch } from "@/extension-host/http";
import { ensureOk } from "./problem";

async function json<T>(res: Response): Promise<T> {
  await ensureOk(res); // todo18 D2: failures throw ProblemError
  return res.json() as Promise<T>;
}

export const seedUrl = (path: string) => `/seed/${path}`;

/** Seed manifests from before environments named one of six hardcoded viewers. */
const LEGACY_PRESETS: Record<string, string> = {
  "image-2d": "preset:image-2d",
  "volume-3d": "preset:volume-3d",
  signal: "preset:ecg",
  temporal: "preset:video",
  "cine-4d": "preset:cine-4d",
  pathology: "preset:pathology",
};

type RawProject = Omit<Project, "environment" | "labels"> & {
  environment?: EnvironmentSpec;
  viewer?: string;
  labels?: (string | LabelGroup)[];
};

/** String labels (manifest v1) become one label group: region `Labels`, or an item-level `Choices` group for classification tasks. */
export function labelGroupsFrom(labels: string[], task?: string): LabelGroup[] {
  const classes = labels.map((id) => ({ id }));
  // A classification task gets only its Choices group (todo8 D4; tools/fetch-seeds.py does the same).
  if (task === "classification") return [{ name: "class", control: "Choices", classes }];
  return [{ name: "labels", control: "Labels", classes }];
}

/**
 * Migration shim: `viewer: "pathology"` + `labels: ["tumor", …]` → `environment:
 * { extends: "preset:pathology", labels: [group] }`. Manifests that already carry an
 * environment pass through (their `viewer` is kept only for older checkouts).
 */
export function normalizeProject(raw: RawProject): Project {
  const stringLabels = raw.labels?.every((l) => typeof l === "string") ? (raw.labels as string[]) : undefined;
  const groupLabels = stringLabels ? undefined : (raw.labels as LabelGroup[] | undefined);
  const environment: EnvironmentSpec = raw.environment
    ? { ...raw.environment }
    : { extends: LEGACY_PRESETS[raw.viewer ?? ""] ?? `preset:${raw.viewer}` };
  environment.task ??= raw.task;
  environment.labels ??= groupLabels ?? (stringLabels ? labelGroupsFrom(stringLabels, raw.task) : undefined);
  const { viewer: _viewer, labels: _labels, ...rest } = raw;
  return { ...rest, environment, labels: environment.labels };
}

export async function fetchProjects(): Promise<Project[]> {
  const manifest = await json<{ projects: RawProject[] }>(await fetch(seedUrl("manifest.json")));
  return manifest.projects.map(normalizeProject);
}

/**
 * v1 geometry types whose modules now read core geometries. Grows as each viewer is
 * converted (todo phase 6); the rest stay as stored until their module catches up.
 */
export const MIGRATED_V1_TYPES = new Set<string>([
  // modules/wsi (mark → keypoint):
  "mark",

  // modules/volume (point → point3d):
  "point",
  // modules/timeseries (interval, beat, wave, rhythm → span / instant):
  "interval", "beat", "wave", "rhythm",

  // modules/video (segment, event → span / instant):
  "segment", "event",

  // modules/cine (phase → instant):
  "phase",

]);

export async function fetchAnnotations(projectId: string): Promise<AnnotationDocument> {
  const doc = migrateDocument(await json<AnnotationDocument>(await apiFetch(apiUrl(`/annotations/${projectId}`))), MIGRATED_V1_TYPES);
  // Module geometry types are full ids (`<namespace>.<module>.<name>`); keep old namespaces readable.
  return { ...doc, annotations: doc.annotations.map((a) => (canonicalId(a.geometry.type) === a.geometry.type ? a : { ...a, geometry: { ...a.geometry, type: canonicalId(a.geometry.type) } as typeof a.geometry })) };
}

export async function saveAnnotations(projectId: string, doc: AnnotationDocument): Promise<AnnotationDocument> {
  return json(
    await apiFetch(apiUrl(`/annotations/${projectId}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    }),
  );
}

export interface EnvironmentDocument {
  revision: number;
  environment: EnvironmentSpec | null;
  savedAt?: string;
  author?: string;
  /** RFC 8785 hash of `environment` (todo10 Phase 1); history rows also carry their parent's. */
  contentHash?: string;
  parentHash?: string;
  authorKind?: "person" | "agent";
  agentRunId?: string;
  promptHash?: string;
}

/** Who made an environment change, when it was the assistant (recorded on the revision). */
export interface ChangeProvenance {
  kind: "agent";
  runId?: string;
  promptHash?: string;
}

/** The project's saved environment edits (agent or human), or `environment: null` when it runs its manifest environment. */
export async function fetchEnvironment(projectId: string): Promise<EnvironmentDocument> {
  return json(await apiFetch(apiUrl(`/environments/${projectId}`)));
}

export async function saveEnvironment(projectId: string, doc: { revision: number; environment: EnvironmentSpec; author?: string; provenance?: ChangeProvenance }): Promise<EnvironmentDocument> {
  return json(
    await apiFetch(apiUrl(`/environments/${projectId}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    }),
  );
}

/**
 * The document a task's Studio opens (todo6 Phase 7): a `Project`-shaped document, so every
 * data kind's `groupItems(project)` works unchanged. It's `GET /v1/tasks/:id/document`, served
 * by the kernel or, without it, by the dev seed server's stand-in (same shape). In seed mode a
 * task the stand-in doesn't list (a project e2e tests inject into `/seed/manifest.json`) is
 * read from the served manifest instead, without a 404 in the console.
 */
export async function fetchTaskDocument(taskId: string): Promise<Project | undefined> {
  const { kernel } = runtimeConfig();
  if (!kernel) {
    // Seeds: one project, dataset and task per manifest entry, sharing its id (todo6 D2).
    const listed = await json<{ projects: { id: string }[] }>(await apiFetch(apiUrl("/v1/projects")));
    if (!listed.projects.some((p) => p.id === taskId)) return (await fetchProjects()).find((p) => p.id === taskId);
  }
  const res = await apiFetch(apiUrl(`/v1/tasks/${encodeURIComponent(taskId)}/document`));
  // 410: the Studio is in Trash (todo18); the page reads `trashed` from GET /tasks/{id}?includeTrashed=true.
  if (res.status === 404 || res.status === 410) return undefined;
  return normalizeProject(await json<RawProject>(res));
}
