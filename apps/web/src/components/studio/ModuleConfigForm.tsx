import { useMemo, useState } from "react";
import * as z from "zod";
import Form from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import type { RJSFSchema } from "@rjsf/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { diffSpecs, patchEnvironment } from "@/lib/environment-edits";
import type { EnvironmentSpec } from "@/platform/environment";
import type { EnvError, ResolvedEnv } from "@/platform/resolve";
import { LOCAL_AUTHOR } from "@/stores/studio";

/**
 * Settings for every configurable contribution in the environment, as forms generated from
 * each `configSchema` (RJSF). Saving goes through the same JSON-Patch path the assistant
 * uses (lib/environment-edits.ts), so a human edit is validated, undoable and saved exactly
 * like an agent's.
 */
export function ModuleConfigDialog({ open, onOpenChange, env, projectId }: { open: boolean; onOpenChange: (o: boolean) => void; env: ResolvedEnv; projectId: string }) {
  const items = useMemo(() => {
    const out: { id: string; title: string; schema: RJSFSchema; value: Record<string, unknown> }[] = [];
    const add = (id: string, title: string, schema: z.ZodType | undefined, value: Record<string, unknown>) => {
      if (!schema) return;
      try {
        out.push({ id, title, schema: z.toJSONSchema(schema, { unrepresentable: "any", io: "input" }) as RJSFSchema, value });
      } catch {
        /* a schema JSON Schema can't express isn't offered as a form */
      }
    };
    env.viewports.forEach((v) => add(v.renderer.id, `Viewer · ${v.renderer.description}`, v.renderer.configSchema, v.config));
    for (const c of [env.dataKind, ...Object.values(env.panels).flat(), ...env.exporters]) add(c.id, c.description, c.configSchema, env.configs[c.id] ?? {});
    return out;
  }, [env]);
  const [errors, setErrors] = useState<EnvError[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  const save = async (id: string, value: Record<string, unknown>) => {
    setErrors([]);
    const next = structuredClone(env.source) as EnvironmentSpec;
    const vpIndex = env.viewports.findIndex((v) => v.renderer.id === id);
    if (vpIndex >= 0) {
      // Viewport config lives on the viewport; materialise the merged viewports first.
      next.viewports = structuredClone(env.spec.viewports ?? []);
      next.viewports[vpIndex] = { ...next.viewports[vpIndex], config: value };
    } else {
      next.overrides = [...(next.overrides ?? []).filter((o) => !(o.id === id && o.config)), { id, config: value }];
    }
    const r = await patchEnvironment(projectId, diffSpecs(env.source, next), LOCAL_AUTHOR);
    if ("errors" in r) setErrors(r.errors);
    else setSaved(id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl gap-0 overflow-y-auto p-0">
        <DialogHeader className="border-b border-border px-6 py-4 text-left">
          <DialogTitle className="text-body-2 font-semibold">Environment settings</DialogTitle>
          <DialogDescription>Each change is validated, saved with this project and can be undone like an assistant edit.</DialogDescription>
        </DialogHeader>
        <div className="space-y-6 px-6 py-5">
          {!items.length && <p className="text-sm text-muted-foreground">Nothing in this environment has settings.</p>}
          {items.map((it) => (
            <section key={it.id} className="rjsf-studio" aria-label={it.id}>
              <h3 className="mb-0.5 text-sm font-semibold">{it.title}</h3>
              <p className="mb-2 font-mono text-[11px] text-muted-foreground">{it.id}</p>
              <Form
                schema={it.schema}
                formData={it.value}
                validator={validator}
                onSubmit={({ formData }) => save(it.id, (formData ?? {}) as Record<string, unknown>)}
                uiSchema={{ "ui:submitButtonOptions": { submitText: saved === it.id ? "Saved" : "Apply" } }}
              />
            </section>
          ))}
          {errors.length > 0 && (
            <ul className="space-y-1 text-sm" role="alert">
              {errors.map((e, i) => (
                <li key={i} className="rounded-md bg-warning-tint px-3 py-2">
                  <code className="font-mono text-code">{e.path}</code> · {e.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
