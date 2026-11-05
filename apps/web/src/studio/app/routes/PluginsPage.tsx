import { useState } from "react";
import { Alert } from "@studio/ui/ui/alert";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnnotateIcon, SearchIcon } from "@studio/ui/icons";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Input } from "@studio/ui/ui/input";
import { AppLayout, PageHeading, PageContainer } from "@/studio/components/layout/app-layout";
import { InstallReview } from "@/studio/components/plugins/InstallReview";
import { kernelEnabled } from "@/extension-host/kernel";
import { BUILTIN_MODULES } from "@/extension-host/bundled";
import { registry } from "@/extension-host/registry";
import { PLUGIN_PACKAGES } from "@/extension-host/manifests";
import { approveInstall, disablePlugin, installedPlugins, planInstall, rejectInstall, rollbackPlugin, searchPlugins, stageInstall, type InstallRequest } from "@/studio/lib/plugins-api";
import { studioUrl } from "@/studio/lib/routes";
import { useProjectSummary } from "@/studio/lib/projects-api";
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
  // The kernel workspace is the project (todo6 D1): any project the person can see, or a
  // manifest project (legacy routes, test-injected seeds).
  const summary = useProjectSummary(projectId);
  const legacy = useProject(datasetId);
  const project = summary.data ?? legacy.project;
  const isLoading = !project && (summary.isLoading || legacy.isLoading);
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

  if (isLoading)
    return (
      <AppLayout>
        <PageContainer>
          <div className="mb-6" aria-busy data-testid="plugins-skeleton">
            <Skeleton className="h-7 w-32" />
            <SkeletonText className="mt-2 w-2/3" />
          </div>
          <SkeletonText variant="subheader" className="mb-2 w-20" />
          <Card className="mb-6 divide-y divide-border">
            <PluginRowsSkeleton />
          </Card>
        </PageContainer>
      </AppLayout>
    );
  if (!project) return <FullPageMessage kind="not-found" title="Dataset not found" />;
  if (!enabled)
    return (
      <AppLayout dataset={{ id: project.id, title: project.title }}>
        <PageContainer>
          <PageHeading
            title="Plugins"
            description="The plugins built into this app. They work in every project without installing anything."
            actions={<Button variant="outline" size="lg" asChild><Link to={studioUrl(projectId, summary.data?.sample === false ? undefined : project.id)}><AnnotateIcon />Back to annotating</Link></Button>}
          />
          <BuiltInPlugins />
          <p className="mt-4 text-sm text-muted-foreground" data-testid="plugins-needs-api">
            Installing more plugins, or turning one off for this project, needs the API: see README.md.
          </p>
        </PageContainer>
      </AppLayout>
    );

  const active = new Map((installed.data?.plugins ?? []).map((p) => [p.pluginId, p]));
  return (
    <AppLayout dataset={{ id: project.id, title: project.title }}>
      <PageContainer>
        <PageHeading
          title="Plugins"
          description="Installed in this workspace only. Installing new code or permissions always asks for approval."
          actions={<Button variant="outline" size="lg" asChild><Link to={studioUrl(projectId, summary.data?.sample === false ? undefined : project.id)}><AnnotateIcon />Back to annotating</Link></Button>}
        />
        {error && <Alert theme="danger" className="mb-3">{error}</Alert>}

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
          {installed.isLoading && <PluginRowsSkeleton />}
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
      </PageContainer>
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

const SHELL_PARTS = new Set(BUILTIN_MODULES.map((m) => m.id));
// Plugins with a Python worker run their jobs in apps/worker: without the API they show, but can't run.
const NEEDS_WORKER = new Set(PLUGIN_PACKAGES.packages.filter((p) => p.manifest.runtime.kind === "python-worker").map((p) => p.manifest.id));

/** The plugins bundled into this build (from the registry), always available without the API. */
function BuiltInPlugins() {
  const plugins = registry
    .listAvailable()
    .filter((m) => !SHELL_PARTS.has(m.id))
    .sort((a, b) => a.title.localeCompare(b.title));
  return (
    <>
      <h2 className="mb-2 text-body-2 font-semibold">Built in</h2>
      <Card className="divide-y divide-border" data-testid="builtin-plugins">
        {plugins.map((m) => {
          const kinds = m.contributes.dataKinds?.length ?? 0;
          const tools = m.contributes.tools?.length ?? 0;
          return (
            <div key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-plugin={m.id}>
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {m.title} <span className="font-normal text-muted-foreground">{m.version}</span>
                </div>
                <div className="text-muted-foreground">{m.description}</div>
                {(kinds > 0 || tools > 0) && (
                  <div className="tnum mt-1 text-hint">
                    {[kinds > 0 && `${kinds} data ${kinds === 1 ? "kind" : "kinds"}`, tools > 0 && `${tools} ${tools === 1 ? "tool" : "tools"}`].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              {NEEDS_WORKER.has(m.id) ? <Badge theme="unknown">needs the API</Badge> : <Badge theme="success">built in</Badge>}
            </div>
          );
        })}
      </Card>
    </>
  );
}

/** Placeholder installed-plugin rows: name, id line, state badge. */
function PluginRowsSkeleton() {
  return (
    <>
      {["w-1/3", "w-1/2", "w-2/5"].map((w, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3" aria-busy>
          <div className="min-w-0 flex-1">
            <SkeletonText variant="subheader" className="w-1/4" />
            <SkeletonText className={w} />
          </div>
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
      ))}
    </>
  );
}
