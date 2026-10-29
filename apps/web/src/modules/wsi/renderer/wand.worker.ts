import { runWandJob, type WandJob } from "./wandCore";

/** Magic-wand flood fill + boundary tracing off the main thread. */
self.onmessage = (e: MessageEvent<{ id: number; job: WandJob }>) => {
  const { id, job } = e.data;
  try {
    const region = runWandJob(job);
    (self as unknown as Worker).postMessage({ id, region });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
