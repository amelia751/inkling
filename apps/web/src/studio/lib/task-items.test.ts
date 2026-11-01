import { describe, expect, it } from "vitest";
import type { Project, SeedAsset } from "@studio/contracts/types";
import { applyItemEvent, isLoadable, mergeAssets } from "./task-items";
import { thumbHashAspect, thumbHashToRGBA } from "./thumbhash";

const doc = (assets: SeedAsset[]): Project => ({ id: "t", title: "T", environment: { extends: "preset:image-2d" }, source: "", license: "", status: "available", assets });
const reg = (path: string): SeedAsset => ({ path, sha256: "", bytes: 1, name: path, nodeId: `n-${path}`, ingest: { state: "registered" } });

describe("task items (todo11 D8)", () => {
  it("inserts registered items once, in order, keeping the furthest state", () => {
    let d = mergeAssets(doc([]), [reg("a"), reg("b")]);
    d = applyItemEvent(d, "item.thumb_ready", { itemId: "a", nodeId: "n-a", kind: "image", meta: { thumb: "sources/p/derived/x.webp", thumbhash: "AAAA" } }).doc;
    // The drop's own response arriving late doesn't send `a` back to registered.
    d = mergeAssets(d, [reg("a"), reg("c")]);
    expect(d.assets.map((a) => a.path)).toEqual(["a", "b", "c"]);
    expect(d.assets[0].ingest).toMatchObject({ state: "thumb_ready", thumb: "sources/p/derived/x.webp", thumbhash: "AAAA" });
  });

  it("applies events in place, ignores regressions, and reports items it doesn't know", () => {
    let d = doc([reg("a")]);
    d = applyItemEvent(d, "item.probed", { itemId: "a", nodeId: "n-a", kind: "image", meta: { width: 300, height: 150 } }).doc;
    expect(d.assets[0]).toMatchObject({ width: 300, height: 150, ingest: { state: "probed" } });
    expect(isLoadable(d.assets[0])).toBe(true);
    const back = applyItemEvent(d, "item.uploaded", { itemId: "a", nodeId: "n-a", kind: "image" });
    expect(back.doc.assets[0].ingest?.state).toBe("probed");
    expect(applyItemEvent(d, "item.ready", { itemId: "zzz", nodeId: "n", kind: "image" }).missed).toBe(true);
    const added = applyItemEvent(d, "item.registered", { itemId: "b", nodeId: "n-b", kind: "image", meta: { name: "b.png", bytes: 5, seq: 2 } });
    expect(added.doc.assets[1]).toMatchObject({ path: "b", name: "b.png", ingest: { state: "registered", seq: 2 } });
    expect(isLoadable(added.doc.assets[1])).toBe(false);
    expect(isLoadable({ path: "seed.png", sha256: "", bytes: 1 })).toBe(true);
  });

  it("decodes the worker's ThumbHash (studio_worker.inspect.thumbhash) back to its picture", () => {
    const b = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    // A 200×100 pure red image.
    const red = b("1fsDBIBMLk+IiIiDeHNbj7b1aA==");
    expect(thumbHashAspect(red)).toBeCloseTo(1.75, 2);
    const r = thumbHashToRGBA(red);
    expect([r.w, r.h]).toEqual([32, 18]);
    const mid = ((r.h >> 1) * r.w + (r.w >> 1)) * 4;
    expect(r.rgba[mid]).toBeGreaterThan(200);
    expect(r.rgba[mid + 1]).toBeLessThan(60);
    expect(r.rgba[mid + 2]).toBeLessThan(60);
    // A 100×200 image, white on top and blue below.
    const tb = thumbHashToRGBA(b("KgQepAB4+IiIiIWImIiHjwgAAA=="));
    expect(tb.h).toBe(32);
    expect(tb.w).toBeLessThan(32);
    const px = (y: number) => Array.from(tb.rgba.slice((y * tb.w + (tb.w >> 1)) * 4, (y * tb.w + (tb.w >> 1)) * 4 + 3));
    const [tr, tg] = px(2);
    const [br, bg, bb] = px(tb.h - 3);
    expect(tr).toBeGreaterThan(180);
    expect(tg).toBeGreaterThan(180);
    expect(bb).toBeGreaterThan(br + 80);
    expect(bb).toBeGreaterThan(bg + 80);
  });
});
