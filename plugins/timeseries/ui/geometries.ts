import * as z from "zod";
import type { GeometryContribution } from "@studio/plugin-ui-sdk/module";
import type { Annotation, Geometry } from "@studio/plugin-contracts/types";
import { channelOf, codeOf, kindOf, rhythmOf, waveOf } from "./model";

/**
 * Refinements of the core `span` and `instant` geometries for strip-chart annotations:
 * attribute schemas per `attributes.kind` and one-line descriptions ("Beat V · 0.700s").
 * Spans and instants without a timeseries kind describe as the core ones do.
 */
const fmt = (n: number, d = 2) => n.toFixed(d);
const onChannel = (c: string | undefined) => (c === undefined ? "" : c === "all" ? " · all channels" : ` · ${c}`);

export const AttributesSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval") }).loose(),
  z.object({ kind: z.literal("beat"), code: z.string().min(1) }).loose(),
  z.object({ kind: z.literal("wave"), wave: z.string().min(1), peak: z.number().optional() }).loose(),
  z.object({ kind: z.literal("rhythm"), rhythm: z.string().min(1) }).loose(),
]);

export function describeSpan(g: Geometry, a: Annotation): string {
  if (g.type !== "span") return "";
  const lead = channelOf(g);
  switch (kindOf(a)) {
    case "interval":
      return `${lead === "all" ? "All channels" : lead} · ${fmt(g.start)}–${fmt(g.end)}s`;
    case "wave":
      return `${waveOf(a)} wave · ${lead === "all" ? "all channels" : lead} · ${fmt(g.start, 3)}–${fmt(g.end, 3)}s`;
    case "rhythm":
      return `Rhythm ${rhythmOf(a)} · ${fmt(g.start)}–${fmt(g.end)}s`;
    default:
      return `Span ${fmt(g.start)}–${fmt(g.end)}s${onChannel(g.channel)}`;
  }
}

export function describeInstant(g: Geometry, a: Annotation): string {
  if (g.type !== "instant") return "";
  if (g.t === undefined || kindOf(a) !== "beat") {
    return g.frame !== undefined ? `Event · frame ${g.frame + 1}${onChannel(g.channel)}` : `Instant · ${fmt(g.t ?? 0, 3)}s${onChannel(g.channel)}`;
  }
  const code = codeOf(a);
  const lead = channelOf(g);
  return `${code ? `Beat ${code}` : "Instant"} · ${fmt(g.t, 3)}s${lead === "all" ? "" : ` · ${lead}`}`;
}

export const geometries: GeometryContribution[] = [
  {
    id: "span",
    type: "span",
    spaces: ["time"],
    description: "Strip-chart span: an interval, a delineated wave (attributes.wave, .peak) or a track episode (attributes.rhythm), by attributes.kind",
    schema: z.object({ attributes: AttributesSchema.optional() }).loose(),
    describe: describeSpan,
  },
  {
    id: "instant",
    type: "instant",
    spaces: ["time"],
    description: "Strip-chart instant with a code (attributes.kind = beat, attributes.code)",
    schema: z.object({ attributes: AttributesSchema.optional() }).loose(),
    describe: describeInstant,
  },
];
