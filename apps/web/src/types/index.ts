import type { EnvironmentSpec, LabelGroup } from "@/platform/environment";

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

export type Provenance = "human-created" | "ai-suggested" | "human-corrected";

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
