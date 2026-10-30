import type { EnvironmentSpec, LabelGroup } from "../environment";

export interface SeedAsset {
  path: string;
  sha256: string;
  bytes: number;
  label?: string;
  subject?: string;
  sequence?: string;
  record?: string;
  dx?: string;
  role?: "cine" | "reference" | "thumbnail";
  /** Video / cine timing. */
  fps?: number;
  frames?: number;
  duration?: number;
  /** Cardiac phase of a reference segmentation, and its 0-based frame. */
  phase?: "ED" | "ES";
  frame?: number;
  width?: number;
  height?: number;
  /** Whole-slide metadata. */
  slide?: string;
  mpp?: number | null;
  magnification?: string | null;
  tiles?: number;
  /** Uploaded files (task documents): the original file name and its source node; `path` is content-addressed. */
  name?: string;
  nodeId?: string;
}

export interface Project {
  id: string;
  title: string;
  /**
   * The environment that boots this project's Studio: a preset reference plus project
   * specifics (labels, task). Seed manifests written before environments existed carry
   * `viewer` + `labels: string[]` instead; lib/api.ts migrates them on load.
   */
  environment: EnvironmentSpec;
  task?: string;
  /** The environment's label groups (kept in sync with `environment.labels`). */
  labels?: LabelGroup[];
  source: string;
  license: string;
  status: "available" | "bring-your-own";
  /** Source license restricts commercial use or redistribution: local development only. */
  restricted?: boolean;
  meta?: Record<string, string | number | null>;
  assets: SeedAsset[];
}

/**
 * `imported`: written from a source file (a CSV column of labels), with `attributes.source_*`
 * naming the file and row. Counts as unreviewed until a person confirms it (todo6 D8).
 */
export type Provenance = "human-created" | "ai-suggested" | "human-corrected" | "imported";

export type Plane = "axial" | "coronal" | "sagittal";

/** [x, y] in the item's native pixel/voxel space (never screen space). */
export type Pt = [number, number];

/**
 * Where an annotation lives inside a multi-frame/multi-slice item. All indices are 0-based.
 * Video uses `frame`; cine uses `frame` + `slice`; 3D volumes use `slice` + `plane`.
 */
export interface Placement {
  frame?: number;
  slice?: number;
  plane?: Plane;
}

/** Measurement kinds shared by the radiology viewers (mirrors Cornerstone3D tool names). */
export type MeasurementKind =
  | "length"
  | "angle"
  | "cobb"
  | "bidirectional"
  | "probe"
  | "arrow"
  | "ellipse-roi"
  | "rectangle-roi"
  | "freehand-roi";

/** Shape tracked through video frames; interpolated between keyframes. */
export interface TrackKeyframe {
  frame: number;
  /** Object left the field of view from this frame until the next keyframe. */
  outside?: boolean;
  occluded?: boolean;
  /** Box: [x, y, w, h]. Polygon / keypoint: vertex list. */
  box?: [number, number, number, number];
  points?: Pt[];
}

/**
 * Annotation geometry. Core geometries are domain-neutral and bare-named; module
 * geometries are namespaced (`<module>.<name>`) and validated by the registry. Domain
 * vocabulary (ECG beat codes, cardiac phases…) belongs in `Annotation.attributes`, refined
 * by the owning module's `geometries` contribution (see migrations/annotations-v1-to-v2.ts).
 */
export type Geometry = CoreGeometry | ModuleGeometry | LegacyGeometry;

/** A module-defined geometry, e.g. `{ type: "inkling.text.span", start, end }`. */
export interface ModuleGeometry {
  type: `${string}.${string}`;
  [k: string]: unknown;
}

