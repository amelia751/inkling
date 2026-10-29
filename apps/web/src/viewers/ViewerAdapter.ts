import type { ComponentType } from "react";
import type { Project, StudioItem, ViewerKind } from "@/types";
import type { Tool } from "@/stores/studio";

/**
 * Inkling's viewer boundary (inkling.md §3.1). Each adapter renders one data family
 * and writes annotations through the studio store, so the shell never needs to know
 * which renderer is mounted. Today's adapters are lightweight canvas renderers;
 * Cornerstone3D-backed adapters can replace them behind this same contract.
 */
export interface ViewerProps {
  project: Project;
  item: StudioItem;
}

export interface ViewerAdapter {
  kind: ViewerKind;
  /** Tools this viewer supports, in toolbar order. Classification-only tasks get no drawing tools. */
  tools: Tool[];
  Component: ComponentType<ViewerProps>;
}
