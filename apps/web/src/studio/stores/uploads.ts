import { create } from "zustand";
import type { ImportSession, ImportState, SeedAsset, UploadFileState } from "@studio/contracts/types";
import type { DropOrigin } from "@studio/contracts/drops";
import { apiUrl, runtimeConfig } from "@/extension-host/runtime-config";
import { api, fetchProject, NeedsApiError } from "@/studio/lib/projects-api";
import { hashFiles } from "@/studio/lib/uploads/hash";
import type { Picked } from "@/studio/lib/uploads/walk";
import { markTimeline } from "@/studio/lib/drop-timeline";
import { apiFetch } from "@/extension-host/http";
import { onBeforeSignIn, signInAgain } from "@/studio/lib/session";

/**
 * Uploads (todo6 Phase 4.4): a Drive-style tray that never blocks. One entry per import:
 * the rights attestation (once per project and person), hashing in a worker ("Preparing…"),
 * the session request (the kernel skips what's already there), then the bytes, 4 files at a
 * time, in 64 MB chunks with backoff, then "Checking files…" until inspection reports.
 * Bytes in flight make `beforeunload` warn; after a reload, dropping the same folder resumes.
 */
export const CHUNK = 64 * 1024 * 1024;
const CONCURRENCY = 4;
const RETRIES = 4;

/** After this long in "Checking files", the session fails with a reason (todo15 D5). */
export const INSPECTION_GIVE_UP_MS = 10 * 60 * 1000;
export const INSPECTION_STALLED_REASON = "Inspection didn't finish in 10 minutes. Retry or drop the files again";

/**
 * Where a "Checking files" session stands (todo15 D5, fail loudly, never spin): `checking`
 * until `stallMs`, then `stalled` ("Still checking. Inspection is slow or unavailable"), then
 * `timedOut` after `giveUpMs`.
 */
export function inspectionStatus(checkingSince: number, now: number, stallMs = runtimeConfig().inspectionStallSeconds * 1000, giveUpMs = INSPECTION_GIVE_UP_MS): "checking" | "stalled" | "timedOut" {
  const elapsed = now - checkingSince;
  return elapsed >= giveUpMs ? "timedOut" : elapsed >= stallMs ? "stalled" : "checking";
}

export type TrayPhase = "attesting" | "preparing" | "uploading" | "checking" | "done" | "failed" | "cancelled";

export interface TrayFile {
  clientFileId: string;
  relPath: string;
  size: number;
  received: number;
  state: UploadFileState;
  reason: string | null;
}

export interface TraySession {
  key: string;
  projectId: string;
  importId?: string;
  /** todo13: the drop this upload belongs to. */
  dropId?: string;
  /** Not listed in the tray: its drop card shows the progress (chat drops). */
  quiet?: boolean;
  title: string;
  phase: TrayPhase;
  total: number;
  prepared: number;
  skippedJunk: number;
  files: TrayFile[];
  serverState?: ImportState;
  /** When this session entered "checking" (ms); restarts on Retry. */
  checkingSince?: number;
  /** Checking for longer than `inspectionStallSeconds`: inspection is slow or unavailable. */
  stalled?: boolean;
  /** Files the kernel flagged after inspection (privacy, unsupported, duplicates…). */
  needsReview?: boolean;
  error?: string;
  /** The folder it was going to (so "Drop again" lands in the same place). */
  targetNodeId?: string;
}

/** A browser-level failure (the network, a reload, the dev server restarting), not the kernel's reason. */
export const isNetworkError = (msg: string | undefined) => !msg || /failed to fetch|networkerror|load failed|network request failed|aborted|err_/i.test(msg);

/** The file row of a session that stopped before its bytes went up. */
export const NOT_UPLOADED = "Not uploaded";

/**
 * The plain headline of a failed session: what happened and what was kept, never "Failed to fetch".
 * The kernel's own reasons (limits, inspection timeouts) are already plain and pass through.
 */
export function failureText(error: string | undefined, files: Pick<TrayFile, "state">[]): string {
  const saved = files.some((f) => f.state === "uploaded" || f.state === "skipped_duplicate");
  if (isNetworkError(error)) return saved ? "Upload interrupted. Some files were saved." : "Upload interrupted. Nothing was saved.";
  return error!;
}

