import type * as z from "zod";
import { canonicalDoc } from "@studio/contracts/naming";
import { EnvironmentSpecSchema, labelClasses, normalizeEnvironment, type EnvironmentSpec, type KindProfile, type LabelGroup, type ViewportSpec } from "@studio/contracts/environment";
import { FILE_VIEW_RENDERER } from "@studio/plugin-ui-sdk/resolved";
import { normalizeCombo } from "@studio/ui/keys";
import type { EnvError, ResolvedCommand, ResolvedEnv, ResolvedProfile, ResolvedViewport, ResolveResult } from "@studio/plugin-ui-sdk/resolved";
import type { ContributionType, PanelSlot } from "@studio/plugin-ui-sdk/module";
import type { Registered, Registry } from "./registry";
import { alwaysTrue, checkWhen, mayBeTrue, WhenSyntaxError, type WhenContext } from "./when";

export type { EnvError, ResolvedCommand, ResolvedEnv, ResolvedProfile, ResolvedViewport, ResolveResult } from "@studio/plugin-ui-sdk/resolved";

/**
 * The profile an item opens with (todo19 D3): `env.profiles[item.dataKind]`, or undefined when
 * the environment doesn't map the item's kind. Then show `env.fileView` (the generic file view,
 * `FILE_VIEW_RENDERER`), so nothing disappears. Items without a kind use the first profile.
 */
export function profileForItem(env: Pick<ResolvedEnv, "profiles" | "dataKind">, item: { dataKind?: string } | undefined): ResolvedProfile | undefined {
  return env.profiles?.[item?.dataKind ?? env.dataKind?.id];
}

/** `when` keys about the active item: its kind and the profile it opens with (todo19 D3). */
export function itemWhenContext(env: Pick<ResolvedEnv, "profiles" | "dataKind">, item: { dataKind?: string } | undefined): Record<string, unknown> {
  const kind = item?.dataKind ?? env.dataKind?.id;
  return { "item.kind": kind, "item.profile": (kind && env.profiles?.[kind]?.id) ?? null };
}

export interface ResolveOptions {
  /** Modules every environment gets (the Studio core). */
  baseModules?: string[];
}

/** App-wide defaults, set once by the composition root (src/bundle.ts). */
export const resolveDefaults: ResolveOptions = { baseModules: [] };

// ---- Merging ------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Keys whose arrays accumulate across `extends` instead of being replaced. */
const CONCAT_KEYS = new Set(["overrides", "keybindings"]);

/**
 * Deep-merge `b` over `a`: objects merge, arrays and scalars replace (overrides/keybindings
 * concatenate; label groups merge by `name`, so a project's own "labels" group replaces the
 * preset's while a preset vocabulary such as ECG record statements stays).
 */
export function mergeSpecs(a: EnvironmentSpec, b: EnvironmentSpec): EnvironmentSpec {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || k === "extends") continue;
    const prev = out[k];
    if (CONCAT_KEYS.has(k) && Array.isArray(prev) && Array.isArray(v)) out[k] = [...prev, ...v];
    else if (k === "labels" && Array.isArray(prev) && Array.isArray(v)) out[k] = mergeLabelGroups(prev as LabelGroup[], v as LabelGroup[]);
    else if (isPlainObject(prev) && isPlainObject(v) && k !== "layout") out[k] = mergeObjects(prev, v);
    else out[k] = v;
  }
  return out as EnvironmentSpec;
}
/** Groups of `b` replace same-named groups of `a` in place; new ones are appended. */
function mergeLabelGroups(a: LabelGroup[], b: LabelGroup[]): LabelGroup[] {
  const byName = new Map(b.map((g) => [g.name, g]));
  const out = a.map((g) => byName.get(g.name) ?? g);
  for (const g of b) if (!a.some((x) => x.name === g.name)) out.push(g);
  return out;
}
function mergeObjects(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isPlainObject(out[k]) && isPlainObject(v) ? mergeObjects(out[k] as Record<string, unknown>, v) : v;
  return out;
}

