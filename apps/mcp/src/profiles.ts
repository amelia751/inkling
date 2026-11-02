/**
 * todo19 D12: a Studio is a task over many kinds; `data.kinds` maps each kind to its profile
 * (renderer, config, tools, panels). This is the small summary get_environment reports, with the
 * one-kind shorthand (`data.kind` + first viewport) folded in the way the contracts'
 * `normalizeEnvironment` does it. Pure.
 */
export interface KindSummary {
  renderer?: string;
  profile?: string;
}

export function studioKinds(spec: unknown): { accepts: string[]; kinds: Record<string, KindSummary> } {
  const env = (spec && typeof spec === "object" ? spec : {}) as Record<string, any>;
  const data = (env.data ?? {}) as { kind?: unknown; kinds?: Record<string, any> };
  const raw: Record<string, any> = { ...(data.kinds ?? {}) };
  if (typeof data.kind === "string" && !raw[data.kind]) raw[data.kind] = { renderer: Array.isArray(env.viewports) ? env.viewports[0]?.renderer : undefined };
  const kinds = Object.fromEntries(
    Object.entries(raw).map(([k, p]) => [k, { ...(typeof p?.renderer === "string" && p.renderer ? { renderer: p.renderer } : {}), ...(typeof p?.profile === "string" ? { profile: p.profile } : {}) }]),
  );
  const accepts = Array.isArray(env.accepts) ? env.accepts.filter((a: unknown): a is string => typeof a === "string") : Object.keys(kinds);
  return { accepts, kinds };
}
