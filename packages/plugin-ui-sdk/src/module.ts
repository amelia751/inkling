import type { ComponentType, SVGProps } from "react";
import type * as z from "zod";
import type { Annotation, Geometry, Project, StudioItem } from "@studio/contracts/types";
import type { EnvironmentSpec, LabelGroup } from "@studio/contracts/environment";
import type { RulesInput } from "@studio/contracts/rules";
import type { ResolvedEnv, ResolvedViewport } from "./resolved";

/** An icon component (ui icons satisfy it). */
export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Module contract (docs/modules.md). A module is a static, data-only manifest plus a lazy
 * `load()` returning the heavy implementations (React components, functions) keyed by the
 * same contribution ids. The registry indexes every contribution under its full id
 * `<moduleId>.<type>.<name>` (OHIF style), e.g. `studio.wsi.renderers.osd`.
 */

/** Fields every contribution carries. `id` is the local name; the registry adds the full id. */
export interface ContributionBase {
  id: string;
  /** One line shown to the agent in the catalogue (kiwifs style). */
  description: string;
  /** Config accepted in the environment spec; defaults come from the schema. */
  configSchema?: z.ZodType;
  /** A working environment-spec snippet showing the contribution in use. */
  example?: unknown;
}

/** How a data kind recognises its assets and groups them into the items an expert works through. */
export interface DataKindContribution extends ContributionBase {
  label: string;
  icon: IconComponent;
  /** Singular noun for one item ("slide", "recording"). */
  itemNoun: string;
  match?: { ext?: string[] };
  /**
   * Detected file kinds (the kernel's inspection: `image`, `dicom`, `dicom-series`, `volume`,
   * `video`, `waveform`, `slide`, `document`, `table`, …) this data kind opens. The catalogue's
   * `kind` filter (todo13 "Find a plugin") searches by it.
   */
  fileKinds?: string[];
  groupItems: (project: Project) => StudioItem[];
}

/** Coordinate space a renderer draws in; tools and geometries declare which they support. */
export type Space = "image2d" | "volume" | "time" | "text" | "table";

export interface RendererContribution extends ContributionBase {
  /** Data kind ids (full) this renderer can display. */
  consumes: string[];
  space: Space;
  /** Free-form feature flags read by `when` clauses: "playback", "time", "slices", "drafting"… */
  capabilities: string[];
}

export interface GeometryContribution extends ContributionBase {
  /** Value of `geometry.type`: bare for core geometries, `<module>.<name>` for module ones. */
  type: string;
  spaces?: Space[];
  /** Refines the geometry (or its annotation attributes) for validation. */
  schema?: z.ZodType;
  /** One line for lists: "Box 120×80px · frame 3". */
  describe?: (g: Geometry, a: Annotation) => string;
}

export type ToolGroup = "navigate" | "shape" | "measure" | "mask" | "time";

export interface ToolContribution extends ContributionBase {
  label: string;
  hint: string;
  icon: IconComponent;
  group: ToolGroup;
  hotkey?: string;
  /** Geometry type the tool creates. Absent for navigation and read-only tools (probe, caliper). */
  creates?: string;
  /** Static applicability, e.g. `renderer.space == image2d`. */
  when?: string;
  /** Options shown in the toolbar strip and read with `useToolOption`. */
  optionsSchema?: z.ZodObject;
}

export type CommandGroup = "Edit" | "Navigate" | "Labels" | "Drawing" | "View" | "Playback" | "Sources" | "Help";

/** A named action with default keybindings. Handlers register at runtime with `useCommands`. */
export interface CommandContribution extends ContributionBase {
  label: string;
  group: CommandGroup;
  /** Default combos; the first is shown in the UI. Syntax in lib/shortcuts.ts. */
  keys?: string[];
  /** Replaces the formatted keys in the UI, for families such as 1–9. */
  display?: string;
  /** Fire again while the key is held. */
  repeat?: boolean;
  when?: string;
  /** Full command ids this one takes over wherever it is active (arrows step frames, not items). */
  replaces?: string[];
  /**
   * Full command ids this one takes its keys from; they stay bound to their other keys
   * (video steps frames on ←/→ while PageDown still changes item).
   */
  shadows?: string[];
  /** Claims its key only in some state and otherwise falls through, so sharing a key is intended. */
  contextual?: boolean;
  /** Also shown as a button in the canvas toolbar (declarative toolbar actions, docs/plugins.md §5.3). */
  surface?: "toolbar";
  /** Icon name from the Studio icon set, for toolbar buttons of declarative plugins. */
  iconName?: string;
  /** Declarative plugins: the gateway command this runs (`<plugin>.<tool>`) and its static input. */
  run?: { command: string; args?: Record<string, unknown> };
}

export type PanelSlot = "left" | "right" | "bottom" | "viewport-bar";

export interface PanelContribution extends ContributionBase {
  title: string;
  slot: PanelSlot;
  /** Joins its slot in every environment the module is part of (declarative plugin panels). */
  autoInclude?: boolean;
  /** When an auto-included panel applies, e.g. `item.mediaType =~ /^image\//`. */
  when?: string;
}

export interface InspectorContribution extends ContributionBase {
  /** Geometry types this inspector adds rows for; "*" for all. */
  geometries: string[] | "*";
}

