import type { Annotation, StudioItem } from "@studio/contracts/types";
import { kindFolder } from "./per-kind";
import { zipStore } from "./zip";

/** One exporter run for one kind's items: the file it writes. */
export type RunExporter = (id: string, items: StudioItem[], annotations: Annotation[]) => Promise<{ filename: string; data: Uint8Array } | null>;

export interface KindArchiveManifest {
  version: 1;
  exportedAt: string;
  kinds: { kind: string; folder: string; items: number; annotations: number; files: { exporter: string; path: string }[] }[];
}

/**
 * todo19 D8: one Export writes one archive with a folder per kind and a `manifest.json`.
 * Each kind runs its own exporters over its own items (never mixed); a kind with no items
 * is left out. An exporter that returns null (not available for this data) is skipped.
 */
export async function buildKindArchive(
  byKind: Record<string, string[]>,
  items: StudioItem[],
  annotations: Annotation[],
  run: RunExporter,
  opts: { fallbackKind?: string; now?: Date } = {},
): Promise<{ bytes: Uint8Array; manifest: KindArchiveManifest }> {
  const entries: { path: string; data: Uint8Array }[] = [];
  const manifest: KindArchiveManifest = { version: 1, exportedAt: (opts.now ?? new Date()).toISOString(), kinds: [] };
  const used = new Set<string>();
  for (const [kind, ids] of Object.entries(byKind)) {
    const mine = items.filter((i) => (i.dataKind ?? opts.fallbackKind) === kind);
    if (!mine.length) continue;
    const idSet = new Set(mine.map((i) => i.id));
    const scoped = annotations.filter((a) => idSet.has(a.itemId));
    let folder = kindFolder(kind);
    for (let n = 2; used.has(folder); n++) folder = `${kindFolder(kind)}-${n}`;
    used.add(folder);
    const files: { exporter: string; path: string }[] = [];
    for (const id of ids) {
      const out = await run(id, mine, scoped);
      if (!out) continue;
      const path = `${folder}/${out.filename}`;
      entries.push({ path, data: out.data });
      files.push({ exporter: id, path });
    }
    manifest.kinds.push({ kind, folder, items: mine.length, annotations: scoped.length, files });
  }
  entries.push({ path: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return { bytes: zipStore(entries), manifest };
}
