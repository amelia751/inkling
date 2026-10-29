import { describe, expect, it } from "vitest";
import "@/bundle";
import { createRegistry, registry } from "@/platform/registry";
import { resolveEnvironment } from "@/platform/resolve";
import example from "./manifest";

describe("module template", () => {
  it("resolves its README environment next to the bundled modules", async () => {
    const r = createRegistry([...registry.listModules(), example]);
    const res = resolveEnvironment(
      {
        data: { kind: "inkling.example.dataKinds.file" },
        viewports: [{ name: "main", renderer: "inkling.example.renderers.canvas" }],
        tools: ["inkling.core.tools.select", "inkling.example.tools.dot"],
        panels: { left: ["inkling.core.panels.files", "inkling.core.panels.labels"], right: ["inkling.example.panels.count"] },
        labels: [{ name: "points", control: "KeyPointLabels", classes: [{ id: "dot" }] }],
      },
      r,
      { baseModules: ["inkling.core"] },
    );
    expect(res.errors).toBeUndefined();
    expect(res.env!.viewports[0].config).toEqual({ background: "#111" });
    expect(await r.loadImpl("inkling.example.renderers.canvas")).toBeTypeOf("function");
  });
});