export type CoreGeometry =
  | { type: "class" }
  // ---- 2D shapes in image pixels ----
  | ({ type: "box"; x: number; y: number; w: number; h: number } & Placement)
  | ({ type: "ellipse"; cx: number; cy: number; rx: number; ry: number; rotation?: number } & Placement)
  /** Closed contour; `holes` are inner rings (pathology brush/erase can create them). */
  | ({ type: "polygon"; points: Pt[]; holes?: Pt[][] } & Placement)
  /** Several disjoint regions with holes: each entry is [outer, ...holes]. */
  | ({ type: "multipolygon"; polygons: Pt[][][] } & Placement)
  | ({ type: "polyline"; points: Pt[] } & Placement)
  /** Smooth closed contour defined by editable control points (centripetal Catmull-Rom, α=0.5). */
  | ({ type: "spline"; points: Pt[] } & Placement)
  /** Single 2D location, e.g. an anatomical landmark. */
  | ({ type: "keypoint"; x: number; y: number } & Placement)
  // ---- Radiology (Cornerstone3D) ----
  /** 3D landmark in voxel indices. */
  | { type: "point3d"; plane: Plane; slice: number; ijk: [number, number, number] }
  /**
   * Measurement / ROI drawn with a Cornerstone3D tool. `points` are in image pixels for 2D
   * items and in world (patient LPS, mm) coordinates for volumes; `space` says which.
   * `stats` are the values shown to the expert (length mm, area mm², mean, std, HU…).
   */
  | ({
      type: "measurement";
      kind: MeasurementKind;
      points: number[][];
      space: "image" | "world";
      stats?: Record<string, number>;
      unit?: string;
      text?: string;
    } & Placement)
  /**
   * Voxel/pixel mask for one label, run-length encoded over the flattened item grid
   * (x fastest, then y, then z). `counts` alternate background/foreground runs, starting
   * with background. `dims` is the full grid so a mask can be decoded without the image.
   */
  | ({ type: "mask"; dims: number[]; counts: number[]; voxels?: number; volumeMm3?: number } & Placement)
  // ---- Time ----
  /** A span on a time axis, in seconds; `channel` is a lead / signal name ("all" = every channel). */
  | { type: "span"; start: number; end: number; channel?: string }
  /** A point in time: seconds (`t`) or a frame index (`frame`); optional `channel`. */
  | { type: "instant"; t?: number; frame?: number; channel?: string }
  /** An object tracked across frames with keyframes; shapes in between are interpolated. */
  | { type: "track"; shape: "box" | "polygon" | "keypoint"; keyframes: TrackKeyframe[] };

/**
 * Geometries from before the core vocabulary (annotations v1). Stored documents are
 * rewritten into core geometries on load by migrations/annotations-v1-to-v2.ts; viewers
 * still producing them are converted module by module (todo phase 6).
 */
export type LegacyGeometry =
  /** Single location in image pixels, e.g. a cell on a whole-slide image. (v2: keypoint) */
  | { type: "mark"; x: number; y: number }
  /** 3D landmark in voxel indices. (v2: point3d) */
  | { type: "point"; plane: Plane; slice: number; ijk: [number, number, number] }
  // ---- Signal (ECG) — times in seconds; lead "all" applies to every lead ----
  | { type: "interval"; lead: string; start: number; end: number }
  /** Beat fiducial (usually R peak) with a WFDB beat code (N, V, A, …). */
  | { type: "beat"; lead: string; t: number; code: string }
  /** Wave delineation (LUDB style): onset / peak / offset of P, QRS or T on one lead. */
  | { type: "wave"; lead: string; wave: "P" | "QRS" | "T"; onset: number; peak?: number; offset: number }
  /** Rhythm episode, WFDB aux string such as "(N", "(AFIB". */
  | { type: "rhythm"; start: number; end: number; rhythm: string }
  // ---- Video ----
  /** Time span of a video, in seconds. */
  | { type: "segment"; start: number; end: number }
  /** Point-in-time event (e.g. polyp first seen), in frames. */
  | { type: "event"; frame: number }
  /** Cardiac phase marker for a cine study: which frame is end-diastole / end-systole. */
  | { type: "phase"; phase: "ED" | "ES"; frame: number };

export type GeometryType = Geometry["type"];

export interface Annotation {
  id: string;
  /** Item the annotation belongs to: an asset path, or a subject id for multi-file volumes. */
  itemId: string;
  label: string;
  geometry: Geometry;
  provenance: Provenance;
  author: string;
  createdAt: string;
  updatedAt?: string;
  /** Free-form per-annotation attributes (e.g. occluded, WFDB aux text, track id). */
  attributes?: Record<string, string | number | boolean>;
  /** Locked annotations can be seen and selected but not moved, edited or deleted. */
  locked?: boolean;
  hidden?: boolean;
}

export interface AnnotationDocument {
  /** Geometry vocabulary version; absent means 1 (pre-core geometries). */
  annotationsVersion?: number;
  revision: number;
  savedAt?: string;
  annotations: Annotation[];
}

/** A unit the expert works through in the file tree (one image, one MRI subject, one ECG). */
export interface StudioItem {
  id: string;
  /** Full id of the data kind contribution that grouped this item. */
  dataKind?: string;
  name: string;
  group: string;
  assets: SeedAsset[];
  sourceLabel?: string;
}

// ---- Projects, sources, datasets and tasks (todo6 Phase 1, docs/ux.md §2) -----------------
// Shapes of the kernel's /api/v1/projects… routes (apps/api/src/studio_api/routes/projects.py,
// sources.py, explore.py); the dev seed server serves the read-only subset (todo6 D4).

