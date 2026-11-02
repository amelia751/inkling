/**
 * Contract (todo19 P0-3): every bundled data kind's `groupItems` names items by what the person
 * called the file, never by its storage key (`sources/prj-…/<sha256>.ext`).
 */
import { describe, expect, it } from "vitest";
import { MODULES } from "@/extension-host/bundled";
import type { Project, SeedAsset } from "@studio/contracts/types";

const hex = (seed: number) => Array.from({ length: 64 }, (_, i) => ((seed * 31 + i * 7) % 16).toString(16)).join("");
const key = (seed: number, ext: string) => `sources/prj-x/${hex(seed)}.${ext}`;
const asset = (seed: number, ext: string, name: string, extra: Partial<SeedAsset> = {}): SeedAsset => ({ path: key(seed, ext), sha256: hex(seed), bytes: 1, name, ...extra });

const ASSETS: SeedAsset[] = [
  asset(1, "svs", "TCGA-A6-5665.svs", { slide: key(1, "svs") }),
  asset(2, "avi", "colitis-29c2.avi"),
  asset(3, "txt", "note.txt"),
  asset(4, "png", "chest.png"),
  asset(5, "nii.gz", "patient101_4d.nii.gz", { frames: 30 }),
  asset(6, "hea", "100.hea"),
  asset(7, "dcm", "slice-001.dcm"),
];
const project = { id: "prj-x", name: "x", assets: ASSETS } as unknown as Project;
const BAD = /sources\/|[0-9a-f]{64}/i;

const kinds = MODULES.flatMap((m) => (m.contributes.dataKinds ?? []).filter((k) => k.groupItems).map((k) => [`${m.id} ${k.id}`, k.groupItems!] as const));

describe("item names never show storage keys", () => {
  it("covers the bundled data kinds", () => expect(kinds.length).toBeGreaterThan(3));
  it.each(kinds)("%s", (_id, groupItems) => {
    for (const item of groupItems(project)) {
      expect(item.name, item.id).not.toMatch(BAD);
      for (const p of item.parts ?? []) expect((p as { label?: string }).label ?? "", item.id).not.toMatch(BAD);
    }
  });
});
