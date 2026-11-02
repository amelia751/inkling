import { describe, expect, it } from "vitest";
import { findingLine, groupFindings, renamedExample, violationsText } from "./findings";

describe("findings grouped by rule (todo20 D8)", () => {
  it("groups 35 identical findings into one line with a count", () => {
    const list = Array.from({ length: 35 }, (_, i) => ({ rule: "name.pattern", severity: "error", message: "The file name does not match the project's pattern.", file: `scan ${i}.png` }));
    const groups = groupFindings(list, { refused: true });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ rule: "name.pattern", outcome: "refused", count: 35 });
    expect(groups[0]!.files).toHaveLength(5);
    expect(findingLine(groups[0]!)).toBe("35 files: the file name does not match the project's pattern, refused");
  });

  it("keeps renamed and refused apart and shows a fixed file's new name once", () => {
    const groups = groupFindings([
      { rule: "layout.forbidden-char", severity: "info", message: "Forbidden characters were replaced.", file: "Batch/a:1.png", renamedTo: "Batch/a_1.png" },
      { rule: "layout.forbidden-char", severity: "info", message: "Forbidden characters were replaced.", file: "Batch:1/b.png", renamedTo: "Batch_1/b.png" },
      { rule: "layout.too-deep", severity: "error", message: "Too deep.", evaluate: true },
    ], { refused: true });
    expect(groups.map((g) => [g.rule, g.outcome, g.count])).toEqual([["layout.forbidden-char", "renamed", 2], ["layout.too-deep", "reported", 1]]);
    expect(findingLine(groups[0]!)).toBe("2 files: forbidden characters were replaced, renamed automatically");
    expect(renamedExample(groups[0]!)).toBe("a:1.png is now a_1.png");
  });

  it("says each distinct violation of a rejected write once", () => {
    const v = Array.from({ length: 3 }, () => ({ rule: "r", severity: "error", message: "Bad name.", fix: "Rename it." }));
    expect(violationsText(v)).toBe("Bad name. Rename it. (3 files)");
  });
});
