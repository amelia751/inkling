import * as z from "zod";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import type { RJSFSchema } from "@rjsf/utils";
import type { EnvironmentSpec } from "@studio/contracts/environment";
import type { ResolvedEnv } from "@/extension-host/resolve";

/**
 * Generated (RJSF) forms for contributions with a `configSchema`: the engine Task setup uses
 * for its Viewer, Panels and Export formats sections (todo8 D7). Values are applied to a draft
 * spec with `applyConfig` and saved with the rest of the page through `patchEnvironment`, so a
 * human edit is validated, undoable and saved exactly like an assistant's.
 */
export type ConfigKind = "viewer" | "dataKind" | "panel" | "exporter";

export interface ConfigurableItem {
  id: string;
  kind: ConfigKind;
  /** Plain words: the contribution's title or label, else its description. */
  title: string;
  description: string;
  schema: RJSFSchema;
  value: Record<string, unknown>;
}

const toSchema = (schema: z.ZodType): RJSFSchema | null => {
  try {
    return z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as RJSFSchema;
  } catch {
    // A schema JSON Schema can't express isn't offered as a form.
    return null;
  }
};

/** Every configurable contribution of the environment, by kind, with its current (resolved) value. */
export function configurableItems(env: ResolvedEnv): ConfigurableItem[] {
  const out: ConfigurableItem[] = [];
  const add = (c: { id: string; description: string; configSchema?: z.ZodType; title?: string; label?: string }, kind: ConfigKind, value: Record<string, unknown>) => {
    const schema = c.configSchema && toSchema(c.configSchema);
    if (!schema) return;
    out.push({ id: c.id, kind, title: c.title ?? c.label ?? c.description, description: c.description, schema, value });
  };
  env.viewports.forEach((v) => add(v.renderer, "viewer", v.config));
  add(env.dataKind, "dataKind", env.configs[env.dataKind.id] ?? {});
  for (const p of Object.values(env.panels).flat()) add(p, "panel", env.configs[p.id] ?? {});
  for (const x of env.exporters) add(x, "exporter", env.configs[x.id] ?? {});
  return out;
}

/** Write one contribution's config into a draft spec (viewport config on the viewport, the rest as an override). */
export function applyConfig(next: EnvironmentSpec, env: ResolvedEnv, id: string, value: Record<string, unknown>): void {
  const vpIndex = env.viewports.findIndex((v) => v.renderer.id === id);
  if (vpIndex >= 0) {
    // Viewport config lives on the viewport; materialise the merged viewports first.
    next.viewports = structuredClone(next.viewports ?? env.spec.viewports ?? []);
    next.viewports[vpIndex] = { ...next.viewports[vpIndex], config: value };
    return;
  }
  // Earlier config overrides of this id are replaced; a `disabled` flag on the same entry stays.
  const rest = (next.overrides ?? []).flatMap((o) => {
    if (o.id !== id || !o.config) return [o];
    const { config: _drop, ...keep } = o;
    return keep.disabled === undefined ? [] : [keep];
  });
  next.overrides = [...rest, { id, config: value }];
}

/** One contribution's options as a form without its own submit button; `onChange` gets every edit. */
export function ConfigForm({ item, value, onChange, readOnly }: { item: ConfigurableItem; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; readOnly?: boolean }) {
  return (
    <div className="rjsf-studio" data-config-id={item.id}>
      <Form
        schema={item.schema}
        formData={value}
        validator={validator}
        disabled={readOnly}
        onChange={({ formData }) => onChange((formData ?? {}) as Record<string, unknown>)}
        uiSchema={{ "ui:submitButtonOptions": { norender: true } }}
      />
    </div>
  );
}