/** Files of a session that failed before the kernel knew them: each one says "Not uploaded", not "Preparing". */
export function notUploaded(picked: { relPath: string; size: number }[]): TrayFile[] {
  return picked.map((f, i) => ({ clientFileId: `f${i}`, relPath: f.relPath, size: f.size, received: 0, state: "failed", reason: NOT_UPLOADED }));
}

interface Attestation {
  projectId: string;
  count: number;
  /** One per upload waiting on this answer (two drops into one project share one dialog). */
  resolve: (ok: boolean) => void;
}

/** Why work stopped when the person left (todo18 D7): the tray says so. */
export type LeaveReason = "signedOut" | "orgSwitch" | "unauthorized";
export const LEAVE_REASONS: Record<LeaveReason, string> = {
  signedOut: "Upload stopped: you signed out. Sign in and drop the same files to resume",
  orgSwitch: "Upload stopped: you switched workspace. Switch back and drop the same files to resume",
  unauthorized: "Upload stopped: your session ended. Sign in and drop the same files to resume",
};

/** The 401 on a chunk PUT: stop the whole session, don't retry. */
class Unauthorized extends Error {}

interface UploadsState {
  sessions: TraySession[];
  collapsed: boolean;
  attestation: Attestation | null;
  setCollapsed: (c: boolean) => void;
  /** Start an import of picked files into a project (optionally into a folder). */
  /**
   * Start an import of picked files into a project (optionally into a folder). With `taskId`
   * (a drop into a Studio, todo11 D8) its images become the task's items at once: the server
   * answers with them and `onRegistered` gets them before any byte is sent.
   */
  add: (
    projectId: string,
    picked: Picked,
    opts?: {
      targetNodeId?: string;
      taskId?: string;
      onRegistered?: (items: SeedAsset[]) => void;
      onChanged?: (projectId: string) => void;
      /** todo13: the drop this upload belongs to (`core/drops`); the kernel groups its sessions. */
      drop?: { dropId: string; origin: DropOrigin };
      /** The tray entry's key, as soon as it exists (a drop card follows its progress). */
      onStarted?: (key: string) => void;
      /** Keep it out of the tray (a drop card shows its progress). */
      quiet?: boolean;
    },
  ) => Promise<TraySession | undefined>;
  retry: (key: string) => Promise<void>;
  /** "Still checking": ask the kernel again and restart the stall clock. */
  recheck: (key: string) => Promise<void>;
  cancel: (key: string) => Promise<void>;
  dismiss: (key: string) => void;
  answerAttestation: (ok: boolean) => void;
  /** Uploads waiting behind the open rights dialog (another project). */
  attestationQueue: Attestation[];
  /**
   * Leaving (sign-out, workspace switch, a 401): abort every upload in flight, cancel it on the
   * kernel, and say why on its tray row (todo18 D7). Returns how many were stopped.
   */
  abortAll: (reason: LeaveReason) => Promise<number>;
}

const blobs = new Map<string, Map<string, File>>();
const aborts = new Map<string, AbortController>();
const listeners = new Map<string, (projectId: string) => void>();
const watching = new Set<string>();
let seq = 0;

/** True while any bytes are on their way (beforeunload asks then, and only then). */
export const bytesInFlight = () => useUploads.getState().sessions.some((s) => s.phase === "uploading" || s.phase === "preparing" || s.phase === "checking");

