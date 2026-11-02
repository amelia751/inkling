import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BranchIcon, TagIcon, TaskSetupIcon } from "@studio/ui/icons";
import { Alert } from "@studio/ui/ui/alert";
import { Badge } from "@studio/ui/ui/badge";
import { Button } from "@studio/ui/ui/button";
import { Card } from "@studio/ui/ui/card";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { api, type StudioSetup } from "./api";
import { useVersioning } from "./session";
import { comparable, studioChanges, type StudioChange } from "./studio-diff";

const short = (h?: string) => (h ? h.replace(/^sha256:/, "").slice(0, 10) : "—");
const show = (v: unknown) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/**
 * "Studio setup at this version" (todo10 Phase 2): the lockfile, environments and READMEs a
 * branch, commit or release carries in its `.studio/` tree, and what differs from the setup the
 * Studio runs now. A release pins this exactly; restoring a version (Revert) restores it.
 */
export function StudioSetupTab({ datasetId, initialRef }: { datasetId: string; initialRef?: string }) {
  const current = useVersioning((s) => (s.datasetId === datasetId ? s.branch : null));
  const branches = useQuery({ queryKey: ["versioning", datasetId, "branches"], queryFn: () => api.branches(datasetId, datasetId) });
  const releases = useQuery({ queryKey: ["versioning", datasetId, "releases"], queryFn: () => api.releases(datasetId, datasetId) });
  const [picked, setRef] = useState<string | null>(initialRef ?? null);
  const ref = picked ?? current ?? branches.data?.workBranch ?? "main";
  const setup = useQuery({ queryKey: ["versioning", datasetId, "studio", ref], queryFn: () => api.studio(datasetId, datasetId, ref, true), enabled: !!branches.data });
  const changes = useMemo(() => (setup.data?.current ? studioChanges(comparable(setup.data), comparable(setup.data.current)) : []), [setup.data]);
  const refs = [...(branches.data?.items ?? []).map((b) => ({ ref: b.name, label: b.name, tag: false })), ...(releases.data?.items ?? []).map((r) => ({ ref: `tag:${r.tag}`, label: r.tag, tag: true }))];

  return (
    <div className="mt-4 space-y-4" data-testid="studio-setup">
      <div className="flex flex-wrap items-center gap-2">
        {refs.map((r) => (
          <Button key={r.ref} size="sm" variant="ghost-secondary" selected={r.ref === ref} onClick={() => setRef(r.ref)} className="font-mono text-xs" data-studio-ref={r.ref}>
            {r.tag ? <TagIcon /> : <BranchIcon />}
            {r.label}
          </Button>
        ))}
      </div>
      {setup.isLoading && (
        <div className="flex flex-col gap-2" aria-busy>
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-10 w-full rounded-md" />)}
        </div>
      )}
      {setup.error && <Alert theme="danger">{String(setup.error)}</Alert>}
      {setup.data && <Setup s={setup.data} changes={changes} />}
    </div>
  );
}

function Setup({ s, changes }: { s: StudioSetup; changes: StudioChange[] }) {
  const tasks = Object.entries(s.tasks);
  if (!s.studioTree)
    return (
      <Card className="px-4 py-3 text-sm text-muted-foreground" data-testid="studio-setup-none">
        This version carries no Studio setup. Saving Task setup, or requesting a review from the Studio, commits it.
      </Card>
    );
  return (
    <>
      <Card className="px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <TaskSetupIcon className="size-4 text-muted-foreground" />
          <span className="font-medium">Studio setup at this version</span>
          <code className="font-mono text-xs text-muted-foreground" title={s.studioTree}>tree {short(s.studioTree)}</code>
          <code className="font-mono text-xs text-muted-foreground" title={s.lockfileHash} data-testid="studio-lockfile-hash">lockfile {short(s.lockfileHash)}</code>
          {changes.length === 0 ? <Badge theme="success" data-testid="studio-same">Same as the Studio now</Badge> : <Badge theme="warning" data-testid="studio-differs">{changes.length} change{changes.length === 1 ? "" : "s"} since</Badge>}
        </div>
      </Card>

      {changes.length > 0 && (
        <Card className="divide-y divide-border" data-testid="studio-diff">
          <div className="px-4 py-2 text-sm font-medium">What the Studio runs now differs from this version</div>
          {changes.map((c, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-2 px-4 py-2 text-sm" data-change={c.op}>
              <Badge theme={c.op === "add" ? "success" : c.op === "remove" ? "danger" : "info"}>{c.op}</Badge>
              <code className="font-mono text-xs">{c.path}</code>
              {c.before !== undefined && <code className="max-w-md truncate font-mono text-xs text-muted-foreground line-through">{show(c.before)}</code>}
              {c.after !== undefined && <code className="max-w-md truncate font-mono text-xs">{show(c.after)}</code>}
            </div>
          ))}
        </Card>
      )}

      <Card className="divide-y divide-border" data-testid="studio-lockfile">
        <div className="px-4 py-2 text-sm font-medium">Plugins (plugins.lock.json)</div>
        {(s.lockfile?.plugins ?? []).map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm" data-plugin={p.id}>
            <code className="font-mono text-xs">{p.id}</code>
            <span>{p.version}</span>
            <code className="font-mono text-xs text-muted-foreground" title={p.digest}>{short(p.digest)}</code>
            <Badge theme={p.signer === "first-party" ? "clear" : "warning"}>{p.signer}</Badge>
            {p.permissions.length > 0 && <span className="text-muted-foreground">{p.permissions.join(", ")}</span>}
          </div>
        ))}
      </Card>

      {tasks.map(([id, t]) => (
        <Card key={id} className="px-4 py-3 text-sm" data-studio-task={id}>
          <div className="mb-2 flex items-center gap-3">
            <span className="font-medium">Task {id}</span>
            <code className="font-mono text-xs text-muted-foreground" title={t.contentHash}>environment {short(t.contentHash)}</code>
          </div>
          {t.readme && <p className="mb-2 whitespace-pre-wrap text-muted-foreground">{t.readme}</p>}
          <pre className="max-h-64 overflow-auto rounded-md bg-generic p-3 font-mono text-code">{JSON.stringify(t.environment, null, 2)}</pre>
        </Card>
      ))}
    </>
  );
}
