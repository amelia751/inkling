import type { DropOrigin, DropOriginKind } from "@studio/contracts/drops";
import type { SeedAsset } from "@studio/contracts/types";
import { ApiError } from "@/studio/lib/projects-api";
import { toProblem } from "@/studio/lib/problem";
import { fromFileList, type Picked } from "@/studio/lib/uploads/walk";
import { useUploads } from "@/studio/stores/uploads";
import { hashFiles } from "@/studio/lib/uploads/hash";
import { dropsApi, newDropId } from "./api";
import { useDrops, type LocalDrop } from "./store";

/**
 * Starting a drop (todo13-drops), the one entry point every surface uses: the composer (drop,
 * paste, attach), Home and the Studio canvas (todo13-entry). Returns the drop id at once, so the
 * card and the message can show it before a byte moves; then, in the background: the kernel's
 * drop (`POST /drops`, the limits and the rate limit), and the bytes through the one uploader
 * (`stores/uploads.ts`: hashing, 64 MB chunks, offset resume) with `origin` and `dropId`.
 * More files before the message is sent join the same drop (`dropId`). Takes entry's
 * `DropRequest` (`app/entry/drop-adapter.ts`) as is: `picked`, `origin`, `conversationId?`,
 * `taskId?`, `targetNodeId?`, `onRegistered?`, `onChanged?`.
 */
