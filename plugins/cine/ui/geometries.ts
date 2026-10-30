import type { GeometryContribution } from "@studio/plugin-ui-sdk/module";
import type { Annotation, Geometry } from "@studio/plugin-contracts/types";

/**
 * Geometry refinements: a key-frame marker is a core `instant` on a frame with
 * `attributes: { kind: "phase", phase }` (v1 `phase` geometries migrate to it). Other
 * instants keep the core description.
 */
export function describeInstant(g: Geometry, a: Annotation): string {
  if (g.type !== "instant") return g.type;
  if (a.attributes?.kind === "phase" && g.frame !== undefined) return `${String(a.attributes.phase)} · frame ${g.frame + 1}`;
  const channel = g.channel === undefined ? "" : g.channel === "all" ? " · all channels" : ` · ${g.channel}`;
  return g.frame !== undefined ? `Event · frame ${g.frame + 1}${channel}` : `Instant · ${(g.t ?? 0).toFixed(3)}s${channel}`;
}

export const cineGeometries: GeometryContribution[] = [
  {
    id: "phase",
    type: "instant",
    describe: describeInstant,
    description: "Key frame (phase) marker: instant { frame } with attributes { kind: \"phase\", phase }",
  },
];
