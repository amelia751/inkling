import type { ComponentType } from "react";
import type { Annotation, Project, StudioItem } from "@/types";
import type { ToolId } from "@/stores/studio";
import type { Exporter } from "@/platform/module";

export type { ExportContext, Exporter } from "@/platform/module";

/**
 * @deprecated The pre-module viewer boundary. Each adapter is now wrapped as a module
 * implementation by `legacyImpl` (viewers/legacy.tsx); new code writes a module
 * (modules/_template) instead. Deleted at the end of todo phase 6.
 */
export interface ViewerProps {
  project: Project;
  item: StudioItem;
}

/** @deprecated See ViewerProps. */
export interface ViewerAdapter {
  kind: string;
  /** Tools this viewer supports, in toolbar order. */
  tools: ToolId[];
  Component: ComponentType<ViewerProps>;
  /** Rows (label, value) describing one annotation for the selection inspector. */
  inspect?: (a: Annotation, ctx: { project: Project; item: StudioItem }) => [string, string][];
  exporters?: Exporter[];
}
