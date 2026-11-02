import * as z from "zod";
import { EnvironmentSpecSchema, normalizeEnvironment, type EnvironmentSpec } from "@studio/contracts/environment";
import { CONTRIBUTION_TYPES, type ContributionType } from "@studio/plugin-ui-sdk/module";
import type { Registered, Registry } from "./registry";
import { NAMING, ns } from "@studio/contracts/naming";

/**
 * The agent's view of what can be composed (kiwifs `kiwi_widget_reference` style): every
 * module and contribution with its description, config JSON Schema, example and the
 * `consumes` / `creates` edges. Pure data, safe to serve as JSON.
 */
export interface CatalogEntry {
  id: string;
  type: ContributionType;
  module: string;
  description: string;
  label?: string;
  configSchema?: unknown;
  example?: unknown;
  consumes?: string[];
  creates?: string;
  accepts?: string[] | "*";
  space?: string;
  capabilities?: string[];
  when?: string;
  slot?: string;
  hotkey?: string;
  keys?: string[];
  geometries?: string[] | "*";
  /** dataKinds: the detected file kinds it opens (todo13 "Find a plugin"). */
  fileKinds?: string[];
  /** presets: the data kinds this preset is the profile for (todo19 D4). */
  profileOf?: string[];
}

/** One kind's default view (todo19 D4): a Studio's `data.kinds.<kind>` comes from this preset. */
export interface CatalogProfile {
  kind: string;
  preset: string;
  renderer?: string;
  description: string;
}

export interface Catalog {
  version: 1;
  modules: { id: string; version: string; title: string; description: string; requires?: string[] }[];
  contributions: CatalogEntry[];
  /** Presets as per-kind profiles, kind → preset (todo19 D12). A kind can have several (pick by intent). */
  profiles?: CatalogProfile[];
}

const jsonSchema = (s: z.ZodType | undefined) => {
  if (!s) return undefined;
  try {
    return z.toJSONSchema(s, { unrepresentable: "any" });
  } catch {
    return undefined;
  }
};

/** A minimal working spec fragment for a contribution, when its manifest doesn't give one. */
function defaultExample(c: Registered<ContributionType>): unknown {
  switch (c.kind) {
    case "dataKinds":
      return { data: { kind: c.id } };
    case "renderers":
      return { data: { kind: (c as Registered<"renderers">).consumes[0] }, viewports: [{ name: "main", renderer: c.id }] };
    case "tools":
      return { tools: [ns("core.tools.select"), c.id] };
    case "panels":
      return { panels: { [(c as Registered<"panels">).slot]: [c.id] } };
    case "exporters":
      return { exporters: [c.id] };
    case "reviewRules":
      return { reviewRules: [c.id] };
    case "commands":
      return { keybindings: [{ command: c.id, keys: (c as Registered<"commands">).keys ?? [] }] };
    case "labelControls":
      return { labels: [{ name: "objects", control: c.name, classes: [{ id: "a" }, { id: "b" }] }] };
    case "presets":
      return { extends: `preset:${c.name}` };
    default:
      return undefined;
  }
}

/** The kinds a preset spec maps (`data.kind` shorthand or `data.kinds`), with each kind's renderer. */
function presetProfiles(spec: unknown): { kind: string; renderer?: string }[] {
  const env = normalizeEnvironment((spec ?? {}) as EnvironmentSpec);
  return Object.entries(env.data?.kinds ?? {}).map(([kind, p]) => ({ kind, ...(p.renderer || p.viewports?.[0]?.renderer ? { renderer: p.renderer || p.viewports?.[0]?.renderer } : {}) }));
}

/** Every preset as a per-kind profile, in registry order (todo19 D4, D12). */
export function catalogProfiles(registry: Registry): CatalogProfile[] {
  return registry.list("presets").flatMap((c) =>
    presetProfiles((c as Registered<"presets">).spec).map((p) => ({ kind: p.kind, preset: `preset:${c.name}`, ...(p.renderer ? { renderer: p.renderer } : {}), description: c.description })),
  );
}

