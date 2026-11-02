import type { EnvironmentSpec, LabelGroup } from "@studio/contracts";
import { ns } from "@studio/contracts/naming";
import type { ContributionOf, ContributionType, PanelSlot } from "./module";

/**
 * Types of a resolved environment, as plugins see it. The resolver that builds them lives
 * in the extension host (apps/web/src/extension-host/resolve.ts).
 */

/** Module of the generic file view renderer (packages/renderers/src/file-view). */
export const FILE_VIEW_MODULE = ns("file-view");
/** Renderer id of the generic file view: what `ResolvedEnv.fileView` shows for unmapped kinds. */
export const FILE_VIEW_RENDERER = `${FILE_VIEW_MODULE}.renderers.file`;

/** A contribution as indexed by the registry: its full id plus where it came from. */
export type Registered<T extends ContributionType> = ContributionOf<T> & {
  /** Full id `<module>.<type>.<name>`. Presets also answer to `preset:<name>`. */
  id: string;
  /** Local name from the manifest (what tools are called in the store, `tool == brush`). */
  name: string;
  module: string;
  /** Contribution type ("tools", "panels"…). Not `type`: geometries already use that field. */
  kind: T;
};

/** Flat context `when` clauses are evaluated against. */
export type WhenContext = Record<string, unknown>;

/** Structured, agent-repairable error (A2UI `ValidationFailed` style). `path` is a JSON Pointer into the merged spec. */
export interface EnvError {
  path: string;
  code:
    | "schema"
    | "unknown-contribution"
    | "wrong-type"
    | "unknown-module"
    | "module-version"
    | "missing-requirement"
    | "extends-cycle"
    | "missing-data-kind"
    | "missing-viewport"
    | "renderer-data-mismatch"
    | "tool-unsupported"
    | "duplicate-tool"
    | "unknown-geometry"
    | "label-target"
    | "exporter-unused"
    | "hotkey-conflict"
    | "invalid-config"
    | "invalid-when";
  message: string;
  suggestion?: string;
}

export interface ResolvedViewport {
  name: string;
  renderer: Registered<"renderers">;
  config: Record<string, unknown>;
}

/**
 * One kind's view inside a Studio (todo19 D3): what the viewport, toolbar and panels show while
 * the active item has this kind. Lists the profile leaves unset fall back to the environment's.
 */
export interface ResolvedProfile {
  /** The data kind this profile shows (the key of `ResolvedEnv.profiles`). */
  kind: Registered<"dataKinds">;
  /** Profile id: the preset it came from (`preset:ecg`), else the kind id. */
  id: string;
  viewports: ResolvedViewport[];
  tools: Registered<"tools">[];
  panels: Record<PanelSlot, Registered<"panels">[]>;
  exporters: Registered<"exporters">[];
  reviewRules: Registered<"reviewRules">[];
  /** Static `when` context of the profile's first viewport, with `item.kind` and `item.profile`. */
  context: WhenContext;
}

export interface ResolvedCommand extends Registered<"commands"> {
  /** Effective keys after env keybinding overrides. */
  keys: string[];
}

export interface ResolvedEnv {
  /** The fully merged spec (extends and overrides applied), for get_environment and diffs. */
  spec: EnvironmentSpec;
  /** The spec as written (before `extends` is merged): what edits and JSON Patches apply to. */
  source: EnvironmentSpec;
  id: string;
  title?: string;
  task?: string;
  modules: { id: string; version: string }[];
  /** The first (or only) kind's data kind: the one-kind view current callers read. */
  dataKind: Registered<"dataKinds">;
  /** The first kind's viewports (one-kind view). Per item, use `profiles[item.dataKind]`. */
  viewports: ResolvedViewport[];
  /**
   * Every profile of `normalizeEnvironment(spec).data.kinds`, keyed by full data kind id
   * (todo19 D3). The viewport host picks `profiles[item.dataKind]` per item and falls back to
   * `fileView` when the item's kind has no profile (see `profileForItem` in the extension host).
   */
  profiles: Record<string, ResolvedProfile>;
  /** The generic file view (name, size, facts, download) for unmapped kinds, when registered. */
  fileView?: ResolvedViewport;
  /** Tools the task can use (todo8 D4 Rule 1): `spec.tools` minus tools whose geometry no label group accepts. */
  tools: Registered<"tools">[];
  /** Tools dropped by Rule 1, with a plain reason ("No label accepts boxes"), for Task setup. */
  unusableTools: { tool: Registered<"tools">; reason: string }[];
  commands: ResolvedCommand[];
  panels: Record<PanelSlot, Registered<"panels">[]>;
  exporters: Registered<"exporters">[];
  reviewRules: Registered<"reviewRules">[];
  inspectors: Registered<"inspectors">[];
  geometries: Registered<"geometries">[];
  labels: LabelGroup[];
  /** Merged config per contribution id (schema defaults applied). */
  configs: Record<string, Record<string, unknown>>;
  /** Static `when` context of the first viewport. */
  context: WhenContext;
}

export type ResolveResult = { env: ResolvedEnv; errors?: undefined } | { env?: undefined; errors: EnvError[] };
