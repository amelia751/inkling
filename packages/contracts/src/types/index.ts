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
  /** todo8 D3: the node's current Data folder below the task's common folder (task documents). */
  folder?: string[];
  /** todo11 D8: an item dropped into a Studio, while (and after) it ingests. */
  ingest?: AssetIngest;
  /** todo18 D5: per-item meta from a sidecar (ACDC Info.cfg: `ed`/`es` 0-based frames, group, height, weight). */
  meta?: Record<string, string | number | null>;
  /** todo18 D4: the browser-viewable file the worker made (video → MP4, slide → DZI). */
  derivative?: AssetDerivative;
}

export interface AssetDerivative {
  kind: "video-mp4" | "slide-dzi" | string;
  state: "processing" | "ready" | "failed";
  progress?: number;
  /** "Converting video" / "Preparing slide". */
  label?: string;
  error?: string;
  /** Asset path of the derivative when ready (sign with `assetUrl`). */
  src?: string;
}

/** The path a viewer opens: the derivative when one is ready, else the file itself. */
export function viewPath(asset: Pick<SeedAsset, "path" | "derivative">): string {
  return asset.derivative?.state === "ready" && asset.derivative.src ? asset.derivative.src : asset.path;
}

/** What to show instead of the viewer while a derivative is made or after it failed; null when the file can open. */
export function derivativeNotice(asset: Pick<SeedAsset, "derivative">): { busy: boolean; text: string } | null {
  const d = asset.derivative;
  if (!d || d.state === "ready") return null;
  if (d.state === "failed") return { busy: false, text: d.error || "This file couldn't be converted" };
  const label = d.label || (d.kind === "slide-dzi" ? "Preparing slide" : "Converting video");
  return { busy: true, text: d.kind === "slide-dzi" ? `${label} (${Math.round(d.progress ?? 0)} %)` : `${label}…` };
}

/** Item lifecycle (todo11 §6): `item.<state>` events on the project stream move an item along. */
export type IngestState = "registered" | "uploaded" | "probed" | "thumb_ready" | "preview_ready" | "ready" | "failed";

export interface AssetIngest {
  state: IngestState;
  /** Cursor order of the item in its task (`GET /v1/tasks/:id/items`). */
  seq?: number;
  /** Asset paths of the 256 px WebP thumbnail and the ~1600 px preview (sign with `assetUrl`). */
  thumb?: string;
  preview?: string;
  /** Base64 ThumbHash: a blurred placeholder with the image's aspect ratio. */
  thumbhash?: string;
  error?: string;
}

/** `item.*` event payload (todo11 §6 contracts). */
export interface ItemEvent {
  taskId?: string;
  itemId: string;
  nodeId: string;
  kind: string;
  meta?: { at?: number; name?: string; bytes?: number; seq?: number; width?: number; height?: number; format?: string; thumb?: string; thumbhash?: string; preview?: string; error?: string; reason?: string };
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
  /** todo8 D3: the item's Data folder segments below the task's common folder (display only). */
  folder?: string[];
  /** todo8 D3: the source node of the item's first asset, for "Show in Data". */
  nodeId?: string;
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
  /** A sample: a seed template, or a person's copy of one (todo14 D2; "Sample" badge). */
  sample: boolean;
  /** todo14 D2: the template this project was copied from ("Try a sample"); null or absent for templates and ordinary projects. */
  sampleOf?: string | null;
  archived: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  resume: ResumeState | null;
  /** Whether this person already confirmed the rights attestation in this project. */
  attested: boolean;
  /** todo13 D14: this person's role in the project's organization (`viewer` can't drop or edit). */
  role?: "owner" | "admin" | "editor" | "contributor" | "viewer" | string | null;
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
  sourceId: string | null;
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
  /** todo7: the namespace. All optional so the seed stand-in (read-only) needn't send them. */
  /** The caller starred this node. */
  starred?: boolean;
  /** Sample data (D2), or inside it: edit actions are disabled with a reason. */
  locked?: boolean;
  /** Files: the current version number (1 = as uploaded, D6). */
  version?: number;
  /** Folders: bytes of every file below (not in Trash). */
  totalBytes?: number | null;
  /** In Trash (only Trash listings return these). */
  trashed?: boolean;
}