export const useUploads = create<UploadsState>((set, get) => {
  const patch = (key: string, p: Partial<TraySession> | ((s: TraySession) => Partial<TraySession>)) =>
    set((st) => ({ sessions: st.sessions.map((s) => (s.key === key ? { ...s, ...(typeof p === "function" ? p(s) : p) } : s)) }));
  const patchFile = (key: string, fid: string, p: Partial<TrayFile>) => patch(key, (s) => ({ files: s.files.map((f) => (f.clientFileId === fid ? { ...f, ...p } : f)) }));
  const session = (key: string) => get().sessions.find((s) => s.key === key);
  const changed = (key: string) => {
    const s = session(key);
    if (s) listeners.get(key)?.(s.projectId);
  };

  async function attest(projectId: string, count: number): Promise<boolean> {
    const p = await fetchProject(projectId).catch(() => null);
    if (p?.attested) return true;
    return new Promise((resolve) => {
      const { attestation, attestationQueue } = get();
      if (!attestation) return set({ attestation: { projectId, count, resolve } });
      // Same project: one dialog with both counts; both uploads get the answer.
      if (attestation.projectId === projectId) {
        const prev = attestation.resolve;
        return set({ attestation: { projectId, count: attestation.count + count, resolve: (ok) => (prev(ok), resolve(ok)) } });
      }
      const same = attestationQueue.find((a) => a.projectId === projectId);
      if (same) {
        const prev = same.resolve;
        return set({ attestationQueue: attestationQueue.map((a) => (a === same ? { projectId, count: a.count + count, resolve: (ok: boolean) => (prev(ok), resolve(ok)) } : a)) });
      }
      set({ attestationQueue: [...attestationQueue, { projectId, count, resolve }] });
    });
  }

  async function sendFile(key: string, importId: string, f: TrayFile, signal: AbortSignal): Promise<void> {
    const file = blobs.get(key)?.get(f.clientFileId);
    if (!file) return patchFile(key, f.clientFileId, { state: "failed", reason: "Drop the file again to retry" });
    let offset = f.received;
    let attempt = 0;
    while (offset < f.size || (f.size === 0 && offset === 0 && attempt === 0)) {
      try {
        const res = await apiFetch(apiUrl(`/v1/uploads/${importId}/files/${encodeURIComponent(f.clientFileId)}?offset=${offset}`), { method: "PUT", body: file.slice(offset, offset + CHUNK), signal });
        const body = (await res.json().catch(() => ({}))) as { state?: UploadFileState; received?: number; reason?: string | null; detail?: string };
        if (res.status === 409 && /expected offset (\d+)/.test(body.detail ?? "")) {
          offset = Number(/expected offset (\d+)/.exec(body.detail!)![1]);
          continue;
        }
        if (res.status === 401) throw new Unauthorized();
        if (res.status === 413) return patchFile(key, f.clientFileId, { state: "rejected", reason: body.detail ?? "Too large" });
        if (!res.ok) throw new Error(body.detail ?? `${res.status}`);
        offset = body.received ?? offset;
        patchFile(key, f.clientFileId, { received: offset, state: body.state ?? "pending", reason: body.reason ?? null });
        if (body.state && body.state !== "pending") return;
        attempt = 0;
        if (f.size === 0) return;
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof Unauthorized) throw e;
        if (++attempt > RETRIES) return patchFile(key, f.clientFileId, { state: "failed", reason: "The connection dropped. Retry" });
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        void e;
      }
    }
  }

  async function upload(key: string): Promise<void> {
    const s = session(key);
    if (!s?.importId) return;
    const ctrl = new AbortController();
    aborts.set(key, ctrl);
    patch(key, { phase: "uploading", error: undefined });
    const queue = s.files.filter((f) => f.state === "pending");
    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          for (let f = queue.shift(); f; f = queue.shift()) await sendFile(key, s.importId!, f, ctrl.signal);
        }),
      );
    } catch (e) {
      if (!(e instanceof Unauthorized)) throw e;
      // Signed out mid-upload: stop every upload once (not 4 retries per file), then sign in.
      await get().abortAll("unauthorized");
      signInAgain();
      return;
    }
    if (ctrl.signal.aborted) return;
    const done = await api<ImportSession>(`/imports/${s.importId}/complete`, { method: "POST" });
    absorb(key, done);
    changed(key);
    await watch(key);
  }

  function absorb(key: string, server: ImportSession) {
    patch(key, (s) => ({
      ...(server.state === "inspecting" ? { checkingSince: s.checkingSince ?? Date.now() } : { checkingSince: undefined, stalled: false }),
      serverState: server.state,
      files: server.files ? server.files.map((f) => ({ clientFileId: f.clientFileId, relPath: f.relPath, size: f.size, received: f.received, state: f.state, reason: f.reason })) : s.files,
      phase: server.state === "inspecting" ? "checking" : server.state === "uploading" ? (s.phase === "uploading" ? "uploading" : "failed") : server.state === "failed" ? "failed" : server.state === "cancelled" ? "cancelled" : "done",
      needsReview: server.state === "needs_review",
      error: server.error ?? undefined,
    }));
  }

  /** "Checking files…" until the worker's inspection settles the session; loud when it doesn't (D5). */
  async function watch(key: string) {
    if (watching.has(key)) return;
    watching.add(key);
    try {
      for (let delay = 1000; session(key)?.phase === "checking"; delay = Math.min(delay * 1.5, 5000)) {
        await new Promise((r) => setTimeout(r, delay));
        const s = session(key);
        if (!s?.importId) return;
        const server = await api<ImportSession>(`/imports/${s.importId}`).catch(() => null);
        if (server) absorb(key, server);
        const now = session(key);
        if (now?.phase !== "checking") break;
        const status = inspectionStatus(now.checkingSince ?? Date.now(), Date.now());
        if (status === "timedOut") patch(key, { phase: "failed", stalled: false, error: INSPECTION_STALLED_REASON });
        else if (status === "stalled" && !now.stalled) patch(key, { stalled: true });
      }
    } finally {
      watching.delete(key);
    }
    changed(key);
  }

  return {
    sessions: [],
    collapsed: false,
    attestation: null,
    attestationQueue: [],
    setCollapsed: (collapsed) => set({ collapsed }),
    answerAttestation: (ok) => {
      get().attestation?.resolve(ok);
      const [next, ...rest] = get().attestationQueue;
      set({ attestation: next ?? null, attestationQueue: rest });
    },
    abortAll: async (reason) => {
      const live = get().sessions.filter((s) => s.phase === "attesting" || s.phase === "preparing" || s.phase === "uploading" || s.phase === "checking");
      const { attestation, attestationQueue } = get();
      set({ attestation: null, attestationQueue: [] });
      attestation?.resolve(false);
      for (const a of attestationQueue) a.resolve(false);
      await Promise.all(
        live.map(async (s) => {
          aborts.get(s.key)?.abort();
          // keepalive: the cancel still reaches the kernel while the page navigates away.
          if (s.importId && s.phase !== "checking") await apiFetch(apiUrl(`/v1/imports/${s.importId}/cancel`), { method: "POST", keepalive: true }).catch(() => null);
          patch(s.key, { phase: "cancelled", error: LEAVE_REASONS[reason] });
          changed(s.key);
        }),
      );
      return live.length;
    },
    add: async (projectId, picked, opts = {}) => {
      if (!picked.files.length) return undefined;
      const key = `upload-${++seq}`;
      const top = new Set(picked.files.map((f) => f.relPath.split("/")[0]));
      const title = top.size === 1 && picked.files[0].relPath.includes("/") ? [...top][0] : `${picked.files.length} ${picked.files.length === 1 ? "file" : "files"}`;
      const entry: TraySession = { key, projectId, title, phase: "attesting", total: picked.files.length, prepared: 0, skippedJunk: picked.skipped, files: [], dropId: opts.drop?.dropId, quiet: opts.quiet, targetNodeId: opts.targetNodeId };
      set((st) => ({ sessions: [entry, ...st.sessions], collapsed: opts.quiet ? st.collapsed : false }));
      if (opts.onChanged) listeners.set(key, opts.onChanged);
      opts.onStarted?.(key);
      if (!(await attest(projectId, picked.files.length))) {
        if (session(key)?.phase !== "cancelled") patch(key, { phase: "cancelled", error: "Nothing was uploaded" });
        return session(key);
      }
      markTimeline("attested");
      const ctrl = new AbortController();
      aborts.set(key, ctrl);
      patch(key, { phase: "preparing" });
      try {
        const shas = await hashFiles(picked.files.map((f) => f.file), (n) => patch(key, { prepared: n }), ctrl.signal);
        markTimeline("hashed");
        const files = picked.files.map((f, i) => ({ clientFileId: `f${i}`, relPath: f.relPath, size: f.file.size, sha256: shas[i] }));
        blobs.set(key, new Map(picked.files.map((f, i) => [`f${i}`, f.file])));
        const server = await api<ImportSession & { items?: SeedAsset[] }>(`/projects/${encodeURIComponent(projectId)}/imports`, { method: "POST", json: { attested: true, files, ...(opts.targetNodeId ? { targetNodeId: opts.targetNodeId } : {}), ...(opts.taskId ? { taskId: opts.taskId } : {}), ...(opts.drop ? { origin: { ...opts.drop.origin, dropId: opts.drop.dropId } } : {}) } });
        if (server.items) opts.onRegistered?.(server.items);
        markTimeline("import-created");
        patch(key, { importId: server.id });
        absorb(key, server);
        patch(key, { phase: "uploading" });
        changed(key);
        await upload(key);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return session(key);
        const error = e instanceof NeedsApiError ? e.message : e instanceof Error ? e.message : String(e);
        // Before the kernel knew the files, none of them went up: say so per file (no "Preparing").
        patch(key, (s) => ({ phase: "failed", error, files: s.files.length ? s.files : notUploaded(picked.files.map((f) => ({ relPath: f.relPath, size: f.file.size }))) }));
      }
      return session(key);
    },
    retry: async (key) => {
      const s = session(key);
      if (!s?.importId) return;
      const server = await api<ImportSession>(`/imports/${s.importId}/retry`, { method: "POST", json: {} });
      absorb(key, server);
      await upload(key);
    },
    recheck: async (key) => {
      const s = session(key);
      if (!s?.importId) return;
      patch(key, { phase: "checking", checkingSince: Date.now(), stalled: false, error: undefined });
      const server = await api<ImportSession>(`/imports/${s.importId}`).catch(() => null);
      if (server) absorb(key, server);
      changed(key);
      await watch(key);
    },
    cancel: async (key) => {
      aborts.get(key)?.abort();
      const s = session(key);
      if (s?.importId && (s.phase === "uploading" || s.phase === "preparing")) {
        const server = await api<ImportSession>(`/imports/${s.importId}/cancel`, { method: "POST" }).catch(() => null);
        if (server) absorb(key, server);
      }
      patch(key, { phase: "cancelled" });
      changed(key);
    },
    dismiss: (key) => {
      blobs.delete(key);
      aborts.delete(key);
      listeners.delete(key);
      set((st) => ({ sessions: st.sessions.filter((s) => s.key !== key) }));
    },
  };
});