/** Where a person left off in a project (todo6 D9). */
export interface ResumeState {
  taskId: string;
  taskTitle: string;
  taskKind: string;
  datasetId: string;
  itemId: string | null;
  placement: Placement | null;
  tool: string | null;
  at: string;
}

export interface ProjectSummary {
  id: string;
  orgId: string;
  title: string;
  description: string;
  visibility: "private" | "shared";
  /** A seed project from seed-data/manifest.json ("Sample" badge). */
  sample: boolean;
  archived: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  resume: ResumeState | null;
  /** Whether this person already confirmed the rights attestation in this project. */
  attested: boolean;
  license?: string;
  restricted?: boolean;
}

/** Plain-language kinds the worker detects (todo6 §3 "File kinds"); `folder` for folders. */
export type DetectedKind =
  | "folder"
  | "image"
  | "dicom"
  | "dicom-series"
  | "volume"
  | "video"
  | "waveform"
  | "slide"
  | "table"
  | "document"
  | "mask"
  | "annotations"
  | "archive"
  | "unknown";

/** One status per row: `checking` until inspected, then the most urgent flag. */
export type SourceNodeStatus = "checking" | "ready" | "attention" | "privacy" | "unsupported";

export interface PrivacyFlag {
  reason: string;
  fields?: string[];
  clearedBy?: string;
  clearedAt?: string;
  clearReason?: string;
}

export interface SourceNode {
  id: string;
  sourceId: string;
  parentId: string | null;
  name: string;
  /** A compact chain of single-child folders, e.g. `MRI / patient_002` (the row is the last one). */
  displayPath?: string;
  /** `sequence`: a collapsed run of numbered files (`scan001–scan120.dcm`), id `seq:<folder>:<key>`. */
  kind: "folder" | "file" | "sequence";
  detectedKind: DetectedKind | null;
  size: number | null;
  sha256: string | null;
  childCount: number;
  descendantCount: number;
  facts: Record<string, unknown>;
  flags: { privacy?: PrivacyFlag; duplicate_of?: { nodeId: string; name: string }; unsupported?: string; quality?: string[] };
  status: SourceNodeStatus;
  importSessionId: string | null;
  createdAt: string | null;
  /** Search results only: the folder the file is in. */
  folderPath?: string;
}

export interface SourceNodeDetail extends SourceNode {
  path: { id: string; name: string }[];
  usedIn: { id: string; title: string; tasks: { id: string; title: string }[] }[];
  provenance: { sourceId: string; sourceTitle: string | null; importSessionId: string | null; addedBy: string | null; addedAt: string | null; sha256: string | null };
}

export interface SourceSummary {
  id: string;
  projectId: string;
  title: string;
  kind: "upload" | "seed" | "connector";
  status: string;
  rootNodeId: string | null;
  fileCount: number;
  createdBy: string;
  createdAt: string | null;
  usedInDatasets: string[];
}

export interface ChildrenPage {
  items: SourceNode[];
  total: number;
  nextCursor: string | null;
}

export type ImportState = "uploading" | "inspecting" | "needs_review" | "ready" | "imported" | "failed" | "cancelled";
export type UploadFileState = "pending" | "uploaded" | "skipped_duplicate" | "rejected" | "failed";

export interface ImportSession {
  id: string;
  projectId: string;
  sourceId: string;
  targetNodeId: string | null;
  state: ImportState;
  totals: { files: number; bytes: number; receivedBytes: number; byState: Partial<Record<UploadFileState, number>>; skippedSystemFiles?: number; committed?: number; incomplete?: boolean };
  createdBy: string;
  attestedBy: string | null;
  attestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  files?: { clientFileId: string; relPath: string; size: number; sha256: string; received: number; state: UploadFileState; reason: string | null; uploadUrl: string | null }[];
}

export type ProposalKind = "group" | "relationship" | "mapping" | "dataset" | "task";
/** Shown as words, never percentages: Strong / Possible / Weak match. */
export type ProposalStrength = "strong" | "possible" | "weak";

