import type OpenSeadragon from "openseadragon";
import type { Pt } from "@/types";
import type { Region } from "@/kits/overlay2d/regions";
import { runWandJob, type Adjustments, type WandJob } from "./wandCore";
import type { Transform2D } from "@/kits/overlay2d/transform";
import type { ToolContext, ToolMachine } from "@/kits/overlay2d/tools";

export { NEUTRAL_ADJUST, type Adjustments } from "./wandCore";

/** Half-size of the analysed window, in pyramid-level pixels (≈ screen px). */
const WINDOW_RADIUS = 1024;

const tileCache = new Map<string, Promise<HTMLImageElement>>();

function loadTile(url: string): Promise<HTMLImageElement> {
  let p = tileCache.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`tile ${url}`));
      img.src = url;
    });
    tileCache.set(url, p);
    if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value!);
  }
  return p;
}

/**
 * Magic wand (QuPath / ImageScope style): grow a 4-connected region of similar colour from
 * the click, on the pyramid level that matches the current zoom, then trace its boundary.
 *
 * Pixels come from the DZI tiles themselves (re-fetched; normally browser-cached) rather
 * than OSD's drawer, because the default WebGL drawer has no readable back buffer. The
 * on-screen image adjustments are re-applied so the wand sees what the expert sees.
 */
export async function wandRegion(viewer: OpenSeadragon.Viewer, view: Transform2D, click: Pt, tolerance: number, adj: Adjustments): Promise<Region> {
  const item = viewer.world.getItemAt(0);
  if (!item) return [];
  const src = item.source;
  const maxLevel = src.maxLevel;
  const level = Math.max(src.minLevel ?? 0, Math.min(maxLevel, maxLevel + Math.ceil(Math.log2(Math.max(1e-6, view.scale)))));
  const ls = src.getLevelScale(level);
  const levelW = Math.ceil(src.dimensions.x * ls), levelH = Math.ceil(src.dimensions.y * ls);
  const cx = Math.floor(click[0] * ls), cy = Math.floor(click[1] * ls);
  if (cx < 0 || cy < 0 || cx >= levelW || cy >= levelH) return [];
  // Analyse the visible area around the click (capped), so results match what is on screen.
  const [vx0, vy0, vx1, vy1] = view.visibleImageBounds(0);
  const wx0 = Math.max(0, Math.floor(vx0 * ls), cx - WINDOW_RADIUS);
  const wy0 = Math.max(0, Math.floor(vy0 * ls), cy - WINDOW_RADIUS);
  const wx1 = Math.min(levelW, Math.ceil(vx1 * ls), cx + WINDOW_RADIUS);
  const wy1 = Math.min(levelH, Math.ceil(vy1 * ls), cy + WINDOW_RADIUS);
  const w = wx1 - wx0, h = wy1 - wy0;
  if (w < 3 || h < 3) return [];

  const ts = src.getTileWidth(level);
  const ov = src.tileOverlap ?? 0;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const jobs: Promise<void>[] = [];
  for (let ty = Math.floor(wy0 / ts); ty <= Math.floor((wy1 - 1) / ts); ty++) {
    for (let tx = Math.floor(wx0 / ts); tx <= Math.floor((wx1 - 1) / ts); tx++) {
      const url = src.getTileUrl(level, tx, ty);
      if (typeof url !== "string") continue;
      const ox = tx * ts - (tx > 0 ? ov : 0), oy = ty * ts - (ty > 0 ? ov : 0);
      jobs.push(loadTile(url).then((img) => ctx.drawImage(img, ox - wx0, oy - wy0)).catch(() => undefined));
    }
  }
  await Promise.all(jobs);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  return runInWorker({ rgba, w, h, sx: cx - wx0, sy: cy - wy0, tolerance, adj, ox: wx0 / ls, oy: wy0 / ls, k: ls });
}

// ---- Worker plumbing: flood fill + tracing run off the main thread ----

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (r: Region) => void; reject: (e: unknown) => void }>();
/** "worker" or "inline" — which path the last wand ran on (tests assert this). */
export let lastWandRunner: "worker" | "inline" | null = null;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./wand.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; region?: Region; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.region!);
    };
    worker.onerror = (e) => {
      console.warn("[wsi] wand worker failed; falling back to the main thread", e.message);
      for (const p of pending.values()) p.reject(new Error("wand worker crashed"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

async function runInWorker(job: WandJob): Promise<Region> {
  const w = getWorker();
  if (w) {
    try {
      const region = await new Promise<Region>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        w.postMessage({ id, job }, [job.rgba.buffer]);
      });
      lastWandRunner = "worker";
      return region;
    } catch (err) {
      console.warn("[wsi] wand worker error", err);
      // The buffer was transferred; the caller retries on the next click.
      return [];
    }
  }
  lastWandRunner = "inline";
  return runWandJob(job);
}


/**
 * `inkling.wsi.tools.wand` as an overlay2d tool machine: a click grows a region (async, on
 * tile pixels the host fetches); Shift adds it to the selected region, Alt subtracts.
 */
export function wandTool(run: (p: Pt, shift: boolean, alt: boolean, ctx: ToolContext) => Promise<void>): ToolMachine {
  return {
    needsLabel: true,
    cursor: "crosshair",
    down(e, ctx) {
      if (!ctx.busy) void run(e.p, e.shift, e.alt, ctx);
      return "consume";
    },
    cancel() {},
    draft: () => null,
  };
}