export interface SourceNodeDetail extends SourceNode {
  path: { id: string; name: string }[];
  /** The numbered run (`seq:…`, an opaque id) a file is collapsed into in its folder, if any. */
  runId?: string | null;
  usedIn: { id: string; title: string; tasks: { id: string; title: string }[] }[];
  provenance: {
    sourceId: string;
    sourceTitle: string | null;
    importSessionId: string | null;
    addedBy: string | null;
    addedAt: string | null;
    sha256: string | null;
    /** todo13: `chat` for files shared in a conversation. */
    sourceKind?: "upload" | "seed" | "connector" | "chat" | null;
    /** todo13 D4: "Shared in chat · <conversation> · <date>". */
    drop?: import("../drops").DropProvenance;
  };
  /** todo7 D4: the current path, computed from the parent chain ("Files/MRI/scan001.dcm" without the root). */
  pathText?: string;
  /** The path as uploaded (immutable). Sensitive (Phase 7): members only, never in agent context or exports. */
  originalPath?: string | null;
  /** In Trash: when, by whom, and where it was. */
  trash?: { trashedAt: string; trashedBy: string; originalParentId: string | null; originalLocation: string | null } | null;
}

// ---- Files: the project's drive (todo7) ------------------------------------------------------------

/** The one root per project (D1). `GET /v1/projects/:id/fs` */
export interface DriveInfo {
  projectId: string;
  rootNodeId: string;
  /** Namespace writes need the full stack (D12): the seed stand-in answers `false`. */
  writable: boolean;
  trashCount: number;
}

export type FsOp =
  | { kind: "mkdir"; parentId: string; name: string; /** client-chosen id for optimistic rows (`nod-<uuid>`) */ id?: string }
  | { kind: "rename"; nodeId: string; name: string }
  | { kind: "move"; nodeIds: string[]; parentId: string }
  | { kind: "copy"; nodeIds: string[]; parentId: string }
  | { kind: "trash"; nodeIds: string[] }
  | { kind: "restore"; nodeIds: string[] }
  | { kind: "purge"; nodeIds: string[] };

export type FsOpKind = FsOp["kind"] | "replace" | "restore_version" | "undo" | "redo";

/** How to settle one name conflict (§2 conflict dialog). `replace` is files only (adds a version, D6); `merge` folders only. */
export type FsResolution = "keep_both" | "replace" | "skip" | "merge";

export interface FsConflict {
  /** The node being moved/copied/created (or the upload's client file id). */
  nodeId: string;
  name: string;
  /** The folder it would land in, and the sibling already there. */
  parentId: string;
  parentName: string;
  existingId: string;
  kind: "file" | "folder";
  /** Same sha256 as the existing file: the client may skip silently. */
  identical: boolean;
}

export interface FsOpsRequest {
  ops: FsOp[];
  /** By conflicting nodeId, or `"*"` for every conflict. */
  resolutions?: Record<string, FsResolution>;
  /** Optimistic concurrency: folder id → revision the client last saw (optional). */
  expect?: Record<string, number>;
}

export interface FsOpsResult {
  batchId: string;
  /** Every node created or changed, in their new state. */
  nodes: SourceNode[];
  /** Folders whose children changed (the client invalidates these). */
  parentIds: string[];
  /** Human summary, e.g. "Moved 3 items to MRI". */
  summary: string;
  skipped?: { identical: number; byResolution: number };
  /** e.g. "LV segmentation still uses 2 of these" (trash of dataset files). */
  warnings?: string[];
}

/** Body of a 409 from `fs/ops`: `{ detail: { message, conflicts } }`. */
export interface FsConflictError {
  message: string;
  conflicts: FsConflict[];
}

/** `POST /v1/projects/:id/fs/undo|redo` → the batch that was undone or redone. 409 `{ detail: string }` when refused (D9). */
export interface FsUndoResult extends FsOpsResult {
  undoneBatchId: string;
  /** What the next undo would do (for the hint), or null. */
  next: { batchId: string; label: string } | null;
}

