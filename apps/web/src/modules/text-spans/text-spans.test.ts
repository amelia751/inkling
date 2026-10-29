import { describe, expect, it } from "vitest";
import "@/bundle";
import { registry } from "@/platform/registry";
import { resolveEnvironment } from "@/platform/resolve";
import { describeGeometry } from "@/platform/describe";
import type { Annotation } from "@/types";
import { SPAN } from "./manifest";
import { segments, snap, spanGeometry, toJsonl } from "./spans";

const TEXT = "Ada Lovelace worked with Charles Babbage in London.";
const ann = (id: string, start: number, end: number, label: string): Annotation => ({
  id, itemId: "doc", label, geometry: spanGeometry(TEXT, start, end) as never, provenance: "human-created", author: "x", createdAt: "t",
});

describe("text-spans", () => {
  it("segments text at span boundaries, innermost span last", () => {
    const s = segments(TEXT.length, [{ id: "a", start: 0, end: 12 }, { id: "b", start: 4, end: 12 }]);
    expect(s.map((x) => [x.start, x.end, x.ids])).toEqual([[0, 4, ["a"]], [4, 12, ["a", "b"]], [12, TEXT.length, []]]);
  });
  it("snaps selections to non-whitespace and rejects empty ones", () => {
    expect(snap(TEXT, 24, 33)).toEqual({ start: 25, end: 32 });
    expect(snap(TEXT, 12, 13)).toBeNull();
  });
  it("exports spaCy/doccano JSONL sorted by position", () => {
    const out = toJsonl([{ id: "doc", text: TEXT }], [ann("2", 45, 51, "LOC"), ann("1", 0, 12, "PER")]);
    expect(JSON.parse(out)).toEqual({ id: "doc", text: TEXT, spans: [[0, 12, "PER"], [45, 51, "LOC"]] });
  });
  it("boots preset:ner from the module alone and describes its geometry", () => {
    const r = resolveEnvironment({ extends: "preset:ner" }, registry);
    expect(r.errors).toBeUndefined();
    expect(r.env!.viewports[0].renderer.space).toBe("text");
    expect(r.env!.tools.map((t) => t.name)).toEqual(["select", "entity"]);
    expect(registry.geometry(SPAN)?.module).toBe("inkling.text-spans");
    expect(describeGeometry(ann("1", 0, 12, "PER"), r.env)).toBe("“Ada Lovelace” · chars 0–12");
  });
});
