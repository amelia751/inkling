import * as z from "zod";
import { EnvironmentSpecSchema } from "./environment";
import { CONTRIBUTION_TYPES, type ContributionType } from "./module";
import type { Registered, Registry } from "./registry";

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
}

export interface Catalog {
  version: 1;
  modules: { id: string; version: string; title: string; description: string; requires?: string[] }[];
  contributions: CatalogEntry[];
}

const jsonSchema = (s: z.ZodType | undefined) => {
  if (!s) return undefined;
  try {
    return z.toJSONSchema(s, { unrepresentable: "any" });
  } catch {
    return undefined;
  }
};

function entry(c: Registered<ContributionType>): CatalogEntry {
  const any = c as Registered<ContributionType> & Record<string, unknown>;
  const out: CatalogEntry = { id: c.id, type: c.kind, module: c.module, description: c.description };
  const copy = ["label", "consumes", "creates", "accepts", "space", "capabilities", "when", "slot", "hotkey", "keys", "geometries", "example"] as const;
  for (const k of copy) if (any[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = any[k];
  if (c.kind === "presets") out.example = (c as Registered<"presets">).spec;
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
  };
}

/** Compact markdown for the assistant's system prompt. */
export function catalogPrompt(registry: Registry): string {
  const lines = [
    "# Inkling environment catalogue",
    "An environment spec (JSON) picks a data kind, viewports (renderers), tools, panels, exporters and label groups by full id `<module>.<type>.<name>`.",
    "Validate before saving; fix errors using their `path` and `suggestion`.",
    "",
  ];
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
  schema.$id = "inkling://schema/environment/v1";
  return schema;
}
