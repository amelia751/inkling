/**
 * What a Studio item is called (todo19 P0-3). A converted or uploaded file's `path` is a
 * storage key (`sources/prj-…/<sha256>.svs`); the person knows it by its original `name`.
 * Every plugin's `groupItems` names items with `assetName`, never with `a.path` directly.
 */
import type { SeedAsset } from "@studio/contracts/types";

const HASH = /[0-9a-f]{64}/i;
const basename = (p: string) => p.split("/").pop() ?? p;

/** True when `s` is (part of) a storage key rather than a name a person gave a file. */
export function isStorageKey(s: string): boolean {
  return s.includes("sources/") || HASH.test(s);
}

/**
 * The display name of an asset: `preferred` candidates first (e.g. a WFDB `record`), then
 * `a.name`, `a.record`, `a.slide`, then the basename of `a.path`, skipping anything that is a
 * storage key. Falls back to the short hash of a storage key when nothing else is left.
 */
export function assetName(a: Pick<SeedAsset, "path"> & Partial<Pick<SeedAsset, "name" | "record" | "slide">>, ...preferred: (string | null | undefined)[]): string {
  for (const c of [...preferred, a.name, a.record, a.slide, basename(a.path)]) {
    if (c && !isStorageKey(c)) return c;
  }
  return basename(a.path).replace(HASH, (h) => h.slice(0, 8));
}
