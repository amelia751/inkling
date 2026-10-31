import { useEffect, useState } from "react";
import { InfoIcon, WarningIcon } from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { Skeleton } from "@studio/ui/ui/skeleton";
import { plural, ReasonButton } from "./shared";

/**
 * Dataset banners for todo7 D6 and D7. Datasets pin file versions and freeze their file list,
 * so nothing changes under them silently; these banners say when something could change:
 * - "Newer version available for 3 files" → **Update**: a preview of the affected files and
 *   how many annotations stay on the version they were drawn on, then Update;
 * - "4 new files in *MRI* since this dataset was made. **Add them**".
 */

/** One row of `GET …/datasets/:ds/update-versions/preview`. */
export interface VersionUpdateFile {
  nodeId: string;
  name: string;
  from: number;
  to: number;
  /** Annotations drawn on the old version (they stay on it). */
  annotations: number;
}

export interface NewerVersionsBannerProps {
  /** Files with a newer version than the one the dataset pins. Nothing renders at 0. */
  count: number;
  /** Loads the preview when the Update dialog opens. */
  loadPreview: () => Promise<VersionUpdateFile[]>;
  /** Moves the pinned files to their current version (all previewed files). */
  onUpdate: (nodeIds: string[]) => void | Promise<void>;
  /** Set: Update is inert with this reason. */
  disabledReason?: string | null;
}

export function NewerVersionsBanner({ count, loadPreview, onUpdate, disabledReason }: NewerVersionsBannerProps) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<VersionUpdateFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setFiles(null);
    setError(null);
    loadPreview().then(
      (f) => live && setFiles(f),
      (e: unknown) => live && setError(e instanceof Error ? e.message : "Couldn't load what would change"),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open]);

  if (count <= 0) return null;
  const annotations = (files ?? []).reduce((s, f) => s + f.annotations, 0);
  const update = async () => {
    if (!files) return;
    setBusy(true);
    setError(null);
    try {
      await onUpdate(files.map((f) => f.nodeId));
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Banner testid="dataset-newer-versions">
        <span className="min-w-0">Newer version available for {plural(count, "file")}.</span>
        <ReasonButton variant="link" size="sm" className="h-auto px-0 font-semibold" reason={disabledReason} onClick={() => setOpen(true)} data-testid="dataset-update-versions">
          Update
        </ReasonButton>
      </Banner>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-lg rounded-lg" data-testid="dataset-update-dialog">
          <DialogHeader>
            <DialogTitle className="text-base">Update to the newest versions?</DialogTitle>
            <DialogDescription>The dataset will use the current version of these files. You can see the change in Activity.</DialogDescription>
          </DialogHeader>
          {!files && !error && (
            <div className="space-y-1" aria-busy>
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-4/5" />
            </div>
          )}
          {files && (
            <ul className="thin-scrollbar max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border text-sm" data-testid="dataset-update-preview">
              {files.map((f) => (
                <li key={f.nodeId} className="flex min-w-0 items-center gap-2 px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate" title={f.name}>
                    {f.name}
                  </span>
                  <span className="tnum shrink-0 text-muted-foreground">
                    v{f.from} → v{f.to}
                  </span>
                  {f.annotations > 0 && <span className="tnum shrink-0 text-xs text-warning">{plural(f.annotations, "annotation")}</span>}
                </li>
              ))}
            </ul>
          )}
          {files && annotations > 0 && (
            <p className="flex items-start gap-2 rounded-md bg-warning-tint px-3 py-2 text-sm" data-testid="dataset-update-warning">
              <WarningIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              {plural(annotations, "annotation")} stay on the version they were drawn on. They won't move to the new files.
            </p>
          )}
          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <ReasonButton reason={files && !files.length ? "Nothing to update" : null} loading={busy || (!files && !error)} onClick={() => void update()} data-testid="dataset-update-confirm">
              Update {files ? plural(files.length, "file") : ""}
            </ReasonButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export interface FollowedFoldersBannerProps {
  /** New files in the followed folders since the dataset was made. Nothing renders at 0. */
  count: number;
  /** The followed folders that have new files, by name. */
  folders: string[];
  onAdd: () => void | Promise<void>;
  busy?: boolean;
  disabledReason?: string | null;
}

/** "4 new files in MRI since this dataset was made. Add them". */
export function FollowedFoldersBanner({ count, folders, onAdd, busy, disabledReason }: FollowedFoldersBannerProps) {
  if (count <= 0) return null;
  const where = folders.length <= 2 ? folders.map((f, i) => (
    <span key={f}>
      {i > 0 && " and "}
      <em className="font-semibold not-italic">{f}</em>
    </span>
  )) : (
    <>
      <em className="font-semibold not-italic">{folders[0]}</em> and {plural(folders.length - 1, "other folder")}
    </>
  );
  return (
    <Banner testid="dataset-followed-folders" info>
      <span className="min-w-0">
        {plural(count, "new file")} in {where} since this dataset was made.
      </span>
      <ReasonButton variant="link" size="sm" className="h-auto px-0 font-semibold" reason={disabledReason} loading={busy} onClick={() => void onAdd()} data-testid="dataset-add-followed">
        Add them
      </ReasonButton>
    </Banner>
  );
}

function Banner({ children, testid, info }: { children: React.ReactNode; testid: string; info?: boolean }) {
  const Icon = info ? InfoIcon : WarningIcon;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-generic px-3 py-2 text-sm" role="status" data-testid={testid}>
      <Icon className={info ? "size-4 shrink-0 text-info" : "size-4 shrink-0 text-warning"} aria-hidden />
      {children}
    </div>
  );
}
