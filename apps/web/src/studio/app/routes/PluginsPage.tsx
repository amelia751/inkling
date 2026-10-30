import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnnotateIcon, SearchIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Input } from "@studio/ui/ui/input";
import { AppLayout, PageHeading } from "@/studio/components/layout/app-layout";
import { InstallReview } from "@/studio/components/plugins/InstallReview";
import { kernelEnabled } from "@/extension-host/kernel";
import { approveInstall, disablePlugin, installedPlugins, planInstall, rejectInstall, rollbackPlugin, searchPlugins, stageInstall, type InstallRequest } from "@/studio/lib/plugins-api";
import { studioUrl } from "@/studio/lib/routes";
import { FullPageMessage, useDatasetParam, useProject, useProjectParam } from "./shared";

/**
 * Workspace plugins (todo2 Phase 5): what's installed with version, state and permissions
 * (requested / granted / used), disable and rollback; and the registry, where installing
 * goes through plan → stage → the install-review dialog → approve. Activation reaches an
 * open Studio through the workspace state, without a deploy or reload.
 */
export function PluginsPage() {
  const datasetId = useDatasetParam();
  const projectId = useProjectParam();
  const { project, isLoading } = useProject(datasetId);
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [review, setReview] = useState<InstallRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabled = kernelEnabled();
  const installed = useQuery({ queryKey: ["plugins", datasetId], queryFn: () => installedPlugins(datasetId), enabled: enabled && !!project });
  const registry = useQuery({ queryKey: ["registry", datasetId, query], queryFn: () => searchPlugins(datasetId, query), enabled: enabled && !!project });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["plugins", datasetId] });
    // The Studio re-reads the workspace state and activates what changed.
    void qc.invalidateQueries({ queryKey: ["workspace", datasetId] });
  };
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const startInstall = async (pluginId: string) => {
    setError(null);
    try {
      const plan = await planInstall(datasetId, pluginId);
      setReview(plan.state === "RESOLVED" ? await stageInstall(datasetId, plan.requestId) : plan);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (isLoading) return <FullPageMessage title="Loading plugins…" loading />;
  if (!project) return <FullPageMessage title="Dataset not found" />;
  if (!enabled)
    return (
      <FullPageMessage
        title="Plugins need the kernel"
        body="Start apps/api and run the web app with the kernel proxy on (see apps/api/README.md) to install, disable and roll back plugins per workspace."
      />
    );

  const active = new Map((installed.data?.plugins ?? []).map((p) => [p.pluginId, p]));
  return (
    <AppLayout dataset={{ id: project.id, title: project.title }}>
      <div className="mx-auto w-full max-w-5xl px-4 py-5 md:px-6 md:py-6">
        <PageHeading
          title="Plugins"
          description="Installed in this workspace only. Installing new code or permissions always asks for approval."
          actions={<Button variant="outline" size="lg" asChild><Link to={studioUrl(projectId, project.id)}><AnnotateIcon />Back to annotating</Link></Button>}
        />
        {error && <p className="mb-3 rounded-md bg-danger-tint px-3 py-2 text-sm text-danger" role="alert">{error}</p>}

        <h2 className="mb-2 text-body-2 font-semibold">Installed</h2>
        <Card className="mb-6 divide-y divide-border" data-testid="installed-plugins">
          {(installed.data?.plugins ?? []).map((p) => (
            <div key={p.pluginId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-plugin={p.pluginId}>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{p.name ?? p.pluginId}</div>
                <div className="text-muted-foreground">
                  {p.pluginId}@{p.version} · config r{p.configRevision}
                  {p.permissions.granted.length > 0 && ` · granted ${p.permissions.granted.join(", ")}`}
                  {p.permissions.used.length > 0 && ` · used ${p.permissions.used.join(", ")}`}
                </div>
              </div>
              <Badge theme={p.state === "ACTIVATED" ? "success" : p.state === "DISABLED" ? "unknown" : "warning"}>{p.state.toLowerCase()}</Badge>
              {p.state === "ACTIVATED" && (
                <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => act.mutate(() => disablePlugin(datasetId, p.pluginId))}>Disable</Button>
              )}
              {p.state !== "ACTIVATED" && (
                <Button variant="outline" size="sm" disabled={act.isPending} onClick={() => startInstall(p.pluginId)}>Enable</Button>
              )}
              <Button variant="ghost-secondary" size="sm" disabled={act.isPending} onClick={() => act.mutate(() => rollbackPlugin(datasetId, p.pluginId))}>Roll back</Button>
            </div>
          ))}
          {installed.isLoading && <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>}
        </Card>

        <div className="mb-2 flex items-center gap-3">
          <h2 className="text-body-2 font-semibold">Registry</h2>
          <div className="relative ml-auto w-72">
            <SearchIcon className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search capabilities, e.g. segment" className="pl-8" aria-label="Search plugins" />
          </div>
        </div>
        <Card className="divide-y divide-border" data-testid="registry-plugins">
          {(registry.data ?? []).map((p) => {
            const mine = active.get(p.id);
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-registry-plugin={p.id}>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{p.name ?? p.id} <span className="font-normal text-muted-foreground">{p.version}</span></div>
                  <div className="text-muted-foreground">{p.description}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.capabilities.map((c) => <Badge key={c} theme="clear">{c}</Badge>)}
                    <Badge theme={p.trustTier === "first-party" ? "info" : p.trustTier === "generated" ? "warning" : "normal"}>{p.trustTier}</Badge>
                  </div>
                </div>
                {mine?.state === "ACTIVATED" ? (
                  <Badge theme="success">installed {mine.version}</Badge>
                ) : (
                  <Button size="sm" onClick={() => startInstall(p.id)} data-testid={`install-${p.id}`}>Install…</Button>
                )}
              </div>
            );
          })}
        </Card>
      </div>
      <InstallReview
        request={review}
        open={!!review}
        busy={act.isPending}
        onOpenChange={(o) => !o && setReview(null)}
        onReject={() => review && act.mutate(() => rejectInstall(datasetId, review.requestId).finally(() => setReview(null)))}
        onApprove={(grant) => review && act.mutate(() => approveInstall(datasetId, review.requestId, grant).finally(() => setReview(null)))}
      />
    </AppLayout>
  );
}
