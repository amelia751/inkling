/**
 * What other modules may import from inkling.cine (e.g. inkling.cardiac-metrics): ids,
 * the renderer config, the runtime values the renderer publishes, and the pure
 * slice × frame model.
 */
import type { Volume } from "@/kits/io/nifti";
import type { Project } from "@/types";
import { registry } from "@/platform/registry";
import type { ResolvedEnv } from "@/platform/resolve";
import { resolveEnvironment } from "@/platform/resolve";
import { CineConfigSchema, type CineConfig } from "./config";
import type { FrameMetrics, Grid, Structures } from "./model";

export const CINE = "inkling.cine";
export const CINE_RENDERER = `${CINE}.renderers.slice-frame-canvas`;
/** `execute(GOTO_COMMAND, { slice?, frame? })` shows a slice / frame in the renderer. */
export const GOTO_COMMAND = `${CINE}.commands.goTo`;

/**
 * Runtime keys the renderer publishes per item (`runtime.publish`): `grid` (Grid plus
 * `dims`), `playhead` ({ frame, time, slice }), and the ones below.
 */
export const RUNTIME = {
  grid: "grid",
  playhead: "playhead",
  /** Decoded reference label volumes: RefSeg[]. */
  references: "cine.references",
  /** Per-frame coverage (areas, volumes, completeness) of the current annotations: FrameMetrics[]. */
  coverage: "cine.coverage",
} as const;

export type CineGrid = Grid & { dims: [number, number, number] };
export interface CinePlayhead {
  frame: number;
  /** Seconds at the cine's frame rate. */
  time: number;
  slice: number;
}
export interface RefSeg {
  frame: number;
  phase: string;
  volume: Volume;
}
export type CineCoverage = FrameMetrics[];

/** The cine renderer's config in an environment (schema defaults when it has none). */
export function cineConfig(env: ResolvedEnv | undefined): CineConfig {
  const vp = env?.viewports.find((v) => v.renderer.id === CINE_RENDERER);
  return CineConfigSchema.parse(vp?.config ?? env?.configs[CINE_RENDERER] ?? {});
}

/** Like `cineConfig`, resolving the project's own environment when no env is given (exports run outside the Studio too). */
export function cineConfigFor(env: ResolvedEnv | undefined, project: Project): CineConfig {
  return cineConfig(env ?? (project.environment ? resolveEnvironment(project.environment, registry).env : undefined));
}

export const structuresOf = (c: CineConfig): Structures => ({ rv: c.structures.rv, myo: c.structures.myo, lv: c.structures.lv });

export { CineConfigSchema, type CineConfig };
export {
  cellAreas,
  cellKey,
  cellLabelMap,
  frameCoverage,
  groupCells,
  isContour,
  isMask,
  isPhase,
  labelValue,
  myoArea,
  paintOrder,
  phaseAnnotation,
  phaseOps,
  referenceSlices,
  resolvePhases,
  ring,
  ringArea,
  STRUCT_KEYS,
  STRUCT_SHORT,
  structureOf,
  type Cell,
  type Completeness,
  type ContourAnn,
  type FrameMetrics,
  type Grid,
  type MaskAnn,
  type PhaseAnn,
  type PhaseMark,
  type StructKey,
  type Structures,
} from "./model";
export { cinePath, cineGridFor, pickCineItem } from "./io";