export interface TrashItem extends SourceNode {
  trashedAt: string;
  /** Who deleted it; `viaAssistant` when their assistant did (todo16). */
  trashedBy: { id: string; name: string; viaAssistant: boolean } | string;
  /** Legacy display name of who deleted it. */
  trashedByName?: string;
  /** "MRI/patient_002" (current path of the folder it was in), or null if that folder is gone. */
  originalLocation: string | null;
  /** Days left before the purge job deletes it. */
  purgeInDays: number;
}

export interface TrashPage {
  items: TrashItem[];
  nextCursor: string | null;
  total: number;
}

export interface NodeVersion {
  version: number;
  assetId: string;
  sha256: string | null;
  size: number | null;
  createdBy: string;
  createdAt: string;
  current: boolean;
}

export interface FsActivityEntry {
  id: string;
  batchId: string;
  kind: FsOpKind;
  actor: string;
  at: string;
  /** Plain sentence, e.g. "Renamed from Smith_J_MRI" — old names only to members, never sent to the assistant. */
  text: string;
  nodeId: string;
}

/** `GET /v1/projects/:id/recent` and `/starred`. */
export interface FsShortcut {
  node: SourceNode;
  at: string | null;
}

/** Dataset definitions after todo7 D7: frozen files plus followed folders. */
export interface DatasetFileRef {
  nodeId: string;
  assetId: string | null;
  version: number;
}

export interface SourceSummary {
  id: string;
  projectId: string;
  title: string;
  kind: "upload" | "seed" | "connector" | "chat";
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
  /** todo13: the drop (one gesture) this session belongs to. */
  dropId?: string | null;
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
  /** todo11 D1: a boot creates a draft; only a person publishes it. */
  state?: "draft" | "published";
  bootId?: string | null;
  /** todo13 D7: the collection this task works on; absent or null = every collection (tasks made before collections). */
  collectionId?: string | null;
}

export interface DatasetSummary {
  id: string;
  projectId: string;
  title: string;
  description: string;
  definition: { nodeIds?: string[]; files?: DatasetFileRef[]; followedFolders?: string[]; seed?: boolean; labels?: Record<string, string>; [k: string]: unknown };
  fileCount: number;
  tasks: TaskSummary[];
  createdFromProposalId: string | null;
  createdBy: string;
  createdAt: string | null;
  /** todo7 D6/D7: pinned files with a newer version, and new files in followed folders since creation. */
  staleness?: { newerVersions: number; newFilesInFollowed: number; followedFolderNames: string[] };
}

// ---- Dataset profile (docs/datasets.md §11.1, Phase 1) ------------------------------------------

/**
 * `GET /v1/projects/:p/datasets/:d/profile`: what a dataset holds and how it is shaped, read from
 * the inspection of the files it pins. Never a cell value, a DICOM identifier or a file path:
 * counts, kinds, formats, column names and types, and kernel-written flag reasons only.
 */
export interface DatasetProfile {
  datasetId: string;
  /** The snapshot these numbers describe. Phase 1 reads the working draft (the pinned files). */
  snapshot: { kind: "draft" | "main" | "release"; label: string; readOnly: boolean };
  /** Pinned files that still exist. */
  files: number;
  /** Files the worker hasn't inspected yet ("Checking"). */
  checking: number;
  collections: DatasetCollection[];
  relationships: DatasetRelationship[];
  issues: DatasetIssue[];
}

/**
 * One logical collection. Phase 1 infers them from detected kinds (one per kind), so every
 * collection is `suggested` until a person confirms the dataset's structure (todo13 D8).
 */
export interface DatasetCollection {
  /** Stable for the dataset: `kind:<detected kind>`. */
  id: string;
  name: string;
  kind: DetectedKind;
  /** Logical items, counted at the level `unit` names (a DICOM series, not its files). */
  count: number;
  unit: { one: string; other: string };
  /** Files backing those items. */
  files: number;
  formats: { label: string; count: number }[];
  /** Shape facts, each a distribution ("Image size": 512×512 × 80). `missing`: items without it. */
  facts: DatasetFact[];
  fields: DatasetField[];
  /** A representative file for a preview (the first ready, unflagged one), or null. */
  previewNodeId: string | null;
  suggested: boolean;
  /** Items with at least one issue. */
  issues: number;
}