export interface ExporterContribution extends ContributionBase {
  label: string;
  /** Geometry types the format can carry; "*" for any. */
  accepts: string[] | "*";
}

/** Label Studio style control: which geometries a label group of this control draws. */
export interface LabelControlContribution extends ContributionBase {
  /** Geometry types; empty for item-level controls (Choices). */
  geometries: string[];
  /** Item-level (one or more classes per item) rather than drawn regions. */
  itemLevel?: boolean;
}

export interface ReviewIssue {
  message: string;
  annotationIds?: string[];
  itemIds?: string[];
}

export interface ReviewRuleContribution extends ContributionBase {
  applies?: { geometry?: string[] };
  check: (ctx: { env: ResolvedEnv; items: StudioItem[]; annotations: Annotation[] }) => ReviewIssue[];
}

export interface PresetContribution extends ContributionBase {
  title: string;
  spec: EnvironmentSpec;
  /** Default project rules (`rules.v1`, todo17 D3) for projects created from this preset. */
  rules?: RulesInput;
}

export interface Contributions {
  dataKinds?: DataKindContribution[];
  renderers?: RendererContribution[];
  geometries?: GeometryContribution[];
  tools?: ToolContribution[];
  commands?: CommandContribution[];
  panels?: PanelContribution[];
  inspectors?: InspectorContribution[];
  exporters?: ExporterContribution[];
  labelControls?: LabelControlContribution[];
  reviewRules?: ReviewRuleContribution[];
  presets?: PresetContribution[];
}

export type ContributionType = keyof Contributions;
export type ContributionOf<T extends ContributionType> = NonNullable<Contributions[T]>[number];

export const CONTRIBUTION_TYPES: ContributionType[] = [
  "dataKinds",
  "renderers",
  "geometries",
  "tools",
  "commands",
  "panels",
  "inspectors",
  "exporters",
  "labelControls",
  "reviewRules",
  "presets",
];

// ---- Implementations (returned by load()) -------------------------------------------

/** Runtime handed to renderers and panels instead of module-level singletons. */
export interface RuntimeApi {
  publish: (key: string, value: unknown) => void;
  get: <T = unknown>(key: string) => T | undefined;
}

export interface RendererProps {
  env: ResolvedEnv;
  viewport: ResolvedViewport;
  project: Project;
  item: StudioItem;
  /** Merged renderer config (schema defaults + preset + overrides + viewport config). */
  config: Record<string, unknown>;
  runtime: RuntimeApi;
}

export interface PanelProps {
  env: ResolvedEnv;
  project: Project;
  items: StudioItem[];
  item: StudioItem | undefined;
  config: Record<string, unknown>;
}

export interface InspectContext {
  env: ResolvedEnv;
  project: Project;
  item: StudioItem;
  /** Values renderers published for this item (playhead, grid, signalInfo…). */
  runtime: RuntimeApi;
}
export type InspectFn = (a: Annotation, ctx: InspectContext) => [string, string][];

export interface ExportContext {
  project: Project;
  items: StudioItem[];
  annotations: Annotation[];
  /** Present when exporting from a resolved environment; legacy exporters ignore it. */
  env?: ResolvedEnv;
}

/** A downloadable, format-specific export of a project's annotations (COCO, NIfTI, GeoJSON, WFDB…). */
export interface Exporter {
  id: string;
  label: string;
  /** One line for the export page: what the file contains and who reads it. */
  description: string;
  /** File name (without directory); may include the project id. */
  filename: (project: Project) => string;
  /** Hide the exporter for projects it can't serve (e.g. DICOM SEG on JPEG/NIfTI data). Default: always shown. */
  available?: (project: Project) => boolean;
  build: (ctx: ExportContext) => Promise<Blob>;
}
export type ExporterImpl = Pick<Exporter, "filename" | "available" | "build">;

export interface ModuleImpl {
  renderers?: Record<string, ComponentType<RendererProps>>;
  panels?: Record<string, ComponentType<PanelProps>>;
  inspectors?: Record<string, InspectFn>;
  exporters?: Record<string, ExporterImpl>;
}

export interface ModuleManifest {
  /** Reverse-DNS-ish id, e.g. `studio.wsi`. */
  id: string;
  /** Semver. */
  version: string;
  title: string;
  description: string;
  /** Host API range this module was built against (`studio`), checked at registration later. */
  engines?: { studio?: string };
  /** Module ids that must be present (JupyterLab `requires`). Pulled in automatically when registered. */
  requires?: string[];
  /** Used when present, never required. */
  optional?: string[];
  /**
   * Joins every environment while registered, like the Studio core: declarative plugins
   * whose toolbar actions and panels apply wherever their `when` holds.
   */
  ambient?: boolean;
  contributes: Contributions;
  load?: () => Promise<ModuleImpl | { default: ModuleImpl }>;
}

/** Identity helper: type-checks a manifest and freezes it so contributions can't be mutated after registration. */
export function defineModule<const M extends ModuleManifest>(m: M): M {
  for (const t of CONTRIBUTION_TYPES) m.contributes[t]?.forEach((c) => Object.freeze(c));
  return Object.freeze(m);
}

export type { EnvironmentSpec, LabelGroup };