// ---- Semver (x.y.z with ^ ~ * >= ranges) --------------------------------------------

const parseVer = (v: string) => v.replace(/^[v=]/, "").split(/[.-]/).slice(0, 3).map((n) => (n === "x" || n === "*" ? NaN : Number(n)));
export function satisfies(version: string, range: string): boolean {
  range = range.trim();
  if (!range || range === "*" || range === "latest") return true;
  const v = parseVer(version);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
    return 0;
  };
  if (range.startsWith(">=")) return cmp(v, parseVer(range.slice(2))) >= 0;
  if (range.startsWith("^")) {
    const r = parseVer(range.slice(1));
    const head = r[0] > 0 ? 0 : r[1] > 0 ? 1 : 2;
    return cmp(v, r) >= 0 && v.slice(0, head + 1).every((n, i) => n === (r[i] || 0));
  }
  if (range.startsWith("~")) {
    const r = parseVer(range.slice(1));
    return cmp(v, r) >= 0 && v[0] === r[0] && v[1] === (r[1] || 0);
  }
  const r = parseVer(range);
  return r.every((n, i) => Number.isNaN(n) || n === v[i]);
}

// ---- Suggestions --------------------------------------------------------------------

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
/** Closest registered id of a type, compared on the full id and on the local name. */
export function suggest(registry: Registry, type: ContributionType, id: string): string | undefined {
  const tail = id.split(".").pop() ?? id;
  let best: { id: string; d: number } | undefined;
  for (const c of registry.list(type)) {
    const d = Math.min(distance(id, c.id), distance(tail, c.name) + 1);
    if (!best || d < best.d) best = { id: c.id, d };
  }
  return best && best.d <= Math.max(3, Math.floor(id.length / 3)) ? best.id : undefined;
}

// ---- Resolver -----------------------------------------------------------------------

const zodPath = (issue: z.core.$ZodIssue) => "/" + issue.path.map(String).join("/");

/**
 * Validate an environment spec against the registry and resolve it into the ordered,
 * merged structure the Studio renders. Never throws for bad input: every problem comes
 * back as a structured error so an agent can repair the spec.
 */