export interface StartDropOptions {
  projectId: string;
  origin: DropOriginKind;
  /** The files (or, as entry's `DropRequest` names them, `picked`). */
  files?: Picked | File[];
  picked?: Picked;
  /** A folder of the drive to land in (Files); chat drops land in `Shared in chat`. */
  targetNodeId?: string;
  /** Accepted for `DropRequest` compatibility; the adapter keeps the timeline. */
  surface?: string;
  timelineStarted?: boolean;
  onRegistered?: (items: SeedAsset[]) => void;
  onChanged?: (projectId: string) => void;
  conversationId?: string;
  /** Names the conversation's `Shared in chat` folder. */
  conversationTitle?: string;
  messageId?: string;
  /** A drop into a Studio: images become its items as they arrive (todo11 D8). */
  taskId?: string;
  /** Add these files to a drop already started (more files before send, or a resume). */
  dropId?: string;
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const created = new Map<string, Promise<boolean>>();

/** Pasted screenshots all arrive as `image.png`: give each a distinct name. */
export function pastedFiles(list: FileList | File[]): File[] {
  const at = new Date();
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}.${String(at.getMinutes()).padStart(2, "0")}.${String(at.getSeconds()).padStart(2, "0")}`;
  return [...list].map((f, i) => {
    if (f.name && f.name !== "image.png" && f.name !== "image.jpg") return f;
    const ext = f.type === "image/jpeg" ? "jpg" : (f.type.split("/")[1] ?? "png");
    return new File([f], `Screenshot ${stamp}${i ? ` (${i + 1})` : ""}.${ext}`, { type: f.type, lastModified: f.lastModified });
  });
}

export function startDrop(o: StartDropOptions): string {
  const given = o.picked ?? o.files ?? { files: [], skipped: 0 };
  const picked: Picked = Array.isArray(given) ? fromFileList(given) : given;
  const id = o.dropId ?? newDropId();
  const files = picked.files.map((f) => ({ relPath: f.relPath, size: f.file.size, ...(IMAGE.test(f.relPath) && f.file.size < 50 * 1024 * 1024 ? { preview: URL.createObjectURL(f.file) } : {}) }));
  const store = useDrops.getState();
  const joining = !!store.drops[id];
  if (store.drops[id]) store.patch(id, (d) => ({ files: [...d.files.filter((x) => !files.some((f) => f.relPath === x.relPath)), ...files], error: undefined, overLimit: undefined, restored: undefined }));
  else store.put({ id, projectId: o.projectId, origin: o.origin, conversationId: o.conversationId, taskId: o.taskId, files, uploadKeys: [], createdAt: Date.now() });
  void run(id, o, picked, joining);
  return id;
}

/** Drops bigger than this send their first images ahead, as their own session. */
export const SPLIT_ABOVE = 48;
export const FIRST_FILES = 12;

/**
 * A big drop's first part (todo13 M4 item 2): its first few images, in the order dropped, go
 * up as their own import session with `priority: "first"`, so they're inspected and the fast
 * path opens a Studio while the rest uploads. Only plain images (a DICOM series stays whole).
 */
export function splitFirst(picked: Picked): [Picked, Picked] | null {
  if (picked.files.length <= SPLIT_ABOVE) return null;
  const first = picked.files.filter((f) => IMAGE.test(f.relPath)).slice(0, FIRST_FILES);
  if (first.length < 4) return null;
  const head = new Set(first);
  return [
    { files: first, skipped: 0 },
    { files: picked.files.filter((f) => !head.has(f)), skipped: picked.skipped },
  ];
}

async function run(id: string, o: StartDropOptions, picked: Picked, joining: boolean) {
  const ok = await ensureCreated(id, o, picked);
  if (!ok || !picked.files.length) return;
  const origin = { kind: o.origin, ...(o.conversationId ? { conversationId: o.conversationId } : {}), ...(o.messageId ? { messageId: o.messageId } : {}), ...(o.conversationTitle ? { conversationTitle: o.conversationTitle } : {}) };
  // Files added to a drop already under way (more before send, a resume) go as they are.
  const parts = joining ? null : splitFirst(picked);
  if (parts) {
    // The first files' bytes go up first; the rest start once those are in (not inspected).
    const head = send(id, o, parts[0], { ...origin, priority: "first" as const });
    if ((await uploaded(id)) === "cancelled") return;
    await Promise.all([head, send(id, o, parts[1], origin)]);
    return;
  }
  await send(id, o, picked, origin);
}

/** Resolves when the drop's (only) session has its bytes in: checking, done, failed or cancelled. */
function uploaded(dropId: string): Promise<string> {
  const phase = () => {
    const x = useUploads.getState().sessions.find((x) => x.dropId === dropId);
    // `failed` without an error is the moment between registering and uploading (`absorb`).
    return x?.phase === "failed" && !x.error ? "uploading" : x?.phase;
  };
  const over = (p: string | undefined) => p === "checking" || p === "done" || p === "failed" || p === "cancelled";
  if (over(phase())) return Promise.resolve(phase()!);
  return new Promise((resolve) => {
    const stop = useUploads.subscribe(() => {
      const p = phase();
      if (over(p)) {
        stop();
        resolve(p!);
      }
    });
  });
}

async function send(id: string, o: StartDropOptions, picked: Picked, origin: DropOrigin) {
  const session = await useUploads.getState().add(o.projectId, picked, {
    taskId: o.taskId,
    targetNodeId: o.targetNodeId,
    onRegistered: o.onRegistered,
    onChanged: o.onChanged,
    drop: { dropId: id, origin },
    // A drop shared in a conversation (the composer's, or Home's delivered into the new
    // project's chat) shows its progress on its card; other surfaces keep the tray, which
    // would otherwise sit over the drawer's composer.
    quiet: o.origin === "chat" || (o.origin === "home" && !!o.conversationId),
    onStarted: (key) => useDrops.getState().patch(id, (d) => ({ uploadKeys: [...d.uploadKeys, key] })),
  });
  if (session?.phase === "failed" && session.error) useDrops.getState().patch(id, { error: session.error, overLimit: /at most|limit/i.test(session.error) });
  return session;
}

function ensureCreated(id: string, o: StartDropOptions, picked: Picked): Promise<boolean> {
  let p = created.get(id);
  if (!p) {
    const bytes = picked.files.reduce((n, f) => n + f.file.size, 0);
    p = dropsApi
      .create(o.projectId, { id, origin: o.origin, conversationId: o.conversationId, conversationTitle: o.conversationTitle, messageId: o.messageId, taskId: o.taskId, files: picked.files.length, bytes })
      .then(() => true)
      .catch((e) => {
        const status = e instanceof ApiError ? e.status : 0;
        const problem = toProblem(e);
        const retryAt = problem.kind === "rate-limited" && problem.retryAfter ? Date.now() + problem.retryAfter * 1000 : undefined;
        useDrops.getState().patch(id, { error: retryAt ? "Too many drops at once" : e instanceof Error ? e.message : String(e), overLimit: status === 413, retryAt });
        created.delete(id);
        return false;
      });
    created.set(id, p);
  }
  return p;
}

/**
 * Resolves when the kernel knows every file of the drop (its import sessions exist), so the agent
 * reads a complete summary; or after `timeoutMs`, or when the drop failed.
 */
export function whenRegistered(dropId: string, timeoutMs = 20_000): Promise<void> {
  const done = () => {
    const d = useDrops.getState().drops[dropId];
    if (!d || d.error) return true;
    const trays = useUploads.getState().sessions.filter((s) => s.dropId === dropId);
    return trays.length > 0 && trays.every((s) => !!s.importId || s.phase === "failed" || s.phase === "cancelled");
  };
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = () => {
      un1();
      un2();
      clearTimeout(t);
      resolve();
    };
    const check = () => done() && stop();
    const un1 = useUploads.subscribe(check);
    const un2 = useDrops.subscribe(check);
    const t = setTimeout(stop, timeoutMs);
  });
}

/**
 * Which picked files continue the drop: same path and size, and, when the server knows the
 * file's SHA-256, the same bytes (todo18: a different file of the same size starts fresh
 * instead of failing at the end as "damaged"). `shaOf` gives the picked file's hash.
 */
export function splitResume<F extends { relPath: string; file: File }>(drop: Pick<LocalDrop, "files">, picked: F[], serverSha: Map<string, string>, shaOf: Map<F, string> = new Map()): { same: F[]; other: F[] } {
  const known = new Set(drop.files.map((f) => `${f.relPath}\u0000${f.size}`));
  const same: F[] = [];
  const other: F[] = [];
  for (const f of picked) {
    const want = serverSha.get(f.relPath);
    const ok = known.has(`${f.relPath}\u0000${f.file.size}`) && (!want || !shaOf.has(f) || shaOf.get(f) === want);
    (ok ? same : other).push(f);
  }
  return { same, other };
}

/** The server's hashes of a drop's files, by path (from its tray sessions). */
function serverShas(dropId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of useUploads.getState().sessions) if (s.dropId === dropId) for (const f of s.files) if (f.sha256) out.set(f.relPath, f.sha256);
  return out;
}

/** "Upload paused" after a reload: the same files resume from the server's offset; others start a new drop. */
export async function resumeDrop(drop: LocalDrop, files: Picked | File[], extra: Partial<StartDropOptions> = {}): Promise<string[]> {
  const picked: Picked = Array.isArray(files) ? fromFileList(files) : files;
  const server = serverShas(drop.id);
  const check = picked.files.filter((f) => server.has(f.relPath));
  const shas = check.length ? await hashFiles(check.map((f) => f.file), () => {}).catch(() => null) : null;
  const { same, other } = splitResume(drop, picked.files, server, new Map(shas ? check.map((f, i) => [f, shas[i]]) : []));
  const base = { projectId: drop.projectId, origin: drop.origin, conversationId: drop.conversationId, taskId: drop.taskId, ...extra };
  const ids: string[] = [];
  if (same.length) ids.push(startDrop({ ...base, files: { files: same, skipped: 0 }, dropId: drop.id }));
  if (other.length) ids.push(startDrop({ ...base, files: { files: other, skipped: 0 } }));
  return ids;
}

/** "Dismiss" on an interrupted drop: stop what's left, forget it here and hide its card. */
export async function dismissDrop(dropId: string): Promise<void> {
  useDrops.getState().dismiss(dropId);
  await cancelDrop(dropId);
}

/** Discard a drop before its message is sent: its uploads stop; files already in stay in Files. */
export async function cancelDrop(dropId: string): Promise<void> {
  const d = useDrops.getState().drops[dropId];
  const uploads = useUploads.getState();
  await Promise.all((d?.uploadKeys ?? []).map((k) => uploads.cancel(k).catch(() => undefined)));
  for (const k of d?.uploadKeys ?? []) uploads.dismiss(k);
  created.delete(dropId);
  useDrops.getState().forget(dropId);
}

export { fromFileList };
