import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { labelGroupsFrom } from "@/studio/lib/api";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment } from "@/extension-host/resolve";
import { buildSheet } from "./ShortcutsDialog";

const env = (labels = labelGroupsFrom(["a", "b"])) => resolveEnvironment({ extends: "preset:image-2d", labels }, registry).env!;
const labelsOf = (rows: { label: string }[]) => rows.map((r) => r.label);

describe("shortcuts sheet (todo8 D6)", () => {
  it("leads with at most 8 essentials from the core list", () => {
    const s = buildSheet(env());
    expect(s.essentials.length).toBeLessThanOrEqual(8);
    expect(labelsOf(s.essentials)).toEqual(["Undo / redo", "Delete selected", "Previous / next item", "Next to do", "Pick label", "Hold Space to pan", "Keyboard shortcuts"]);
  });

  it("lists this task's tools by toolbar group", () => {
    expect(buildSheet(env()).tools.map((g) => g.title)).toEqual(["Navigate", "Shapes", "Measure", "Paint"]);
    // A classification task has no drawing tools, so no Shapes or Paint.
    expect(buildSheet(env(labelGroupsFrom(["a", "b"], "classification"))).tools.map((g) => g.title)).toEqual(["Navigate", "Measure"]);
  });

  it("keeps contextual keys under While drawing, out of the command groups", () => {
    const s = buildSheet(env());
    expect(labelsOf(s.whileDrawing)).toEqual(["Cancel the drag or drawing in progress"]);
    const commands = s.commands.flatMap((g) => labelsOf(g.rows));
    expect(commands).not.toContain("Cancel the drag or drawing in progress");
    expect(commands).not.toContain("Undo");
  });

  it("searches by label or key: b finds Brush and the [ / ] brush sizes", () => {
    const s = buildSheet(env(), "b");
    expect(s.tools.flatMap((g) => labelsOf(g.rows))).toContain("Brush");
    expect(s.commands.flatMap((g) => labelsOf(g.rows))).toEqual(expect.arrayContaining(["Smaller brush", "Larger brush"]));
    expect(labelsOf(buildSheet(env(), "next to").essentials)).toEqual(["Next to do"]);
    expect(buildSheet(env(), "zzz").tools).toEqual([]);
  });
});
