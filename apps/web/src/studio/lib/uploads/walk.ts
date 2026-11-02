/**
 * Turning a drop or a file picker into `(file, relative path)` pairs (todo6 Phase 4.4).
 *
 * A dropped folder is walked recursively with `webkitGetAsEntry()` (`dataTransfer.files`
 * flattens or drops folders), so `relPath` keeps the original structure. System clutter
 * (`.DS_Store`, `Thumbs.db`, `__MACOSX/`, `desktop.ini`, `._*`) is skipped and counted; the
 * kernel applies the same rule (kernel/kinds.py `is_junk`).
 */
export interface PickedFile {
  file: File;
  relPath: string;
}

export interface Picked {
  files: PickedFile[];
  skipped: number;
}

const JUNK_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const JUNK_DIRS = new Set(["__macosx", ".git"]);

export function isJunk(relPath: string): boolean {
  const parts = relPath.split("/").filter(Boolean).map((p) => p.toLowerCase());
  const name = parts.at(-1) ?? "";
  return JUNK_NAMES.has(name) || name.startsWith("._") || parts.slice(0, -1).some((p) => JUNK_DIRS.has(p));
}

function keep(files: PickedFile[]): Picked {
  const kept = files.filter((f) => !isJunk(f.relPath));
  return { files: kept, skipped: files.length - kept.length };
}

/** `<input type=file multiple>` or `<input webkitdirectory>` (which sets `webkitRelativePath`). */
export function fromFileList(list: FileList | File[]): Picked {
  return keep([...list].map((file) => ({ file, relPath: file.webkitRelativePath || file.name })));
}

/** Whether a drag carries files at all (not text or a link). */
export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && [...dt.types].includes("Files");
}

/** A drop: folders walked recursively, in the order the browser gives them. */
export async function fromDataTransfer(dt: DataTransfer): Promise<Picked> {
  const entries = [...dt.items].map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null));
  if (!entries.some((e) => e?.isDirectory)) return fromFileList(dt.files);
  const out: PickedFile[] = [];
  for (const entry of entries) if (entry) await walk(entry, "", out);
  return keep(out);
}

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ file, relPath: path });
    return;
  }
  // `__MACOSX/` is walked too, so its files count as skipped in the summary.
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries returns at most ~100 entries per call: read until it returns none.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await walk(child, path, out);
  }
}
