/** Hash files in a Web Worker, reporting progress per file (see hash.worker.ts). */
let seq = 0;

export function hashFiles(files: File[], onProgress: (done: number) => void, signal?: AbortSignal): Promise<string[]> {
  const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
  const id = ++seq;
  const out: string[] = new Array(files.length);
  let done = 0;
  return new Promise((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", stop, { once: true });
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "couldn't read a file"));
    };
    worker.onmessage = (e: MessageEvent<{ id: number; index?: number; sha256?: string; done?: boolean }>) => {
      if (e.data.id !== id) return;
      if (e.data.done) {
        signal?.removeEventListener("abort", stop);
        worker.terminate();
        resolve(out);
        return;
      }
      out[e.data.index!] = e.data.sha256!;
      onProgress(++done);
    };
    worker.postMessage({ id, files });
  });
}
