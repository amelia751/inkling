/**
 * Dev-only self-check for the bulk overlay: builds the spatial index over synthetic objects
 * (never written to the store) and times queries, hit tests and — in a browser — full
 * frames. In the dev console: `__pathology.selfCheck()` (see PathologyViewer).
 */
import type { Annotation, Pt } from "@/types";
import { drawScene, Scene, type DrawStats } from "@/kits/overlay2d/scene";
import type { View } from "@/kits/overlay2d/transform";

const LABELS = ["tumor", "stroma", "necrosis", "lymphocytes"];

/** Deterministic PRNG so runs are comparable. */
function rng(seed = 1) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function syntheticAnnotations(marks: number, regions: number, width: number, height: number, itemId = "synthetic"): Annotation[] {
  const r = rng(42);
  const out: Annotation[] = [];
  const base = { itemId, provenance: "human-created" as const, author: "perf", createdAt: "" };
  // Marks cluster like cells: 200 blobs over the tissue.
  const centers = Array.from({ length: 200 }, () => [r() * width, r() * height] as Pt);
  for (let i = 0; i < marks; i++) {
    const [cx, cy] = centers[i % centers.length];
    out.push({ ...base, id: `m${i}`, label: LABELS[i % 4], geometry: { type: "mark", x: cx + (r() - 0.5) * 3000, y: cy + (r() - 0.5) * 3000 } });
  }
  for (let i = 0; i < regions; i++) {
    const cx = r() * width, cy = r() * height, rad = 200 + r() * 3000, n = 64 + Math.floor(r() * 400);
    const pts: Pt[] = Array.from({ length: n }, (_, k) => {
      const a = (k / n) * Math.PI * 2, j = 1 + (r() - 0.5) * 0.3;
      return [cx + Math.cos(a) * rad * j, cy + Math.sin(a) * rad * j];
    });
    out.push({ ...base, id: `r${i}`, label: LABELS[i % 4], geometry: { type: "polygon", points: pts } });
  }
  return out;
}

export interface IndexBench {
  objects: number;
  buildMs: number;
  /** Mean ms per viewport query, for three window sizes (whole slide, 1/16, 1/256). */
  queryMs: number[];
  queryHits: number[];
  hitTestMs: number;
  /** Incremental index updates (ms, mode): append one mark, replace one object, delete one. */
  appendMs: number;
  replaceMs: number;
  removeMs: number;
  modes: string[];
  /** Same list rebuilt from scratch, for comparison. */
  fullRebuildMs: number;
}

export function benchIndex(list: Annotation[], width: number, height: number): IndexBench {
  const scene = new Scene();
  const t0 = performance.now();
  scene.build(list);
  const buildMs = performance.now() - t0;
  const r = rng(7);
  const queryMs: number[] = [], queryHits: number[] = [];
  for (const frac of [1, 1 / 4, 1 / 16]) {
    const w = width * frac, h = height * frac;
    let hits = 0;
    const t = performance.now();
    for (let k = 0; k < 200; k++) {
      const x = r() * (width - w), y = r() * (height - h);
      hits += scene.search(x, y, x + w, y + h).length;
    }
    queryMs.push((performance.now() - t) / 200);
    queryHits.push(Math.round(hits / 200));
  }
  const t1 = performance.now();
  for (let k = 0; k < 1000; k++) scene.hitTest([r() * width, r() * height], 20);
  const hitTestMs = (performance.now() - t1) / 1000;
  const modes: string[] = [];
  const step = (next: Annotation[]) => {
    scene.build(next);
    modes.push(scene.lastBuild.mode);
    return scene.lastBuild.ms;
  };
  let cur = list;
  const mark = (i: number): Annotation => ({ id: `n${i}`, itemId: "synthetic", label: "tumor", provenance: "human-created", author: "perf", createdAt: "", geometry: { type: "mark", x: r() * width, y: r() * height } });
  let appendMs = 0, replaceMs = 0, removeMs = 0;
  for (let k = 0; k < 20; k++) appendMs += step((cur = [...cur, mark(k)]));
  for (let k = 0; k < 20; k++) {
    const at = Math.floor(r() * cur.length);
    replaceMs += step((cur = cur.map((a, i) => (i === at ? { ...a } : a))));
  }
  for (let k = 0; k < 20; k++) {
    const at = Math.floor(r() * cur.length);
    removeMs += step((cur = cur.filter((_, i) => i !== at)));
  }
  const fresh = new Scene();
  const t2 = performance.now();
  fresh.build(cur);
  const fullRebuildMs = performance.now() - t2;
  // The patched index must answer exactly like a fresh one.
  const q = [width * 0.3, height * 0.3, width * 0.6, height * 0.6] as const;
  const ids = (sc: Scene) => sc.search(...q).map((i) => sc.entries[i].a.id).sort().join();
  if (ids(scene) !== ids(fresh)) throw new Error("incremental index diverged from a fresh build");
  return { objects: scene.size, buildMs, queryMs, queryHits, hitTestMs, appendMs: appendMs / 20, replaceMs: replaceMs / 20, removeMs: removeMs / 20, modes: [...new Set(modes)], fullRebuildMs };
}

/** Browser-only: time drawScene frames for the synthetic set at the controller's current view. */
export function benchFrames(list: Annotation[], view: View, frames = 30): { mean: number; max: number; stats: DrawStats } {
  const scene = new Scene();
  scene.build(list);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(view.width));
  canvas.height = Math.max(1, Math.round(view.height));
  const ctx = canvas.getContext("2d")!;
  const times: number[] = [];
  let stats!: DrawStats;
  for (let i = 0; i < frames; i++) {
    stats = drawScene(ctx, 1, view, scene, { labels: LABELS, opacity: 1, outlineOnly: false, showNames: false, skip: null, mpp: 0.25, formatLength: (px) => `${px.toFixed(0)} px` });
    times.push(stats.ms);
  }
  return { mean: times.reduce((s, t) => s + t, 0) / times.length, max: Math.max(...times), stats };
}
