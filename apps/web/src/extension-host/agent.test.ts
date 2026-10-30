import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { AGENT_TOOLS, agentSystemPrompt, changedKeys, runAgentTool, type AgentHost } from "./agent";
import { registry } from "./registry";
import { resolveEnvironment, type ResolvedEnv } from "./resolve";
import { NS, ns } from "@studio/plugin-contracts/naming";

function host(spec: object) {
  let env = resolveEnvironment(spec, registry).env!;
  const applied: string[] = [];
  const h: AgentHost = {
    env: () => env,
    apply: async (next: ResolvedEnv, summary: string) => {
      env = next;
      applied.push(summary);
    },
  };
  return { h, applied, current: () => env };
}

describe("agent tools", () => {
  it("defines Messages API tool schemas", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.input_schema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
    }
    expect(agentSystemPrompt()).toContain(ns("wsi.renderers.osd"));
  });

  it("patches the running environment as one applied step", async () => {
    const { h, applied, current } = host({ extends: "preset:pathology", labels: [{ name: "t", control: "PolygonLabels", classes: [{ id: "tumor" }] }] });
    const r = await runAgentTool(
      "patch_environment",
      { patch: [{ op: "add", path: "/labels/0/classes/-", value: { id: "stroma", color: "#3a7" } }], summary: "Add stroma" },
      h,
    );
    expect(r.ok).toBe(true);
    expect(applied).toEqual(["Add stroma"]);
    expect(current().labels[0].classes.map((c) => c.id)).toEqual(["tumor", "stroma"]);
  });

  it("returns structured errors and applies nothing for a bad patch", async () => {
    const { h, applied } = host({ extends: "preset:pathology" });
    const r = await runAgentTool("patch_environment", { patch: [{ op: "add", path: "/tools", value: [ns("core.tools.selct")] }], summary: "x" }, h);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([expect.objectContaining({ path: "/tools/0", code: "unknown-contribution", suggestion: ns("core.tools.select") })]);
    expect(applied).toEqual([]);
  });

  it("previews and describes", async () => {
    const { h } = host({ extends: "preset:video" });
    const p = await runAgentTool("preview_environment", { spec: { extends: "preset:video", tools: [ns("core.tools.select"), ns("overlay2d.tools.box")], exporters: [ns("video.exporters.mot")] } }, h);
    expect((p.preview as { tools: string[] }).tools).toEqual([`${NS}.core.tools.select (v)`, `${NS}.overlay2d.tools.box (r)`]);
    const d = await runAgentTool("describe_contribution", { id: "preset:ecg" }, h);
    expect(d.ok).toBe(true);
    expect(changedKeys({ tools: ["a"] }, { tools: ["b"], title: "x" })).toEqual(["tools", "title"]);
  });
});
