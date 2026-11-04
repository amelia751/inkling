import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AddDataIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloseIcon,
  DoneIcon,
  ErrorIcon,
  FolderIcon,
  QueuedIcon,
  WarningIcon,
} from "@studio/ui/icons";
import { Button } from "@studio/ui/ui/button";
import { Checkbox } from "@studio/ui/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@studio/ui/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@studio/ui/ui/dropdown-menu";
import { Label } from "@studio/ui/ui/label";
import { Spinner } from "@studio/ui/ui/spinner";
import { bytesInFlight, INSPECTION_STALLED_REASON, NOT_UPLOADED, settledPhase, trayLine, useUploads, type TraySession } from "@/studio/stores/uploads";
import { fromDataTransfer, fromFileList, hasFiles, type Picked } from "@/studio/lib/uploads/walk";
import { cn } from "@studio/ui/utils";
import { resumeDrop } from "@/studio/core/drops/start";
import { useDrops } from "@/studio/core/drops/store";

/** Invalidate a project's queries when an import changes what's in it. */
export function useRefreshProject() {
  const qc = useQueryClient();
  return (projectId: string) => {
    void qc.invalidateQueries({ queryKey: ["projects", projectId] });
    void qc.invalidateQueries({ queryKey: ["sources"] });
    void qc.invalidateQueries({ queryKey: ["source-nodes"] });
    void qc.invalidateQueries({ queryKey: ["files", projectId] });
  };
}

/** Start an import into a project, refreshing its views as the session moves. */
export function useAddData(projectId: string | undefined) {
  const add = useUploads((s) => s.add);
  const refresh = useRefreshProject();
  return (picked: Picked, targetNodeId?: string) => (projectId ? add(projectId, picked, { targetNodeId, onChanged: refresh }) : Promise.resolve(undefined));
}

/**
 * The `+ Add data ▾` split button (todo6 Phase 4.4): the main part picks files, the chevron
 * offers Files… and Folder… (`webkitdirectory`, which keeps the folder structure).
 */
export function AddDataButton({ onPick, size = "lg", variant = "default", label = "Add data" }: { onPick: (p: Picked) => void; size?: "default" | "lg"; variant?: "default" | "outline"; label?: string }) {
  const { files, folder, inputs } = usePickers(onPick);
  return (
    <div className="inline-flex" role="group" aria-label={label}>
      {inputs}
      <Button size={size} variant={variant} className="rounded-r-none" onClick={files} data-testid="add-data">
        <AddDataIcon /> {label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size={size} variant={variant} className={cn("rounded-l-none px-2", variant === "default" ? "border-l border-primary-foreground/25" : "border-l-0")} aria-label="More ways to add data" data-testid="add-data-menu">
            <ChevronDownIcon className="opacity-80" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={files}>Files…</DropdownMenuItem>
          <DropdownMenuItem onSelect={folder}>
            <FolderIcon /> Folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Two hidden inputs and functions that open them. */
export function usePickers(onPick: (p: Picked) => void) {
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const take = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) onPick(fromFileList(e.target.files));
    e.target.value = "";
  };
  const inputs = (
    <>
      <input ref={fileRef} type="file" multiple hidden onChange={take} data-testid="pick-files" />
      <input ref={dirRef} type="file" multiple hidden onChange={take} data-testid="pick-folder" {...{ webkitdirectory: "", directory: "" }} />
    </>
  );
  return { files: () => fileRef.current?.click(), folder: () => dirRef.current?.click(), inputs };
}

/**
 * Drop anywhere on the page: a dashed `--g-line-focus` outline over the veil, naming where
 * the files go ("Drop to add to patient_002"). `target` may change with the hovered row.
 */
export function DropOverlay({ onDrop, label, children, className }: { onDrop: (p: Picked) => void; label: string; children: ReactNode; className?: string }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        depth.current++;
        setOver(true);
      }}
      onDragLeave={() => {
        if (--depth.current <= 0) {
          depth.current = 0;
          setOver(false);
        }
      }}
      onDragOver={(e) => {
        if (hasFiles(e.dataTransfer)) e.preventDefault();
      }}
      onDrop={async (e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        onDrop(await fromDataTransfer(e.dataTransfer));
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-veil p-6" data-testid="drop-overlay">
          <div className="flex h-full w-full items-center justify-center rounded-xl border-2 border-dashed border-ring">
            <p className="rounded-lg bg-float px-4 py-2 text-body-2 shadow-float">
              Drop to add to <em className="font-semibold not-italic">{label}</em>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** A large drop surface (empty states, Home): drop, Browse files, Browse folder. */
export function DropZone({ onPick, title, hint, className }: { onPick: (p: Picked) => void; title: string; hint?: ReactNode; className?: string }) {
  const { files, folder, inputs } = usePickers(onPick);
  const [over, setOver] = useState(false);
  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors", over ? "border-ring bg-selection" : "border-border-hover", className)}
      onDragOver={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onPick(await fromDataTransfer(e.dataTransfer));
      }}
      data-testid="drop-zone"
    >
      {inputs}
      <AddDataIcon className="size-8 text-hint" />
      <p className="text-body-2 font-semibold">{title}</p>
      {hint && <p className="max-w-md text-sm text-muted-foreground">{hint}</p>}
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" size="lg" onClick={files}>Browse files</Button>
        <Button type="button" variant="outline" size="lg" onClick={folder}>
          <FolderIcon /> Browse folder
        </Button>
      </div>
    </div>
  );
}