export function resolveEnvironment(input: unknown, registry: Registry, options: ResolveOptions = resolveDefaults): ResolveResult {
  const errors: EnvError[] = [];
  const err = (e: EnvError) => errors.push(e);

  // Stored documents keep full ids; legacy namespaces (a rename) map to the current one.
  const parsed = EnvironmentSpecSchema.safeParse(canonicalDoc(input));
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => ({ path: zodPath(i), code: "schema" as const, message: i.message })) };
  }

  // 1. extends (presets resolve their own extends first), then the spec itself.
  const expand = (spec: EnvironmentSpec, path: string, seen: string[]): EnvironmentSpec => {
    const parents = spec.extends === undefined ? [] : Array.isArray(spec.extends) ? spec.extends : [spec.extends];
    let base: EnvironmentSpec = {};
    parents.forEach((pid, i) => {
      const p = `${path}/extends${Array.isArray(spec.extends) ? `/${i}` : ""}`;
      if (seen.includes(pid)) return err({ path: p, code: "extends-cycle", message: `Preset "${pid}" extends itself (${[...seen, pid].join(" → ")})` });
      const preset = registry.get("presets", pid) ?? registry.get("presets", pid.replace(/^preset:/, ""));
      if (!preset) return err({ path: p, code: "unknown-contribution", message: `Unknown preset "${pid}"`, suggestion: suggestPreset(registry, pid) });
      base = mergeSpecs(base, expand(canonicalDoc(preset.spec), p, [...seen, pid]));
    });
    return mergeSpecs(base, spec);
  };
  const spec = expand(parsed.data, "", []);
  if (errors.length) return { errors };

  // 2. Overrides: disabled ids drop out of every list; configs merge.
  const disabled = new Set<string>();
  const overrideConfig = new Map<string, Record<string, unknown>>();
  (spec.overrides ?? []).forEach((o, i) => {
    if (!registry.has(o.id) && !o.id.startsWith("preset:")) {
      const t = guessType(o.id);
      return err({ path: `/overrides/${i}/id`, code: "unknown-contribution", message: `Override targets unknown id "${o.id}"`, suggestion: t && suggest(registry, t, o.id) });
    }
    if (o.disabled) disabled.add(o.id);
    else if (o.disabled === false) disabled.delete(o.id);
    if (o.config) overrideConfig.set(o.id, { ...overrideConfig.get(o.id), ...o.config });
  });

  /** Look up a referenced id of a given type, reporting unknown / wrong-type errors. */
  const ref = <T extends ContributionType>(type: T, id: string, path: string): Registered<T> | undefined => {
    const c = registry.get(type, id);
    if (c) return c;
    const other = registry.lookup(id);
    if (other) err({ path, code: "wrong-type", message: `"${id}" is a ${other.kind.replace(/s$/, "")}, not a ${type.replace(/s$/, "")}` });
    else err({ path, code: "unknown-contribution", message: `Unknown ${type.replace(/s$/, "")} "${id}"`, suggestion: suggest(registry, type, id) });
    return undefined;
  };
  const enabled = <T extends { id: string }>(list: (T | undefined)[]): T[] => list.filter((c): c is T => !!c && !disabled.has(c.id));

  // 3. Data kinds and their profiles (todo19 D3). `data.kind` + `viewports` is the one-kind
  // shorthand; normalizeEnvironment folds it into `data.kinds`. The first kind feeds the
  // one-kind fields (`dataKind`, `viewports`, `context`) current callers read.
  const kindSpecs: Record<string, KindProfile> = normalizeEnvironment(spec).data?.kinds ?? {};
  const firstKind = spec.data?.kind ?? Object.keys(kindSpecs)[0];
  let dataKind: Registered<"dataKinds"> | undefined;
  if (!firstKind) err({ path: "/data/kind", code: "missing-data-kind", message: "The environment needs data.kind or data.kinds (data kind contribution ids)" });
  else dataKind = ref("dataKinds", firstKind, spec.data?.kind ? "/data/kind" : `/data/kinds/${escape(firstKind)}`);

  const resolveViewports = (specs: ViewportSpec[], kind: Registered<"dataKinds"> | undefined, pathOf: (i: number) => string): ResolvedViewport[] => {
    const out: ResolvedViewport[] = [];
    specs.forEach((v, i) => {
      const r = ref("renderers", v.renderer, pathOf(i));
      if (!r) return;
      if (kind && !r.consumes.includes(kind.id)) {
        const fit = registry.list("renderers", (x) => x.consumes.includes(kind.id)).map((x) => x.id);
        err({ path: pathOf(i), code: "renderer-data-mismatch", message: `Renderer "${r.id}" can't display data kind "${kind.id}"`, suggestion: fit[0] });
      }
      out.push({ name: v.name, renderer: r, config: v.config ?? {} });
    });
    return out;
  };
  const profileViewportSpecs = (p: KindProfile): ViewportSpec[] => (p.viewports?.length ? p.viewports : p.renderer ? [{ name: "main", renderer: p.renderer, ...(p.config ? { config: p.config } : {}) }] : []);

  // Profiles written in `data.kinds` resolve on their own; the shorthand's profile is the
  // top-level viewports (checked once, at /viewports).
  const written = spec.data?.kinds ?? {};
  const profileParts: { key: string; kind: Registered<"dataKinds">; id: string; spec: KindProfile; viewports: ResolvedViewport[] }[] = [];
  for (const [key, p] of Object.entries(written)) {
    const base = `/data/kinds/${escape(key)}`;
    const kind = key === firstKind ? dataKind : ref("dataKinds", key, base);
    if (!kind) continue;
    const vps = resolveViewports(profileViewportSpecs(p), kind, (i) => (p.viewports?.length ? `${base}/viewports/${i}/renderer` : `${base}/renderer`));
    profileParts.push({ key, kind, id: p.profile ?? kind.id, spec: p, viewports: vps });
  }

  const viewportSpecs: ViewportSpec[] = spec.viewports ?? [];
  const fromProfile = !viewportSpecs.length && firstKind ? profileParts.find((x) => x.key === firstKind) : undefined;
  if (!viewportSpecs.length && !fromProfile) err({ path: "/viewports", code: "missing-viewport", message: "The environment needs at least one viewport with a renderer" });
  const viewports: ResolvedViewport[] = fromProfile ? fromProfile.viewports : resolveViewports(viewportSpecs, dataKind, (i) => `/viewports/${i}/renderer`);
  if (dataKind && firstKind && !written[firstKind]) profileParts.unshift({ key: firstKind, kind: dataKind, id: dataKind.id, spec: { renderer: viewports[0]?.renderer.id ?? "" }, viewports });
  const allViewports = [...new Set([...viewports, ...profileParts.flatMap((x) => x.viewports)])];
  const multiKind = profileParts.length > 1;

  const ctxFor = (vp: ResolvedViewport | undefined, profile?: { kind: Registered<"dataKinds">; id: string }): WhenContext => ({
    section: "studio",
    ...(vp ? { renderer: vp.renderer.id, "renderer.name": vp.renderer.name, "renderer.space": vp.renderer.space, "renderer.capabilities": vp.renderer.capabilities } : {}),
    dataKind: profile?.kind.id ?? dataKind?.id,
    // In a many-kind Studio the active item isn't known statically; keys left out read as "maybe".
    ...(profile ? { "item.kind": profile.kind.id, "item.profile": profile.id } : {}),
  });
  const firstProfile = profileParts.find((x) => x.key === firstKind);
  const context = ctxFor(viewports[0], multiKind ? undefined : firstProfile);
  const profileContexts = profileParts.map((x) => ctxFor(x.viewports[0], x));
  const checkedWhen = (src: string | undefined, path: string): string | undefined => {
    if (!src) return src;
    try {
      checkWhen(src);
      return src;
    } catch (e) {
      err({ path, code: "invalid-when", message: e instanceof WhenSyntaxError ? e.message : String(e) });
      return undefined;
    }
  };

  // 4. Tools: must apply to some viewport and create a geometry that viewport's space supports.
  const tools = enabled((spec.tools ?? []).map((id, i) => ref("tools", id, `/tools/${i}`)));
  const toolNames = new Map<string, string>();
  tools.forEach((t) => {
    const i = (spec.tools ?? []).indexOf(t.id);
    const path = `/tools/${i}`;
    if (toolNames.has(t.name)) err({ path, code: "duplicate-tool", message: `Tools "${toolNames.get(t.name)}" and "${t.id}" share the name "${t.name}"; the store can only hold one` });
    toolNames.set(t.name, t.id);
    checkedWhen(t.when, `${path}`);
    if (allViewports.length && !allViewports.some((vp) => mayBeTrue(t.when, ctxFor(vp)))) {
      err({ path, code: "tool-unsupported", message: `Tool "${t.id}" doesn't apply to any viewport (when: ${t.when})` });
    } else if (t.creates) {
      const g = registry.geometry(t.creates);
      if (!g) err({ path, code: "unknown-geometry", message: `Tool "${t.id}" creates unregistered geometry "${t.creates}"` });
      else if (g.spaces && allViewports.length && !allViewports.some((vp) => g.spaces!.includes(vp.renderer.space))) {
        err({ path, code: "tool-unsupported", message: `Tool "${t.id}" creates "${t.creates}", which no viewport's space (${allViewports.map((v) => v.renderer.space).join(", ")}) supports` });
      }
    }
  });

  // 5. Panels by slot.
  const SLOTS: PanelSlot[] = ["left", "right", "bottom", "viewport-bar"];
  const panels = Object.fromEntries(
    SLOTS.map((slot) => [slot, enabled((spec.panels?.[slot] ?? []).map((id, i) => ref("panels", id, `/panels/${slot}/${i}`)))]),
  ) as Record<PanelSlot, Registered<"panels">[]>;

  // 6. Labels: controls known, toName names a viewport.
  const labels = spec.labels ?? [];
  const controls = labels.map((g, i) => {
    const c = registry.list("labelControls", (x) => x.name === g.control || x.id === g.control)[0];
    if (!c) err({ path: `/labels/${i}/control`, code: "unknown-contribution", message: `Unknown label control "${g.control}"`, suggestion: suggest(registry, "labelControls", g.control) });
    if (g.toName && !allViewports.some((v) => v.name === g.toName)) {
      err({ path: `/labels/${i}/toName`, code: "label-target", message: `Label group "${g.name}" targets viewport "${g.toName}", which doesn't exist`, suggestion: viewports[0]?.name });
    }
    return c;
  });

  // 6b. Rule 1 (todo8 D4): only tools whose geometry some label group accepts. Navigation and
  // measurement tools are exempt, and so is every tool while the environment declares no label
  // groups (a bare preset, a catalogue preview). The catalogue still lists every tool.
  const unusableTools: { tool: Registered<"tools">; reason: string }[] = [];
  const usableTools = labels.length ? tools.filter((t) => {
    const reason = unusableReason(t, controls);
    if (reason) unusableTools.push({ tool: t, reason });
    return !reason;
  }) : tools;

  // 7. Exporters and review rules.
  const exporters = enabled((spec.exporters ?? []).map((id, i) => ref("exporters", id, `/exporters/${i}`)));
  const reviewRules = enabled((spec.reviewRules ?? []).map((id, i) => ref("reviewRules", id, `/reviewRules/${i}`)));

  // 7b. Per-profile lists: a profile's own tools/panels/exporters/reviewRules, else the
  // environment's; tools only where their `when` can hold for the profile's renderer.
  const profileTools = (x: (typeof profileParts)[number], ctx: WhenContext) => {
    const base = `/data/kinds/${escape(x.key)}`;
    const own = x.spec.tools ? enabled(x.spec.tools.map((id, i) => ref("tools", id, `${base}/tools/${i}`))) : undefined;
    const usable = own ? (labels.length ? own.filter((t) => !unusableReason(t, controls)) : own) : usableTools;
    return usable.filter((t) => mayBeTrue(t.when, ctx));
  };
  const profiles: Record<string, ResolvedProfile> = {};
  profileParts.forEach((x, n) => {
    const base = `/data/kinds/${escape(x.key)}`;
    const ctx = profileContexts[n];
    const ownPanels = x.spec.panels;
    profiles[x.kind.id] = {
      kind: x.kind,
      id: x.id,
      viewports: x.viewports,
      tools: profileTools(x, ctx),
      panels: Object.fromEntries(
        SLOTS.map((slot) => [slot, ownPanels?.[slot] ? enabled(ownPanels[slot]!.map((id, i) => ref("panels", id, `${base}/panels/${slot}/${i}`))) : panels[slot]]),
      ) as Record<PanelSlot, Registered<"panels">[]>,
      exporters: x.spec.exporters ? enabled(x.spec.exporters.map((id, i) => ref("exporters", id, `${base}/exporters/${i}`))) : exporters,
      reviewRules: x.spec.reviewRules ? enabled(x.spec.reviewRules.map((id, i) => ref("reviewRules", id, `${base}/reviewRules/${i}`))) : reviewRules,
      context: ctx,
    };
  });
  const profileContribs = Object.values(profiles).flatMap((p) => [p.kind, ...p.viewports.map((v) => v.renderer), ...p.tools, ...Object.values(p.panels).flat(), ...p.exporters, ...p.reviewRules]);

  // The generic file view, for items whose kind has no profile (todo19 D3).
  const fileViewRenderer = registry.get("renderers", FILE_VIEW_RENDERER);
  const fileView: ResolvedViewport | undefined = fileViewRenderer ? { name: "main", renderer: fileViewRenderer, config: {} } : undefined;

  // 8. Modules in play, and their requirements.
  const moduleIds = new Set<string>([...(options.baseModules?.filter((m) => registry.module(m)) ?? []), ...registry.listModules().filter((m) => m.ambient).map((m) => m.id)]);
  Object.entries(spec.modules ?? {}).forEach(([id, range]) => {
    const m = registry.module(id);
    if (!m) return err({ path: `/modules/${escape(id)}`, code: "unknown-module", message: `Module "${id}" isn't registered` });
    if (!satisfies(m.version, range)) err({ path: `/modules/${escape(id)}`, code: "module-version", message: `Module "${id}" is ${m.version}, which doesn't satisfy "${range}"` });
    moduleIds.add(id);
  });
  for (const c of [dataKind, ...viewports.map((v) => v.renderer), ...tools, ...Object.values(panels).flat(), ...exporters, ...reviewRules, ...controls, ...profileContribs, fileViewRenderer]) if (c) moduleIds.add(c.module);
  const queue = [...moduleIds];
  while (queue.length) {
    const m = registry.module(queue.shift()!)!;
    for (const req of m.requires ?? []) {
      if (!registry.module(req)) err({ path: "/modules", code: "missing-requirement", message: `Module "${m.id}" requires "${req}", which isn't registered` });
      else if (!moduleIds.has(req)) {
        moduleIds.add(req);
        queue.push(req);
      }
    }
  }
  const inModules = (c: { module: string; id: string }) => moduleIds.has(c.module) && !disabled.has(c.id);

  // Panels that join their slot wherever their module is in play (declarative plugins).
  for (const p of registry.list("panels", (x) => !!x.autoInclude && inModules(x))) {
    if (checkedWhen(p.when, `/panels/${p.slot}`) === undefined && p.when) continue;
    if (!mayBeTrue(p.when, context)) continue;
    if (!panels[p.slot].some((x) => x.id === p.id)) panels[p.slot].push(p);
  }
  for (const prof of Object.values(profiles))
    for (const p of registry.list("panels", (x) => !!x.autoInclude && inModules(x)))
      if (prof.panels[p.slot] !== panels[p.slot] && mayBeTrue(p.when, prof.context) && !prof.panels[p.slot].some((x) => x.id === p.id)) prof.panels[p.slot].push(p);

  // 9. Geometries in use; exporters must accept at least one.
  const geometries = registry.list("geometries", inModules);
  const inUse = new Set<string>([...tools.map((t) => t.creates).filter((g): g is string => !!g), ...controls.flatMap((c) => c?.geometries ?? [])]);
  if (controls.some((c) => c?.itemLevel)) inUse.add("class");
  exporters.forEach((x) => {
    if (x.accepts !== "*" && inUse.size && !x.accepts.some((g) => inUse.has(g))) {
      const i = (spec.exporters ?? []).indexOf(x.id);
      err({ path: `/exporters/${i}`, code: "exporter-unused", message: `Exporter "${x.id}" accepts ${x.accepts.join(", ")}, but this environment only creates ${[...inUse].join(", ")}` });
    }
  });

  // 10. Commands from the modules in play, with keybinding overrides and `when` filtering.
  const rebinds = new Map((spec.keybindings ?? []).map((k) => [k.command, k.keys]));
  (spec.keybindings ?? []).forEach((k, i) => registry.get("commands", k.command) || ref("commands", k.command, `/keybindings/${i}/command`));
  const candidates = registry
    .list("commands", inModules)
    .filter((c) => checkedWhen(c.when, `/commands/${c.id}`) !== undefined || !c.when)
    .filter((c) => (multiKind ? profileContexts : [context]).some((ctx) => mayBeTrue(c.when, { ...ctx, "env.tools": usableTools.map((t) => t.name) })));
  const replaced = new Set(candidates.flatMap((c) => c.replaces ?? []));
  const commands: ResolvedCommand[] = candidates.filter((c) => !replaced.has(c.id)).map((c) => ({ ...c, keys: rebinds.get(c.id) ?? c.keys ?? [] }));
  // `shadows` takes the shadowing command's keys away from the shadowed ones, which keep the rest.
  for (const c of commands) {
    if (!c.shadows?.length) continue;
    const taken = new Set(c.keys.map(normalizeCombo));
    for (const t of commands) if (c.shadows.includes(t.id)) t.keys = t.keys.filter((k) => !taken.has(normalizeCombo(k)));
  }

  // 11. Hotkeys must be unique among bindings that are unconditionally active together. In a
  // many-kind Studio each profile is checked on its own: a profile's plugin commands are only
  // bound while an item of that kind is active, so "=" may mean "fit" for images and "zoom
  // time" for ECG without a conflict.
  const shadowed = new Set(commands.flatMap((c) => (c.shadows ?? []).map((s) => `${c.id}>${s}`)));
  const profileModules = Object.values(profiles).map((p) => new Set([p.kind, ...p.viewports.map((v) => v.renderer)].map((c) => c.module)));
  const ownedByProfile = new Set(profileModules.flatMap((m) => [...m]));
  const scopes = multiKind ? Object.values(profiles).map((p, i) => ({ ctx: p.context, mods: profileModules[i], tools: p.tools })) : [{ ctx: context, mods: undefined, tools: usableTools }];
  const reported = new Set<string>();
  for (const scope of scopes) {
    const owners = new Map<string, string[]>();
    const claim = (combo: string, owner: string) => {
      const k = normalizeCombo(combo);
      owners.set(k, [...(owners.get(k) ?? []), owner]);
    };
    const inScope = (c: ResolvedCommand) => !scope.mods || !ownedByProfile.has(c.module) || scope.mods.has(c.module);
    for (const c of commands) if (!c.contextual && inScope(c) && alwaysTrue(c.when, scope.ctx)) c.keys.forEach((k) => claim(k, c.id));
    for (const t of scope.tools) if (t.hotkey) claim(t.hotkey, `tool ${t.id}`);
    labelClasses(labels).forEach((c, i) => c.hotkey && c.hotkey !== String(i + 1) && claim(c.hotkey, `label ${c.id}`));
    for (const [combo, all] of owners) {
      const who = all.filter((o) => !all.some((p) => shadowed.has(`${p}>${o}`)));
      const message = `"${combo}" is bound to ${who.join(" and ")}`;
      if (who.length > 1 && !reported.has(message)) {
        reported.add(message);
        err({ path: "/keybindings", code: "hotkey-conflict", message, suggestion: `Rebind one of them in "keybindings", or disable it in "overrides"` });
      }
    }
  }

  // 12. Configs: schema defaults, then override config, then viewport config (renderers).
  const configs: Record<string, Record<string, unknown>> = {};
  const configure = (c: Registered<ContributionType>, extra: Record<string, unknown> | undefined, path: string) => {
    const raw = { ...overrideConfig.get(c.id), ...extra };
    if (!c.configSchema) {
      configs[c.id] = raw;
      return;
    }
    const r = c.configSchema.safeParse(raw);
    if (r.success) configs[c.id] = r.data as Record<string, unknown>;
    else r.error.issues.forEach((i) => err({ path: `${path}/${i.path.map(String).join("/")}`.replace(/\/$/, ""), code: "invalid-config", message: `${c.id}: ${i.message}` }));
  };
  viewports.forEach((vp, i) => {
    configure(vp.renderer, vp.config, `/viewports/${i}/config`);
    vp.config = configs[vp.renderer.id] ?? vp.config;
  });
  for (const x of profileParts) {
    if (x.viewports === viewports) continue;
    x.viewports.forEach((vp, i) => {
      const schema = vp.renderer.configSchema;
      const raw = { ...overrideConfig.get(vp.renderer.id), ...vp.config };
      if (!schema) return void (vp.config = raw);
      const r = schema.safeParse(raw);
      const base = `/data/kinds/${escape(x.key)}${x.spec.viewports?.length ? `/viewports/${i}` : ""}/config`;
      if (r.success) vp.config = r.data as Record<string, unknown>;
      else r.error.issues.forEach((iss) => err({ path: `${base}/${iss.path.map(String).join("/")}`.replace(/\/$/, ""), code: "invalid-config", message: `${vp.renderer.id}: ${iss.message}` }));
    });
  }
  for (const c of [dataKind, ...tools, ...Object.values(panels).flat(), ...exporters, ...commands])
    if (c && !(c.id in configs)) configure(c, undefined, `/overrides/${c.id}/config`);

  if (errors.length || !dataKind) return { errors };

  return {
    env: {
      spec,
      source: parsed.data,
      id: spec.id ?? "environment",
      title: spec.title,
      task: spec.task,
      modules: [...moduleIds].map((id) => ({ id, version: registry.module(id)!.version })),
      dataKind,
      viewports,
      profiles,
      fileView,
      tools: usableTools,
      unusableTools,
      commands,
      panels,
      exporters,
      reviewRules,
      inspectors: registry.list("inspectors", inModules),
      geometries,
      labels,
      configs,
      context,
    },
  };
}

