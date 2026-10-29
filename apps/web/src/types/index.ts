export type ViewerKind = "image-2d" | "volume-3d" | "signal" | "temporal" | "cine-4d" | "pathology";

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
  viewer: ViewerKind;
  task?: string;
  labels?: string[];
  source: string;
  license: string;
  status: "available" | "bring-your-own";
  /** Source license restricts commercial use or redistribution: local development only. */
  restricted?: boolean;
  meta?: Record<string, string | number | null>;
  assets: SeedAsset[];
}

export type Provenance = "human-created" | "ai-suggested" | "human-corrected";

export type Geometry =
  | { type: "class" }
  | { type: "box"; x: number; y: number; w: number; h: number; frame?: number }
  | { type: "point"; plane: Plane; slice: number; ijk: [number, number, number] }
  | { type: "interval"; lead: string; start: number; end: number }
  /** Closed contour in image pixels; frame/slice locate it in a cine stack. */
  | { type: "polygon"; points: [number, number][]; frame?: number; slice?: number }
  /** Single location in image pixels, e.g. a cell on a whole-slide image. */
  | { type: "mark"; x: number; y: number }
  /** Time span of a video, in seconds. */
  | { type: "segment"; start: number; end: number };

export type Plane = "axial" | "coronal" | "sagittal";

export interface Annotation {
  id: string;
  /** Item the annotation belongs to: an asset path, or a subject id for multi-file volumes. */
  itemId: string;
  label: string;
  geometry: Geometry;
  provenance: Provenance;
  author: string;
  createdAt: string;
}

export interface AnnotationDocument {
  revision: number;
  savedAt?: string;
  annotations: Annotation[];
}

/** A unit the expert works through in the file tree (one image, one MRI subject, one ECG). */
export interface StudioItem {
  id: string;
  name: string;
  group: string;
  assets: SeedAsset[];
  sourceLabel?: string;
}
