/// <reference lib="webworker" />
import { createSHA256 } from "hash-wasm";

/**
 * SHA-256 of files, streamed in 8 MB slices so a 2 GB scan never sits in memory (todo6 D7).
 * Messages in: `{ id, files: File[] }`; out: `{ id, index, sha256 }` per file, then `{ id, done }`.
 */
const SLICE = 8 * 1024 * 1024;

self.onmessage = async (e: MessageEvent<{ id: number; files: File[] }>) => {
  const { id, files } = e.data;
  const hasher = await createSHA256();
  for (let index = 0; index < files.length; index++) {
    const f = files[index];
    hasher.init();
    for (let off = 0; off < f.size; off += SLICE) hasher.update(new Uint8Array(await f.slice(off, off + SLICE).arrayBuffer()));
    self.postMessage({ id, index, sha256: hasher.digest("hex") });
  }
  self.postMessage({ id, done: true });
};
