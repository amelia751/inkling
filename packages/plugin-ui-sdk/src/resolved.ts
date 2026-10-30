import type { EnvironmentSpec, LabelGroup } from "@studio/plugin-contracts";
import type { ContributionOf, ContributionType, PanelSlot } from "./module";

/**
 * Types of a resolved environment, as plugins see it. The resolver that builds them lives
 * in the extension host (apps/web/src/extension-host/resolve.ts).
 */

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
  dataKind: Registered<"dataKinds">;
  viewports: ResolvedViewport[];
  tools: Registered<"tools">[];
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
