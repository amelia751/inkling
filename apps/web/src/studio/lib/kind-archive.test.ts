import { describe, expect, it } from "vitest";
import type { Annotation, StudioItem } from "@studio/contracts/types";
import { buildKindArchive } from "./kind-archive";

const X = "studio.core.image2d";
const E = "studio.ecg.record";
const item = (id: string, dataKind?: string) => ({ id, name: id, group: "", assets: [], dataKind }) as StudioItem;
const ann = (itemId: string) => ({ id: `a-${itemId}`, itemId }) as Annotation;

describe("buildKindArchive (todo19 D8)", () => {
  it("writes a folder per kind, runs each kind's exporters over its own items only, and a manifest", async () => {
    const calls: string[] = [];
    const { bytes, manifest } = await buildKindArchive(
      { [X]: ["coco"], [E]: ["wfdb", "nope"], "studio.empty": ["coco"] },
      [item("x1", X), item("x2"), item("e1", E)],
      [ann("x1"), ann("e1")],
      async (id, items, anns) => {
        calls.push(`${id}:${items.map((i) => i.id).join(",")}:${anns.length}`);
        return id === "nope" ? null : { filename: `${id}.json`, data: new TextEncoder().encode("{}") };
      },
      { fallbackKind: X, now: new Date(0) },
    );
    expect(calls).toEqual(["coco:x1,x2:1", "wfdb:e1:1", "nope:e1:1"]);
    expect(manifest.kinds).toEqual([
      { kind: X, folder: "image2d", items: 2, annotations: 1, files: [{ exporter: "coco", path: "image2d/coco.json" }] },
      { kind: E, folder: "record", items: 1, annotations: 1, files: [{ exporter: "wfdb", path: "record/wfdb.json" }] },
    ]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("image2d/coco.json");
    expect(text).toContain("record/wfdb.json");
    expect(text).toContain("manifest.json");
  });
});
