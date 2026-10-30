import type { Annotation, Geometry } from "@studio/contracts/types";

/**
 * Timeseries annotations in their stored (v2) form: core `span` / `instant` geometries with
 * a `channel`, and the domain vocabulary in `attributes`, exactly as
 * `migrations/annotations-v1-to-v2.ts` writes them:
 *
 *   interval  span    { start, end, channel }        attributes { kind: "interval" }
 *   beat      instant { t, channel }                 attributes { kind: "beat", code }
 *   wave      span    { start: onset, end: offset, channel }  attributes { kind: "wave", wave, peak? }
 *   rhythm    span    { start, end, channel: track } attributes { kind: "rhythm", rhythm }
 *
 * Every renderer, measure, inspector and exporter reads annotations through these helpers.
 * `channel: "all"` applies to every channel.
 */
export type Kind = "interval" | "beat" | "wave" | "rhythm";
export const KINDS: readonly Kind[] = ["interval", "beat", "wave", "rhythm"];
/** Attribute keys owned by the geometry migration (stripped again where v1 formats are written). */
export const MODEL_KEYS: Record<Kind, string[]> = { interval: ["kind"], beat: ["kind", "code"], wave: ["kind", "wave", "peak"], rhythm: ["kind", "rhythm"] };
/** The track channel of v1 rhythm episodes (the migration's `channel: "rhythm"`). */
export const RHYTHM_CHANNEL = "rhythm";

type Span = Extract<Geometry, { type: "span" }>;
type Instant = Extract<Geometry, { type: "instant" }>;
type Attrs = NonNullable<Annotation["attributes"]>;

/** The timeseries kind of an annotation, or null for other geometries (class, boxes…). */
export function kindOf(a: Pick<Annotation, "geometry" | "attributes">, trackChannel = RHYTHM_CHANNEL): Kind | null {
  const g = a.geometry;
  if (g.type !== "span" && !(g.type === "instant" && g.t !== undefined)) return null;
  const k = a.attributes?.kind;
  if (typeof k === "string" && (KINDS as readonly string[]).includes(k)) return k as Kind;
  if (g.type === "instant") return "beat";
  return g.channel === trackChannel || g.channel === RHYTHM_CHANNEL ? "rhythm" : "interval";
}

export const is = (a: Pick<Annotation, "geometry" | "attributes">, k: Kind) => kindOf(a) === k;

/** Channel of a span / instant ("all" when unset). */
export function channelOf(g: Geometry): string {
  return g.type === "span" || g.type === "instant" ? (g.channel ?? "all") : "all";
}

/** [start, end] of a span, [t, t] of an instant, in seconds. */
export function rangeOf(g: Geometry): [number, number] | null {
  if (g.type === "span") return [g.start, g.end];
  if (g.type === "instant" && g.t !== undefined) return [g.t, g.t];
  return null;
}

/** Time key used to order annotations (start of a span, time of an instant). */
export function timeOf(g: Geometry): number | undefined {
  return rangeOf(g)?.[0];
}
export function endOf(g: Geometry): number | undefined {
  return rangeOf(g)?.[1];
}

export const codeOf = (a: Pick<Annotation, "attributes">) => String(a.attributes?.code ?? "");
export const waveOf = (a: Pick<Annotation, "attributes">) => String(a.attributes?.wave ?? "");
export const rhythmOf = (a: Pick<Annotation, "attributes">) => String(a.attributes?.rhythm ?? "");
export function peakOf(a: Pick<Annotation, "attributes">): number | undefined {
  const p = a.attributes?.peak;
  return typeof p === "number" ? p : undefined;
}

// ---- Constructors (geometry + attributes for newAnnotation / update) -----------------

export interface Shape {
  geometry: Geometry;
  attributes: Attrs;
}

export const interval = (channel: string, start: number, end: number, extra?: Attrs): Shape => ({
  geometry: { type: "span", start, end, channel } satisfies Span,
  attributes: { kind: "interval", ...extra },
});

export const beat = (channel: string, t: number, code: string, extra?: Attrs): Shape => ({
  geometry: { type: "instant", t, channel } satisfies Instant,
  attributes: { kind: "beat", code, ...extra },
});

export const wave = (channel: string, name: string, onset: number, offset: number, peak?: number, extra?: Attrs): Shape => ({
  geometry: { type: "span", start: onset, end: offset, channel } satisfies Span,
  attributes: { kind: "wave", wave: name, ...(peak !== undefined ? { peak } : {}), ...extra },
});

export const rhythm = (trackChannel: string, start: number, end: number, code: string, extra?: Attrs): Shape => ({
  geometry: { type: "span", start, end, channel: trackChannel } satisfies Span,
  attributes: { kind: "rhythm", rhythm: code, ...extra },
});

/** Attributes with `peak` set (or removed when undefined), other keys in place. */
export function withPeak(attrs: Attrs | undefined, peak: number | undefined): Attrs {
  const { peak: _, ...rest } = attrs ?? {};
  if (peak === undefined) return rest;
  // Keep `peak` where the migration puts it: after kind / wave.
  const out: Attrs = {};
  let placed = false;
  for (const [k, v] of Object.entries(rest)) {
    out[k] = v;
    if (k === "wave") {
      out.peak = peak;
      placed = true;
    }
  }
  if (!placed) out.peak = peak;
  return out;
}

/**
 * The annotation's own attributes without the keys the v1→v2 migration added, so exports
 * that serialise `attributes` stay byte-identical to the v1 output. `undefined` when
 * nothing is left (v1 annotations without attributes).
 */
export function ownAttributes(a: Pick<Annotation, "geometry" | "attributes">): Attrs | undefined {
  const k = kindOf(a);
  if (!a.attributes || !k) return a.attributes;
  const drop = new Set(MODEL_KEYS[k]);
  const rest = Object.fromEntries(Object.entries(a.attributes).filter(([key]) => !drop.has(key)));
  return Object.keys(rest).length ? rest : undefined;
}
