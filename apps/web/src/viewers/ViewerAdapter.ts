import type { ComponentType } from "react";
import type { Annotation, Project, StudioItem, ViewerKind } from "@/types";
import type { Tool } from "@/stores/studio";

/**
 * Inkling's viewer boundary (inkling.md §3.1). Each adapter renders one data family
 * and writes annotations through the studio store, so the shell never needs to know
 * which renderer is mounted. 2D images and 3D volumes render with Cornerstone3D;
 * whole-slide uses OpenSeadragon; video, cine and waveforms use purpose-built canvases.
 */
export interface ViewerProps {
  project: Project;
  item: StudioItem;
}

export interface ExportContext {
  project: Project;
  items: StudioItem[];
  annotations: Annotation[];
}

/** A downloadable, format-specific export of a project's annotations (COCO, NIfTI, GeoJSON, WFDB…). */
export interface Exporter {
  id: string;
  label: string;
  /** One line for the export page: what the file contains and who reads it. */
  description: string;
  /** File name (without directory); may include the project id. */
  filename: (project: Project) => string;
  build: (ctx: ExportContext) => Promise<Blob>;
}

export interface ViewerAdapter {
  kind: ViewerKind;
  /** Tools this viewer supports, in toolbar order. Classification-only tasks get no drawing tools. */
  tools: Tool[];
  Component: ComponentType<ViewerProps>;
  /**
   * Rows (label, value) describing one annotation for the selection inspector, in
   * physical units where the viewer knows them (mm, µm², ms, mL…).
   */
  inspect?: (a: Annotation, ctx: { project: Project; item: StudioItem }) => [string, string][];
  exporters?: Exporter[];
}
