import type { ComponentType } from "react";
import type * as z from "zod";
import type { DataBinding } from "@studio/plugin-contracts/ui-contributions";
import type { PanelProps } from "@studio/plugin-ui-sdk";
import { DeclarativeConfig, SandboxConfig } from "./agent-panels/manifest";
import { DeclarativePanel } from "./agent-panels/panels/declarative";
import { SandboxPanel } from "./agent-panels/panels/sandbox";

/**
 * Trusted renderers (docs/plugins.md §5.3): precompiled components that declarative
 * contributions name by a versioned id. A plugin supplies descriptors and data, never
 * React code. Names not in this registry fail closed (contributions-loader shows a notice).
 * Renderers from packages/studio-renderers are added by the composition root (bundled.ts).
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
