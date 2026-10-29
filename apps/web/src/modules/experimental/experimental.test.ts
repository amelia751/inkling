import { describe, expect, it } from "vitest";
import "@/bundle";
import { createRegistry, registry } from "@/platform/registry";
import { resolveEnvironment } from "@/platform/resolve";
import experimental from "./manifest";
import { selectValue, vetProposals } from "./bridge";

const reg = createRegistry([...registry.listModules(), experimental]);
const env = resolveEnvironment(
  {
    extends: "preset:generic-image",
    labels: [{ name: "objects", control: "RectangleLabels", classes: [{ id: "cat" }] }],
    panels: { right: ["inkling.experimental.panels.declarative", "inkling.experimental.panels.sandbox"] },
    overrides: [{ id: "inkling.experimental.panels.declarative", config: { blocks: [{ type: "stat", label: "Boxes", value: { store: "annotations.item" } }] } }],
  },
  reg,
  { baseModules: ["inkling.core"] },
).env!;

describe("agent panels", () => {
  it("validates declarative panel config through the environment", () => {
    expect(env.configs["inkling.experimental.panels.declarative"]).toMatchObject({ title: "Agent panel", blocks: [{ type: "stat" }] });
    const bad = resolveEnvironment({ extends: "preset:generic-image", panels: { right: ["inkling.experimental.panels.declarative"] }, overrides: [{ id: "inkling.experimental.panels.declarative", config: { blocks: [{ type: "script", code: "alert(1)" }] } }] }, reg, { baseModules: ["inkling.core"] });
    expect(bad.errors?.[0].code).toBe("invalid-config");
  });

  it("computes whitelisted store selectors", () => {
    const s = { annotations: [{ itemId: "a", label: "cat" }, { itemId: "a", label: "cat" }, { itemId: "b", label: "dog" }] as never, selectedIds: [], activeLabel: "cat", tool: "box" };
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }] as never;
    expect(selectValue("items.annotated", s, items, undefined)).toBe(2);
    expect(selectValue("annotations.item", s, items, { id: "a" } as never)).toBe(2);
    expect(selectValue("labels.counts", s, items, undefined)).toEqual({ cat: 2, dog: 1 });
  });

  it("vets sandbox proposals: known labels and geometry types only, plain values", () => {
    const { ok, rejected } = vetProposals(
      [
        { label: "cat", geometry: { type: "box", x: 1, y: 2, w: 3, h: 4 }, attributes: { score: 0.9, evil: () => 1 } },
        { label: "dog", geometry: { type: "box", x: 0, y: 0, w: 1, h: 1 } },
        { label: "cat", geometry: { type: "mask", dims: [1], counts: [1] } },
        "nope",
      ],
      env,
    );
    expect(ok).toEqual([{ label: "cat", geometry: { type: "box", x: 1, y: 2, w: 3, h: 4 }, attributes: { score: 0.9 } }]);
    expect(rejected).toHaveLength(3);
    expect(vetProposals({}, env).rejected).toEqual(["expected an array of { label, geometry }"]);
  });
});
