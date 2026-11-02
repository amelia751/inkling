import { invalidateFor } from "@/studio/lib/invalidate";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, FolderIcon } from "@studio/ui/icons";
import { Alert } from "@studio/ui/ui/alert";
import { Button } from "@studio/ui/ui/button";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Input } from "@studio/ui/ui/input";
import { Label } from "@studio/ui/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@studio/ui/ui/select";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { cn } from "@studio/ui/utils";
import type { SourceNode } from "@studio/contracts/types";
import { registry } from "@/extension-host/registry";
import { createDataset, fetchChildren, fetchSources, NeedsApiError, projectKeys } from "@/studio/lib/projects-api";
import { datasetUrl } from "@/studio/lib/routes";

// ---- New dataset (the simple form) -----------------------------------------------------------

interface Crumb {
  id: string | null;
  name: string;
}

/**
 * Name, folders and a preset. With no preset (todo20 D6) the Studio accepts every kind in the
 * picked folders, each with its profile's preset (the kernel works that out). Folders are picked in a flat list with a breadcrumb (Finder's
 * column-less list view): click a name to open it, tick it to include all of it.
 */
export function NewDatasetDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sources = useQuery({ queryKey: projectKeys.sources(projectId), queryFn: () => fetchSources(projectId) });
  const presets = useMemo(() => registry.list("presets").map((p) => ({ value: `preset:${p.name}`, title: p.title, description: p.description })), []);
  const [title, setTitle] = useState("");
  const [taskTitle, setTaskTitle] = useState("Studio");
  const [preset, setPreset] = useState<string>("");
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const source = sources.data?.find((s) => s.id === (sourceId ?? sources.data?.[0]?.id));
  const here = trail.at(-1)?.id ?? null;
  const children = useQuery({ queryKey: projectKeys.children(source?.id ?? "", here), queryFn: () => fetchChildren(source!.id, here), enabled: !!source });
  const create = useMutation({
    mutationFn: () => createDataset(projectId, { title: title.trim(), nodeIds: [...picked.keys()], task: { title: taskTitle.trim() || "Studio", ...(preset ? { preset } : {}) } }),
    onSuccess: (d) => {
      invalidateFor(qc, projectId, "dataset.changed");
      void qc.invalidateQueries({ queryKey: projectKeys.overview(projectId) });
      onClose();
      navigate(datasetUrl(projectId, d.id));
    },
  });
  const toggle = (id: string, name: string) =>
    setPicked((m) => {
      const next = new Map(m);
      if (next.has(id)) next.delete(id);
      else next.set(id, name);
      return next;
    });
  const label = (n: SourceNode) => n.displayPath ?? n.name;
  const rows = (children.data?.items ?? []).filter((n) => n.kind !== "sequence");
  const canCreate = !!title.trim() && picked.size > 0 && !create.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="new-dataset-dialog">
        <DialogHeader>
          <DialogTitle>New dataset</DialogTitle>
          <DialogDescription>Pick the folders to annotate and how the Studio should open them. Originals are never changed.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="dataset-title">Name</Label>
            <Input id="dataset-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Chest X-rays, first batch" autoFocus />
          </div>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Folders</span>
            {sources.data && sources.data.length > 1 && (
              <Select value={source?.id} onValueChange={(v) => { setSourceId(v); setTrail([]); }}>
                <SelectTrigger aria-label="Source" className="w-64"><SelectValue /></SelectTrigger>
                <SelectContent>{sources.data.map((s) => <SelectItem key={s.id} value={s.id}>{s.title}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <div className="rounded-md border border-border">
              <nav className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-sm" aria-label="Folder path" data-testid="folder-breadcrumb">
                <button type="button" className={cn("hover:underline", trail.length ? "text-muted-foreground" : "font-medium")} onClick={() => setTrail([])}>
                  {source?.title ?? "Sources"}
                </button>
                {trail.map((c, i) => (
                  <span key={c.id ?? i} className="flex items-center gap-1">
                    <ChevronRightIcon className="size-3.5 text-hint" />
                    <button type="button" className={cn("hover:underline", i === trail.length - 1 ? "font-medium" : "text-muted-foreground")} onClick={() => setTrail(trail.slice(0, i + 1))}>
                      {c.name}
                    </button>
                  </span>
                ))}
              </nav>
              <ul className="thin-scrollbar max-h-64 overflow-y-auto" data-testid="folder-list">
                {(sources.isLoading || children.isLoading) && <li className="px-3 py-2"><Skeleton className="h-5 w-48" /></li>}
                {sources.data?.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No sources yet. Add data first.</li>}
                {source && (
                  <li className="flex h-9 items-center gap-2 border-b border-border px-3 text-sm">
                    <Checkbox
                      id="pick-here"
                      checked={picked.has(here ?? source.rootNodeId ?? "")}
                      onCheckedChange={() => {
                        const id = here ?? source.rootNodeId;
                        if (id) toggle(id, trail.at(-1)?.name ?? source.title);
                      }}
                    />
                    <Label htmlFor="pick-here" className="font-normal text-muted-foreground">Everything in {trail.at(-1)?.name ?? source.title}</Label>
                  </li>
                )}
                {rows.map((n) => (
                  <li key={n.id} className="flex h-9 items-center gap-2 px-3 text-sm hover:bg-generic" data-testid="folder-row">
                    <Checkbox checked={picked.has(n.id)} onCheckedChange={() => toggle(n.id, label(n))} aria-label={`Include ${label(n)}`} />
                    {n.kind === "folder" ? (
                      <button type="button" data-testid="open-folder" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setTrail([...trail, { id: n.id, name: label(n) }])}>
                        <FolderIcon className="size-4 shrink-0 text-hint" />
                        <span className="truncate">{label(n)}</span>
                        <span className="tnum ml-auto shrink-0 text-muted-foreground">{n.descendantCount} files</span>
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{n.name}</span>
                    )}
                  </li>
                ))}
                {children.data && !rows.length && <li className="px-3 py-3 text-sm text-muted-foreground">This folder is empty.</li>}
              </ul>
            </div>
            <p className="text-sm text-muted-foreground" data-testid="picked-summary">
              {picked.size ? `${picked.size} picked: ${[...picked.values()].slice(0, 3).join(", ")}${picked.size > 3 ? "…" : ""}` : "Nothing picked yet."}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="dataset-preset">Studio setup</Label>
              <Select value={preset} onValueChange={setPreset}>
                <SelectTrigger id="dataset-preset" data-testid="preset-picker"><SelectValue placeholder="Every kind in these folders" /></SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.value} value={p.value} title={p.description}>{p.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-title">Studio name</Label>
              <Input id="task-title" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
            </div>
          </div>
          {create.error && (
            <Alert theme="danger">
              {create.error instanceof NeedsApiError ? "Creating datasets needs the full stack: see docs/running.md" : String(create.error.message)}
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!canCreate} data-testid="create-dataset">Create dataset</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