/** Tool names whose drawn shape differs from their name (Cornerstone ROIs create `measurement`). */
const SHAPE_ALIAS: Record<string, string> = { freehand: "polygon" };
/** Plural nouns for the reason line ("No label accepts boxes"). */
const PLURAL: Record<string, string> = {
  box: "boxes", ellipse: "ellipses", polygon: "polygons", multipolygon: "painted regions", polyline: "lines", spline: "spline contours",
  keypoint: "points", point3d: "3D points", measurement: "measurements", mask: "masks", span: "time spans", instant: "time points", track: "tracks",
};

/**
 * Why a tool can't be used with these label controls (todo8 D4 Rule 1), or undefined when it
 * can. A Cornerstone ROI (`creates: measurement`) counts as the shape it draws, so a
 * `RectangleLabels` group keeps its Box tool.
 */
export function unusableReason(t: Registered<"tools">, controls: ({ geometries: string[] } | undefined)[]): string | undefined {
  if (!t.creates || t.group === "navigate" || t.group === "measure") return undefined;
  const accepted = new Set(controls.flatMap((c) => c?.geometries ?? []));
  if (accepted.has(t.creates)) return undefined;
  const shape = t.creates === "measurement" ? (SHAPE_ALIAS[t.name] ?? t.name) : t.creates;
  if (t.creates === "measurement" && accepted.has(shape)) return undefined;
  return `No label accepts ${PLURAL[shape] ?? `${shape} shapes`}`;
}

const escape = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

function guessType(id: string): ContributionType | undefined {
  const t = id.split(".").at(-2);
  return t && ["dataKinds", "renderers", "geometries", "tools", "commands", "panels", "inspectors", "exporters", "labelControls", "reviewRules", "presets"].includes(t)
    ? (t as ContributionType)
    : undefined;
}

function suggestPreset(registry: Registry, id: string): string | undefined {
  const s = suggest(registry, "presets", id.replace(/^preset:/, ""));
  return s && `preset:${registry.get("presets", s)!.name}`;
}
