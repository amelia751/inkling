import type { EnvironmentSpec, LabelGroup } from "@/platform/environment";
import { migrateDocument } from "@/migrations/annotations-v1-to-v2";
import type { AnnotationDocument, Project } from "@/types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
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

/** String labels (manifest v1) become one label group; classification tasks also get an item-level Choices group. */
export function labelGroupsFrom(labels: string[], task?: string): LabelGroup[] {
  const classes = labels.map((id) => ({ id }));
  const groups: LabelGroup[] = [{ name: "labels", control: "Labels", classes }];
  if (task === "classification") groups.unshift({ name: "class", control: "Choices", classes });
  return groups;
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

  // modules/timeseries (interval, beat, wave, rhythm → span / instant):

  // modules/video (segment, event → span / instant):
  "segment", "event",

  // modules/cine (phase → instant):
  "phase",

]);

export async function fetchAnnotations(projectId: string): Promise<AnnotationDocument> {
  const doc = await json<AnnotationDocument>(await fetch(`/api/annotations/${projectId}`));
  return migrateDocument(doc, MIGRATED_V1_TYPES);
}

export async function saveAnnotations(projectId: string, doc: AnnotationDocument): Promise<AnnotationDocument> {
  return json(
    await fetch(`/api/annotations/${projectId}`, {
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
}

/** The project's saved environment edits (agent or human), or `environment: null` when it runs its manifest environment. */
export async function fetchEnvironment(projectId: string): Promise<EnvironmentDocument> {
  return json(await fetch(`/api/environments/${projectId}`));
}

export async function saveEnvironment(projectId: string, doc: { revision: number; environment: EnvironmentSpec; author?: string }): Promise<EnvironmentDocument> {
  return json(
    await fetch(`/api/environments/${projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    }),
  );
}