function entry(c: Registered<ContributionType>): CatalogEntry {
  const any = c as Registered<ContributionType> & Record<string, unknown>;
  const out: CatalogEntry = { id: c.id, type: c.kind, module: c.module, description: c.description };
  const copy = ["label", "consumes", "creates", "accepts", "space", "capabilities", "when", "slot", "hotkey", "keys", "geometries", "example", "fileKinds"] as const;
  for (const k of copy) if (any[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = any[k];
  if (c.kind === "presets") {
    out.example = (c as Registered<"presets">).spec;
    const kinds = presetProfiles(out.example).map((p) => p.kind);
    if (kinds.length) out.profileOf = kinds;
  }
  out.example ??= defaultExample(c);
  if (c.kind === "tools" && (c as Registered<"tools">).optionsSchema) out.configSchema = jsonSchema((c as Registered<"tools">).optionsSchema);
  else if (c.configSchema) out.configSchema = jsonSchema(c.configSchema);
  if (c.kind === "geometries") out.label = (c as Registered<"geometries">).type;
  return out;
}

export function describeCatalog(registry: Registry): Catalog {
  return {
    version: 1,
    modules: registry.listModules().map((m) => ({ id: m.id, version: m.version, title: m.title, description: m.description, requires: m.requires })),
    contributions: CONTRIBUTION_TYPES.flatMap((t) => registry.list(t).map(entry)),
    profiles: catalogProfiles(registry),
  };
}

/**
 * The catalogue narrowed to the data kinds that open files of a detected kind (`?kind=` on the
 * catalogue read; todo13 "Find a plugin"). An empty `contributions` means no plugin yet.
 */
export function catalogForKind(catalog: Catalog, kind: string): Catalog {
  const k = kind.trim().toLowerCase();
  const contributions = catalog.contributions.filter((c) => c.type === "dataKinds" && (c.fileKinds ?? []).includes(k));
  const modules = new Set(contributions.map((c) => c.module));
  const kinds = new Set(contributions.map((c) => c.id));
  return { version: 1, modules: catalog.modules.filter((m) => modules.has(m.id)), contributions, profiles: (catalog.profiles ?? []).filter((p) => kinds.has(p.kind)) };
}

/** Compact markdown for the assistant's system prompt. */
export function catalogPrompt(registry: Registry): string {
  const lines = [
    `# ${NAMING.displayName} environment catalogue`,
    "An environment spec (JSON) is one Studio: a task over a set of items. `accepts` lists the data kinds it takes; `data.kinds` maps each kind to its profile (renderer, config, tools, panels, exporters), and the active item's kind picks the profile. Tools, panels, exporters and label groups are referenced by full id `<module>.<type>.<name>`; a label group's `appliesTo` names the kinds it applies to.",
    "Validate before saving; fix errors using their `path` and `suggestion`.",
    "",
  ];
  const profiles = catalogProfiles(registry);
  if (profiles.length) {
    lines.push("## profiles", "Each preset is a profile for its kind (kind → preset; a kind can have several). A Studio over several kinds `extends` one profile per kind it accepts.");
    for (const p of profiles) lines.push(`- \`${p.kind}\` → \`${p.preset}\`${p.renderer ? ` (renderer ${p.renderer})` : ""}`);
    lines.push("");
  }
  for (const t of CONTRIBUTION_TYPES) {
    const list = registry.list(t);
    if (!list.length) continue;
    lines.push(`## ${t}`);
    for (const c of list) {
      const e = entry(c);
      const extra = [
        e.consumes && `consumes ${e.consumes.join(", ")}`,
        e.space && `space ${e.space}`,
        e.creates && `creates ${e.creates}`,
        e.accepts && `accepts ${Array.isArray(e.accepts) ? e.accepts.join(", ") : e.accepts}`,
        e.when && `when ${e.when}`,
        e.slot && `slot ${e.slot}`,
      ].filter(Boolean);
      lines.push(`- \`${t === "presets" ? `preset:${c.name}` : c.id}\` — ${c.description}${extra.length ? ` (${extra.join("; ")})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Ids of one type as a JSON Schema string enum (or a plain string when none are registered). */
const ids = (registry: Registry, type: ContributionType, extra: string[] = []) => {
  const values = [...registry.list(type).map((c) => c.id), ...extra];
  return values.length ? { type: "string", enum: values } : { type: "string" };
};

/**
 * JSON Schema for environment specs with `enum`s of the ids actually registered, so an
 * agent using structured output can't invent ids. Generated from the zod schema, then
 * narrowed at the id-bearing properties.
 */
export function environmentJsonSchema(registry: Registry): Record<string, unknown> {
  const schema = z.toJSONSchema(EnvironmentSpecSchema, { unrepresentable: "any" }) as Record<string, any>;
  const root = schema.$defs?.EnvironmentSpec ?? schema;
  const p = root.properties;
  const presets = registry.list("presets").map((c) => `preset:${c.name}`);
  const anyId = { type: "string", enum: CONTRIBUTION_TYPES.flatMap((t) => registry.list(t).map((c) => c.id)) };

  p.extends = { anyOf: [{ type: "string", enum: presets }, { type: "array", items: { type: "string", enum: presets } }], description: p.extends?.description };
  p.data.properties.kind = { ...ids(registry, "dataKinds"), description: "Data kind contribution id" };
  p.viewports.items.properties.renderer = { ...ids(registry, "renderers"), description: "Renderer contribution id" };
  p.tools.items = ids(registry, "tools");
  for (const slot of Object.keys(p.panels.properties)) p.panels.properties[slot].items = ids(registry, "panels");
  p.exporters.items = ids(registry, "exporters");
  p.reviewRules.items = ids(registry, "reviewRules");
  p.keybindings.items.properties.command = ids(registry, "commands");
  p.overrides.items.properties.id = anyId;
  p.modules.propertyNames = { type: "string", enum: registry.listModules().map((m) => m.id) };
  const controls = registry.list("labelControls").map((c) => c.name);
  const groupDef = schema.$defs?.LabelGroup ?? p.labels.items;
  if (controls.length) groupDef.properties.control = { type: "string", enum: controls, description: groupDef.properties.control?.description };
  schema.$id = `${NAMING.schemaPrefix}://schema/environment/v1`;
  return schema;
}
