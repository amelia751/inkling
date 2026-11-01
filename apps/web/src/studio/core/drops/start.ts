import type { DropOriginKind } from "@studio/contracts/drops";
import { ApiError } from "@/studio/lib/projects-api";
import { fromFileList, type Picked } from "@/studio/lib/uploads/walk";
import { useUploads } from "@/studio/stores/uploads";
import { dropsApi, newDropId } from "./api";
import { useDrops, type LocalDrop } from "./store";

/**
 * Starting a drop (todo13-drops), the one entry point every surface uses: the composer (drop,
 * paste, attach), Home and the Studio canvas (todo13-entry). Returns the drop id at once, so the
 * card and the message can show it before a byte moves; then, in the background: the kernel's
 * drop (`POST /drops`, the limits and the rate limit), and the bytes through the one uploader
 * (`stores/uploads.ts`: hashing, 64 MB chunks, offset resume) with `origin` and `dropId`.
 * More files before the message is sent join the same drop (`dropId`).
 */
export interface StartDropOptions {
  projectId: string;
  origin: DropOriginKind;
  files: Picked | File[];
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
  const picked: Picked = Array.isArray(o.files) ? fromFileList(o.files) : o.files;
  const id = o.dropId ?? newDropId();
  const files = picked.files.map((f) => ({ relPath: f.relPath, size: f.file.size, ...(IMAGE.test(f.relPath) && f.file.size < 50 * 1024 * 1024 ? { preview: URL.createObjectURL(f.file) } : {}) }));
  const store = useDrops.getState();
  if (store.drops[id]) store.patch(id, (d) => ({ files: [...d.files.filter((x) => !files.some((f) => f.relPath === x.relPath)), ...files], error: undefined, overLimit: undefined }));
  else store.put({ id, projectId: o.projectId, origin: o.origin, conversationId: o.conversationId, taskId: o.taskId, files, uploadKeys: [], createdAt: Date.now() });
  void run(id, o, picked);
  return id;
}

async function run(id: string, o: StartDropOptions, picked: Picked) {
  const ok = await ensureCreated(id, o, picked);
  if (!ok || !picked.files.length) return;
  const origin = { kind: o.origin, ...(o.conversationId ? { conversationId: o.conversationId } : {}), ...(o.messageId ? { messageId: o.messageId } : {}), ...(o.conversationTitle ? { conversationTitle: o.conversationTitle } : {}) };
  const session = await useUploads.getState().add(o.projectId, picked, {
    taskId: o.taskId,
    drop: { dropId: id, origin },
    onStarted: (key) => useDrops.getState().patch(id, (d) => ({ uploadKeys: [...d.uploadKeys, key] })),
  });
  if (session?.phase === "failed" && session.error) useDrops.getState().patch(id, { error: session.error, overLimit: /at most|limit/i.test(session.error) });
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
        useDrops.getState().patch(id, { error: e instanceof Error ? e.message : String(e), overLimit: status === 413 });
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

/** "Upload paused" after a reload: the same files resume from the server's offset; others start a new drop. */
export function resumeDrop(drop: LocalDrop, files: Picked | File[], extra: Partial<StartDropOptions> = {}): string[] {
  const picked: Picked = Array.isArray(files) ? fromFileList(files) : files;
  const known = new Set(drop.files.map((f) => `${f.relPath}\u0000${f.size}`));
  const same = picked.files.filter((f) => known.has(`${f.relPath}\u0000${f.file.size}`));
  const other = picked.files.filter((f) => !known.has(`${f.relPath}\u0000${f.file.size}`));
  const base = { projectId: drop.projectId, origin: drop.origin, conversationId: drop.conversationId, taskId: drop.taskId, ...extra };
  const ids: string[] = [];
  if (same.length) ids.push(startDrop({ ...base, files: { files: same, skipped: 0 }, dropId: drop.id }));
  if (other.length) ids.push(startDrop({ ...base, files: { files: other, skipped: 0 } }));
  return ids;
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
