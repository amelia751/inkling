import { type ToolDefinition, defineTool as piDefineTool } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/**
 * todo29 D6: a tool row's copy. `label` is the running line ("Looking at your files"),
 * `pastLabel` the line once the call is done ("Looked at your files"); `progress` marks a tool
 * whose row is a progress note (no result summary worth showing). The web reads them as the
 * `tool-call` event's `pastTitle` and `progress`.
 */
export interface ToolCopy {
  pastLabel?: string;
  progress?: boolean;
}

export type StudioToolDefinition = ToolDefinition<any, any, any> & ToolCopy;

/** pi's `defineTool` with the row copy: every server tool states its past-tense label. */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState> & ToolCopy & { pastLabel: string },
): ReturnType<typeof piDefineTool<TParams, TDetails, TState>> & ToolCopy {
  return piDefineTool(tool) as ReturnType<typeof piDefineTool<TParams, TDetails, TState>> & ToolCopy;
}

/** The row copy a registered tool definition carries (none for pi's own and older tools). */
export function toolCopy(def: unknown): ToolCopy {
  const d = def as ToolCopy | undefined;
  return {
    ...(typeof d?.pastLabel === "string" && d.pastLabel ? { pastLabel: d.pastLabel } : {}),
    ...(d?.progress === true ? { progress: true } : {}),
  };
}