/** Mounted once by the shell: the attestation dialog, the tray and the unload warning. */
export function UploadLayer() {
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (bytesInFlight()) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return (
    <>
      <AttestationDialog />
      <UploadTray />
    </>
  );
}

/** Once per project and person, before anything uploads (todo6 §3.2). */
function AttestationDialog() {
  const attestation = useUploads((s) => s.attestation);
  const answer = useUploads((s) => s.answerAttestation);
  const [ok, setOk] = useState(false);
  useEffect(() => setOk(false), [attestation]);
  return (
    <Dialog open={!!attestation} onOpenChange={(open) => !open && answer(false)}>
      <DialogContent className="max-w-md" data-testid="attestation">
        <DialogHeader>
          <DialogTitle>
            Upload {attestation?.count.toLocaleString()} {attestation?.count === 1 ? "file" : "files"}?
          </DialogTitle>
          <DialogDescription className="sr-only">Confirm you may use these files before they upload.</DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2.5">
          <Checkbox id="attest" checked={ok} onCheckedChange={(v) => setOk(v === true)} />
          <Label htmlFor="attest" className="leading-snug">
            I may use these files, and they're de-identified or synthetic.{" "}
            <a href="/privacy#uploads" target="_blank" rel="noreferrer" className="font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground">
              What counts?
            </a>
          </Label>
        </div>
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={() => answer(false)}>Cancel</Button>
          <Button size="lg" disabled={!ok} onClick={() => answer(true)} data-testid="attest-confirm">
            <CheckIcon /> Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadTray() {
  const all = useUploads((s) => s.sessions);
  // Chat drops show their progress on their card (todo13), not here.
  const sessions = all.filter((s) => !s.quiet);
  const collapsed = useUploads((s) => s.collapsed);
  const setCollapsed = useUploads((s) => s.setCollapsed);
  if (!sessions.length) return null;
  return (
    <section className="fixed bottom-4 right-4 z-50 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-xl bg-float shadow-popup" aria-label="Uploads" data-testid="upload-tray">
      <header className="flex h-10 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">Uploads</span>
        <Button variant="ghost-secondary" size="icon" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand uploads" : "Collapse uploads"}>
          {collapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
      </header>
      <ul className="thin-scrollbar max-h-[50vh] divide-y divide-border overflow-y-auto">
        {sessions.map((s) => (
          <TrayRow key={s.key} s={s} collapsed={collapsed} />
        ))}
      </ul>
    </section>
  );
}

function PhaseIcon({ s }: { s: TraySession }) {
  const bad = s.files.some((f) => f.state === "failed" || f.state === "rejected");
  if (s.phase === "attesting") return <QueuedIcon className="size-4 text-hint" />;
  if (s.phase === "preparing" || s.phase === "uploading" || s.phase === "checking") return <Spinner className="size-4" />;
  if (s.phase === "partial") return <WarningIcon className="size-4 text-warning" />;
  if (s.phase === "failed" || bad) return <ErrorIcon className="size-4 text-danger" />;
  if (s.phase === "cancelled") return <CloseIcon className="size-4 text-hint" />;
  if (s.needsReview) return <WarningIcon className="size-4 text-warning" />;
  return <DoneIcon className="size-4 text-positive" />;
}

function TrayRow({ s, collapsed }: { s: TraySession; collapsed: boolean }) {
  const retry = useUploads((x) => x.retry);
  const recheck = useUploads((x) => x.recheck);
  const cancel = useUploads((x) => x.cancel);
  const dismiss = useUploads((x) => x.dismiss);
  const setCollapsed = useUploads((x) => x.setCollapsed);
  const add = useUploads((x) => x.add);
  const refresh = useRefreshProject();
  const [open, setOpen] = useState(false);
  const failed = s.files.filter((f) => f.state === "failed" || f.state === "rejected");
  // todo24 D5: a finished session's files that never went up are retried with the failed ones.
  const retriable = failed.length + (settledPhase(s.phase) && s.phase !== "cancelled" ? s.files.filter((f) => f.state === "pending").length : 0);
  const busy = s.phase === "preparing" || s.phase === "uploading";
  // Stopped before the kernel had the files (a network drop, a reload): offer the same picker again.
  const interrupted = s.phase === "failed" && !s.importId;
  const again = usePickers((picked) => {
    const drop = s.dropId ? useDrops.getState().drops[s.dropId] : undefined;
    if (drop) void resumeDrop(drop, picked);
    else void add(s.projectId, picked, { targetNodeId: s.targetNodeId, onChanged: refresh });
    dismiss(s.key);
  });
  const skipped = s.files.filter((f) => f.state === "skipped_duplicate").length;
  return (
    <li className="px-3 py-2.5 text-sm" data-testid="tray-session" data-phase={s.phase}>
      <div className="flex items-center gap-2">
        <PhaseIcon s={s} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={s.title}>{s.title}</p>
          <p className="truncate text-muted-foreground" data-testid="tray-line">{trayLine(s)}</p>
        </div>
        {!busy && s.phase !== "checking" && (
          <Button variant="ghost-secondary" size="icon" onClick={() => dismiss(s.key)} aria-label="Dismiss">
            <CloseIcon />
          </Button>
        )}
      </div>
      {!collapsed && (
        <>
          {(s.skippedJunk > 0 || skipped > 0) && (
            <p className="mt-1 pl-6 text-xs text-muted-foreground">
              {[skipped > 0 && `${skipped} already in this project`, s.skippedJunk > 0 && `${s.skippedJunk} system ${s.skippedJunk === 1 ? "file" : "files"} skipped`].filter(Boolean).join(" · ")}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap gap-1.5 pl-6">
            {interrupted && (
              <>
                {again.inputs}
                <Button size="sm" variant="outline" onClick={again.files} data-testid="tray-drop-again">Drop again</Button>
                <Button size="sm" variant="ghost-secondary" onClick={() => dismiss(s.key)} data-testid="tray-dismiss">Dismiss</Button>
              </>
            )}
            {retriable > 0 && s.importId && !busy && (
              <Button size="sm" variant="outline" onClick={() => void retry(s.key)} data-testid="tray-retry">Retry failed</Button>
            )}
            {(failed.length > 0 || s.files.length > 0) && (
              <Button size="sm" variant="ghost-secondary" onClick={() => setOpen((o) => !o)}>{open ? "Hide files" : "Show files"}</Button>
            )}
            {s.importId && ((s.phase === "checking" && s.stalled) || (s.phase === "failed" && s.error === INSPECTION_STALLED_REASON)) && (
              <Button size="sm" variant="outline" onClick={() => void recheck(s.key)} data-testid="tray-recheck">Retry</Button>
            )}
            {busy && <Button size="sm" variant="ghost-secondary" onClick={() => void cancel(s.key)}>Cancel</Button>}
            {(busy || s.phase === "checking") && <Button size="sm" variant="ghost-secondary" onClick={() => setCollapsed(true)}>{s.stalled ? "Keep uploading" : "Keep working"}</Button>}
          </div>
          {open && (
            <ul className="mt-1.5 max-h-40 overflow-y-auto pl-6 text-xs" data-testid="tray-files">
              {s.files.map((f) => (
                <li key={f.clientFileId} className="flex gap-2 py-0.5">
                  <span className="min-w-0 flex-1 truncate" title={f.relPath}>{f.relPath}</span>
                  <span className={cn("shrink-0", f.state === "failed" || f.state === "rejected" ? "text-danger" : "text-muted-foreground")}>{fileRowText(s, f)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

const FILE_STATE: Record<string, string> = { pending: "Waiting", uploaded: "Uploaded", skipped_duplicate: "Already in this project", rejected: "Not accepted", failed: "Didn't upload" };

/** A file row's words: a session that isn't moving leaves its unsent files "Not uploaded", never "Waiting" (todo24 D5). */
export function fileRowText(s: Pick<TraySession, "phase">, f: Pick<TraySession["files"][number], "state" | "reason">): string {
  if (f.reason) return f.reason;
  if (f.state === "pending" && settledPhase(s.phase)) return NOT_UPLOADED;
  return FILE_STATE[f.state] ?? f.state;
}
