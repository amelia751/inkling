import { useEffect, useState } from "react";
import { ExportIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { fetchAnnotations } from "@/studio/lib/api";
import { projectItems } from "@/studio/lib/items";
import type { Project } from "@studio/contracts/types";
import { envOf } from "@/studio/lib/environment";
import type { Exporter, ExporterImpl } from "@studio/plugin-ui-sdk/module";
import { registry } from "@/extension-host/registry";

/**
 * Standard-format downloads offered by the project's environment (COCO, NIfTI masks,
 * QuPath GeoJSON, WFDB…). Always built from the server's saved revision, never unsaved edits.
 */
export function FormatExports({ project, enabled }: { project: Project; enabled: boolean }) {
  const env = envOf(project);
  const [impls, setImpls] = useState<Exporter[] | null>(null);
  useEffect(() => {
    if (!env) return;
    let live = true;
    Promise.all(
      env.exporters.map(async (c) => {
        const impl = await registry.loadImpl<ExporterImpl>(c.id);
        return { ...impl, id: c.id, label: c.label, description: c.description } as Exporter;
      }),
    ).then((list) => live && setImpls(list));
    return () => {
      live = false;
    };
  }, [env]);
  const exporters = (impls ?? []).filter((e) => e.available?.(project) ?? true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!exporters.length) return null;

  const run = async (id: string) => {
    const ex = exporters.find((e) => e.id === id)!;
    setBusy(id);
    setError(null);
    try {
      const doc = await fetchAnnotations(project.id);
      const blob = await ex.build({ project, items: projectItems(project), annotations: doc.annotations, env });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = ex.filename(project);
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError(`${ex.label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="p-0">
      <h2 className="border-b border-border px-4 py-3 text-sm font-medium">Standard formats</h2>
      <div className="divide-y divide-border">
        {exporters.map((ex) => (
          <div key={ex.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{ex.label}</div>
              <div className="text-sm text-muted-foreground">{ex.description}</div>
            </div>
            <Button variant="outline" onClick={() => run(ex.id)} disabled={!enabled || busy !== null}>
              <ExportIcon /> {busy === ex.id ? "Preparing…" : "Download"}
            </Button>
          </div>
        ))}
      </div>
      {error && <p className="border-t border-border px-4 py-2 text-sm text-destructive">{error}</p>}
    </Card>
  );
}
