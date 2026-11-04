import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment } from "@/extension-host/resolve";
import type { Annotation } from "@studio/contracts/types";
import { disagreements, formatRows, labeledCsv, parseCsv, rowsOf } from "./table";

const ann = (id: string, label: string, rows: number[], itemId = "t.csv"): Annotation => ({
  id, itemId, label, geometry: { type: "class" }, attributes: { rows: formatRows(rows) }, provenance: "human-created", author: "x", createdAt: "t",
});

describe("table plugin", () => {
  it("parses RFC 4180 CSV", () => {
    const t = parseCsv('a,b\r\n1,"x, y"\n2,"say ""hi"""\n');
    expect(t.columns).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["1", "x, y"], ["2", 'say "hi"']]);
    expect(parseCsv("a\tb\n1\t2", "\t").rows).toEqual([["1", "2"]]);
  });

  it("stores rows as sorted, unique indices", () => {
    expect(formatRows([3, 1, 3])).toBe("1,3");
    expect(rowsOf(ann("a", "ok", [2, 0]))).toEqual([0, 2]);
  });

  it("finds rows labelled two ways", () => {
    const d = disagreements([ann("a", "ok", [0, 1]), ann("b", "wrong", [1]), ann("c", "ok", [2])]);
    expect(d).toEqual([{ itemId: "t.csv", row: 1, labels: ["ok", "wrong"], annotationIds: ["a", "b"] }]);
  });

  it("joins labels into the CSV export", () => {
    const table = parseCsv("a,b\n1,2\n3,4\n");
    const out = labeledCsv([{ id: "t.csv", table }], [ann("a", "ok", [1])]);
    expect(out).toBe("file,a,b,label\nt.csv,1,2,\nt.csv,3,4,ok\n");
    expect(labeledCsv([{ id: "t.parquet", table: null }], [ann("a", "ok", [4], "t.parquet")])).toBe("file,row,label\nt.parquet,4,ok\n");
  });

  it("boots the table-review preset with the grid", () => {
    const r = resolveEnvironment({ extends: "preset:table-review" }, registry);
    expect(r.errors).toBeUndefined();
    expect(r.env!.viewports[0].renderer.id).toBe("studio.table.renderers.grid");
    expect(r.env!.reviewRules.map((x) => x.id)).toContain("studio.table.reviewRules.row-label-disagreement");
  });
});