// A sign-in redirect (any 401) leaves the page: stop uploads first and cancel them on the kernel.
onBeforeSignIn(() => void useUploads.getState().abortAll("unauthorized"));

/** "Uploading 1,204 files · 38%", "Checking files…", "Ready · 3 need attention". */
export function trayLine(s: TraySession): string {
  const n = s.total.toLocaleString();
  const files = `${n} ${s.total === 1 ? "file" : "files"}`;
  switch (s.phase) {
    case "attesting":
      return `Waiting for your confirmation · ${files}`;
    case "preparing":
      return `Preparing ${files} ${s.prepared ? `${Math.round((s.prepared / s.total) * 100)}%` : ""}`.trim();
    case "uploading": {
      const bytes = s.files.reduce((a, f) => a + (f.state === "pending" || f.state === "uploaded" ? f.size : 0), 0);
      const sent = s.files.reduce((a, f) => a + (f.state === "uploaded" ? f.size : f.state === "pending" ? f.received : 0), 0);
      return `Uploading ${files} · ${bytes ? Math.round((sent / bytes) * 100) : 100}%`;
    }
    case "checking":
      return s.stalled ? "Still checking. Inspection is slow or unavailable" : "Checking files";
    case "done": {
      const bad = s.files.filter((f) => f.state === "failed" || f.state === "rejected").length;
      if (bad) return `${bad} ${bad === 1 ? "file" : "files"} didn't upload`;
      return s.needsReview ? "Ready · some files need your attention" : "Ready";
    }
    case "failed": {
      if (s.error || !s.importId) return failureText(s.error, s.files);
      const bad = s.files.filter((f) => f.state === "failed" || f.state === "rejected").length;
      return bad ? `${bad} ${bad === 1 ? "file" : "files"} didn't upload` : "The upload stopped";
    }
    case "cancelled":
      return s.error ?? "Cancelled";
  }
}
