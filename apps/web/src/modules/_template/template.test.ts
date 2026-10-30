import { describe, expect, it } from "vitest";
import "@/bundle";
import { createRegistry, registry } from "@/platform/registry";
import { resolveEnvironment } from "@/platform/resolve";
import example from "./manifest";
import { ns } from "@studio/plugin-contracts/naming";

describe("module template", () => {
  it("resolves its README environment next to the bundled modules", async () => {
    const r = createRegistry([...registry.listModules(), example]);
    const res = resolveEnvironment(
      {
        data: { kind: ns("example.dataKinds.file") },
        viewports: [{ name: "main", renderer: ns("example.renderers.canvas") }],
        tools: [ns("core.tools.select"), ns("example.tools.dot")],
        panels: { left: [ns("core.panels.files"), ns("core.panels.labels")], right: [ns("example.panels.count")] },
        labels: [{ name: "points", control: "KeyPointLabels", classes: [{ id: "dot" }] }],
      },
      r,
      { baseModules: [ns("core")] },
    );
    expect(res.errors).toBeUndefined();
    expect(res.env!.viewports[0].config).toEqual({ background: "#111" });
    expect(await r.loadImpl(ns("example.renderers.canvas"))).toBeTypeOf("function");
  });
});