export interface Proposal {
  id: string;
  projectId: string;
  kind: ProposalKind;
  payload: Record<string, unknown>;
  evidence: Record<string, unknown>;
  strength: ProposalStrength;
  status: "proposed" | "confirmed" | "dismissed" | "superseded";
  importSessionId: string | null;
  /** `worker:inspect`, `agent:<run>` or `user:…`. */
  createdBy: string;
  createdAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface TaskSummary {
  id: string;
  datasetId: string;
  projectId: string;
  title: string;
  kind: string;
  revision: number;
  annotationCount: number;
  annotatedItems: number;
  createdAt: string | null;
}

export interface DatasetSummary {
  id: string;
  projectId: string;
  title: string;
  description: string;
  definition: { nodeIds?: string[]; seed?: boolean; labels?: Record<string, string>; [k: string]: unknown };
  fileCount: number;
  tasks: TaskSummary[];
  createdFromProposalId: string | null;
  createdBy: string;
  createdAt: string | null;
}

/** Where an attention row (or an activity entry) resolves. */
export interface ProjectTarget {
  section: "overview" | "sources" | "explore" | "datasets" | "studio" | "review" | "activity";
  nodeId?: string;
  importId?: string;
  proposalId?: string;
  tab?: string;
  taskId?: string;
  datasetId?: string;
  status?: string;
}

export interface AttentionItem {
  id: string;
  type: "privacy" | "import" | "quality" | "proposal" | "annotations" | "version-review";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  strength?: ProposalStrength;
  target: ProjectTarget;
  datasetId?: string;
  at: string | null;
}

export interface DataCard {
  type: "dataset" | "source";
  id: string;
  title: string;
  count: number;
  kind: DetectedKind | null;
  kindLabel: string;
  datasetId?: string;
  sourceId?: string;
  nodeId?: string | null;
}

/** GET /v1/projects/:id/overview; a block with nothing to show is absent. */
export interface ProjectOverview {
  project: ProjectSummary;
  resume?: ResumeState;
  tasks: { id: string; title: string; kind: string; datasetId: string }[];
  data?: DataCard[];
  attention?: AttentionItem[];
  attentionTotal?: number;
  empty: boolean;
  latestImport?: { id: string; state: ImportState };
}

export interface ActivityEntry {
  id: string;
  action: string;
  label: string;
  actor: string | null;
  onBehalfOf?: string | null;
  target: string | null;
  details: unknown;
  at: string | null;
  link: ProjectTarget | null;
}

/** GET /v1/tasks/:id/document: a `Project`-shaped document, so every viewer works unchanged. */
export type TaskDocument = Project & { projectId?: string };

// ---- Explore (todo6 Phase 5) -------------------------------------------------------------------

export interface RelationshipTargetRef {
  nodeId: string;
  name: string;
  path: string;
  kind: "file" | "folder";
}

/** `evidence` of a relationship proposal: computed by the kernel, recomputed on every edit. */
export interface RelationshipEvidence {
  column: string;
  target: "files" | "folders";
  rule: "exact" | "normalized" | "numeric";
  ruleLabel: string;
  rows: number;
  matched: number;
  unmatched: number;
  ambiguous: number;
  skipped: number;
  resolved: number;
  empty: number;
  repeatedIds: number;
  examples: { row: number; value: string; target: RelationshipTargetRef; manual?: boolean }[];
  unmatchedRows: { row: number; value: string }[];
  ambiguousRows: { row: number; value: string; candidates: RelationshipTargetRef[] }[];
  why: string[];
  summary?: string;
}

export interface ExploreRecord {
  id: string;
  type: "series" | "table" | "documents" | "files";
  title: string;
  detail?: string | null;
  status: "detected" | "proposed" | "confirmed";
  nodeId?: string | null;
  proposalId?: string;
  strength?: ProposalStrength;
}

export interface ExploreTaskRow {
  id: string;
  title: string;
  detail?: string | null;
  status: "proposed" | "confirmed";
  taskId?: string;
  datasetId?: string;
  proposalId?: string;
  strength?: ProposalStrength;
}

export interface QualityItem {
  id: string;
  type: "privacy" | "unsupported" | "duplicate" | "series" | "mismatch" | "missing";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  target: ProjectTarget;
}

/** GET /v1/projects/:id/explore: Summary (files → records → tasks) and the Quality list. */
export interface ExploreSummary {
  files: { total: number; byKind: { kind: string; label: string; count: number }[]; facts: string[] };
  records: ExploreRecord[];
  tasks: ExploreTaskRow[];
  quality: QualityItem[];
  clean: boolean;
  openProposals: number;
  readyProposalId?: string;
}

/** GET /v1/proposals/:id/preview: what confirming a dataset proposal will do. */
export interface ProposalPreview {
  proposal: Proposal;
  title?: string;
  taskTitle?: string;
  preset?: string;
  kind?: string;
  files?: number;
  heldFiles?: number;
  items?: number;
  grouping?: string;
  groups?: { label: string; count: number }[];
  labelClasses?: string[];
  importedLabels?: number;
  labelsFrom?: string | null;
  alsoConfirms?: Proposal[];
  blocking?: { nodeId: string; reason: string }[];
  examples?: { nodeId: string; name: string; label: string | null }[];
}
