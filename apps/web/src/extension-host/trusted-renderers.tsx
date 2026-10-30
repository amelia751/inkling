import type { ComponentType } from "react";
import type * as z from "zod";
import type { DataBinding } from "@studio/contracts/ui-contributions";
import type { PanelProps } from "@studio/plugin-ui-sdk";
import type { Annotation } from "@studio/contracts/types";
import { DeclarativeConfig, SandboxConfig } from "./agent-panels/manifest";
import { DeclarativePanel } from "./agent-panels/panels/declarative";
import { SandboxPanel } from "./agent-panels/panels/sandbox";

/**
 * Trusted renderers (docs/plugins.md §5.3): precompiled components that declarative
 * contributions name by a versioned id. A plugin supplies descriptors and data, never
 * React code. Names not in this registry fail closed (contributions-loader shows a notice).
 * Renderers from packages/renderers are added by the composition root (bundled.ts).
 */
export interface TrustedRendererProps extends PanelProps {
  /** What the descriptor's `dataBinding` asked for, resolved by the host. */
  binding?: DataBinding;
}

export interface TrustedRenderer {
  component: ComponentType<TrustedRendererProps>;
  /** Validates and defaults the descriptor's `config`. */
  configSchema?: z.ZodType;
  description: string;
}

const registry = new Map<string, TrustedRenderer>([
  ["studio.declarative-panel.v1", { component: DeclarativePanel, configSchema: DeclarativeConfig, description: "Tier 2 JSON blocks (text, stat, list, progress) bound to runtime keys and store selectors" }],
  ["studio.sandbox-frame.v1", { component: SandboxPanel, configSchema: SandboxConfig, description: "Tier 3 sandboxed iframe (no same origin, no network) that can read annotations and propose ai-suggested ones" }],
]);

export function trustedRenderer(name: string): TrustedRenderer | undefined {
  return registry.get(name);
}

export function trustedRendererNames(): string[] {
  return [...registry.keys()];
}

/** Add a trusted renderer (first-party code only, at boot: e.g. studio.mask-review.v1). */
export function registerTrustedRenderer(name: string, r: TrustedRenderer): void {
  if (!/\.v\d+$/.test(name)) throw new Error(`Trusted renderer names are versioned (…\.v1): ${name}`);
  registry.set(name, r);
}

// ---- diffPreview (todo4 Phase 6, V12) ------------------------------------------------------
// A dataset review lists semantic changes per sample; how one annotation change *looks*
// (two boxes, a mask overlay, a moved span) is type-specific, so the matching module
// contributes a preview for its geometry type. Previews get plain data, never Studio state.

/** One annotation change in a review diff: the Studio annotation before and after. */
export interface DiffPreviewProps {
  change: { type: string; sampleId?: string; annotationId?: string; fields?: string[] };
  base?: Annotation;
  head?: Annotation;
}

export interface DiffPreviewRenderer {
  /** Geometry types (`box`, `polygon`, `mask`, or a module's full id) this preview draws. */
  geometries: string[];
  component: ComponentType<DiffPreviewProps>;
  description: string;
}

const diffPreviews = new Map<string, DiffPreviewRenderer>();

/** Register a diff preview (first-party code at boot, like trusted renderers). */
export function registerDiffPreview(name: string, r: DiffPreviewRenderer): void {
  if (!/\.v\d+$/.test(name)) throw new Error(`Diff preview names are versioned (…\.v1): ${name}`);
  diffPreviews.set(name, r);
}

/** The preview for a geometry type, if any module contributed one. */
export function diffPreviewFor(geometryType: string | undefined): DiffPreviewRenderer | undefined {
  if (!geometryType) return undefined;
  for (const r of diffPreviews.values()) if (r.geometries.includes(geometryType)) return r;
  return undefined;
}

export function diffPreviewNames(): string[] {
  return [...diffPreviews.keys()];
}