export interface DatasetFact {
  key: string;
  label: string;
  /** Most common first; at most 6. */
  values: { value: string; count: number }[];
  /** Distinct values beyond the first 6. */
  more: number;
  missing: number;
}

/** A field of a collection: a table's column, or a technical property every item carries. */
export interface DatasetField {
  /** Stable within the collection: `col:<name>` or `fact:<key>`. */
  id: string;
  name: string;
  type: "integer" | "number" | "decimal" | "text" | "category" | "id" | "date" | "boolean" | "empty" | "list" | string;
  unit?: string;
  required: boolean;
  /** Share of items (or rows) where it is filled, 0–1. */
  filled: number;
  /** A unique key in every table that has it. */
  key?: boolean;
  description?: string;
  source: "inspection" | "structure";
  suggested?: boolean;
}

export interface DatasetRelationship {
  id: string;
  /** Collection ids. */
  from: string;
  to: string;
  /** "Each row of the table describes one image". */
  label: string;
  cardinality: "1:1" | "1:N" | "N:1" | "N:N";
  /** "patient_id → folder name". */
  keys: string;
  status: "suggested" | "confirmed";
  coverage?: { rows: number; matched: number; unmatched: number; ambiguous: number };
  strength?: ProposalStrength;
  proposalId?: string;
}

export type DatasetIssueCategory = "privacy" | "unreadable" | "duplicate" | "quality" | "identity" | "checking";

export interface DatasetIssue {
  /** Stable: `<ruleId>:<collection>`. */
  id: string;
  category: DatasetIssueCategory;
  severity: "high" | "medium" | "low";
  /** Blocks a release under the project's policy. Separate from severity (§8). */
  blocking: boolean;
  title: string;
  detail: string;
  /** Affected items. */
  count: number;
  /** Rule id and version, e.g. `inspection.privacy@1`. */
  ruleId: string;
  collectionId?: string;
  /** The first affected files (ids only, at most 50). */
  nodeIds: string[];
  action: { label: string; target: ProjectTarget };
}

/** Where an attention row (or an activity entry) resolves. */
export interface ProjectTarget {
  section: "overview" | "sources" | "explore" | "datasets" | "studio" | "review" | "activity" | "settings";
  nodeId?: string;
  importId?: string;
  proposalId?: string;
  tab?: string;
  taskId?: string;
  datasetId?: string;
  status?: string;
  /** A version review request (`tab: "versions"`). */
  reviewId?: string;
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
  /** `state`: a boot's draft until a person publishes it (todo11 D1). */
  tasks: { id: string; title: string; kind: string; datasetId: string; state?: "draft" | "published" }[];
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
  /** Who, in words: a person, the assistant for a person (SessionDelegation), or the system. */
  who?: ActivityActor;
  /** The thing acted on, by name (a dataset, task or plugin; never a file path). */
  subject?: string | null;
  /** todo16 D9: an assistant turn's changes as one row ("Ana's assistant: renamed 3 items, …"). */
  kind?: "batch";
  actorLabel?: string;
  summary?: string;
  batchId?: string;
  turnId?: string;
  /** The turn is the project's latest change and can still be undone as one step. */
  undoable?: boolean;
}

export interface ActivityActor {
  kind: "person" | "assistant" | "system";
  name: string;
  onBehalfOf: string | null;
}

/** GET /v1/projects/:id/review: the filtered queue; `facets` count the unfiltered one. */
export interface ReviewQueue {
  items: AttentionItem[];
  total: number;
  facets: {
    types: Partial<Record<AttentionItem["type"], number>>;
    severities: Partial<Record<AttentionItem["severity"], number>>;
    datasets: { id: string; title: string; count: number }[];
  };
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
  /** "trashed": the file is in Trash (todo16 D4); `trashBatchId` restores it. */
  status: "detected" | "proposed" | "confirmed" | "trashed";
  nodeId?: string | null;
  proposalId?: string;
  strength?: ProposalStrength;
  trashBatchId?: string;
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
  files: { total: number; /** Files in Trash (not in `total`). */ inTrash?: number; byKind: { kind: string; label: string; count: number }[]; facts: string[] };
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
