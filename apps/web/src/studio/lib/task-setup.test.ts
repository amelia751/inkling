import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { registry } from "@/extension-host/registry";
import { resolveEnvironment, type ResolvedEnv } from "@/extension-host/resolve";
import type { EnvironmentSpec } from "@studio/contracts/environment";
import { ns } from "@studio/contracts/naming";
import { buildNextSpec, canEditTaskSetup, hotkeyConflicts, initialDraft, labelProblems, slugify, studioDefaults } from "./task-setup";

const XRAY: EnvironmentSpec = {
  extends: "preset:image-2d",
  task: "classification",
  labels: [
    { name: "class", control: "Choices", classes: [{ id: "normal", color: "chart-1" }, { id: "pneumonia", color: "chart-2" }] },
    { name: "regions", control: "Labels", classes: [{ id: "opacity", color: "chart-3" }] },
  ],
};

function resolve(spec: EnvironmentSpec): ResolvedEnv {
  const r = resolveEnvironment(spec, registry);
  expect(r.errors).toBeUndefined();
  return r.env!;
}

describe("Task setup draft", () => {
  it("an untouched draft changes nothing", () => {
    const env = resolve(XRAY);
    expect(buildNextSpec(env, initialDraft(env))).toEqual(env.source);
  });

  it("adds a class with a key, and the result resolves", () => {
    const env = resolve(XRAY);
    const d = initialDraft(env);
    d.labels[0].classes.push({ id: "effusion", name: "Effusion", color: "chart-3", hotkey: "3" });
    const next = buildNextSpec(env, d);
    expect(next.labels![0].classes.map((c) => c.id)).toEqual(["normal", "pneumonia", "effusion"]);
    expect(next.extends).toBe("preset:image-2d");
    const after = resolve(next);
    expect(after.labels[0].classes[2]).toMatchObject({ id: "effusion", hotkey: "3" });
  });

  it("switches tools off with overrides and back on by dropping them", () => {
    const env = resolve(XRAY);
    const brush = ns("cornerstone.tools.brush");
    const d = initialDraft(env);
    d.disabledTools = [brush];
    const off = buildNextSpec(env, d);
    expect(off.overrides).toEqual([{ id: brush, disabled: true }]);
    const envOff = resolve(off);
    expect(envOff.tools.some((t) => t.id === brush)).toBe(false);
    // The tool stays listed in the spec, so Task setup can show it unticked.
    expect(initialDraft(envOff).disabledTools).toEqual([brush]);
    const on = buildNextSpec(envOff, { ...initialDraft(envOff), disabledTools: [] });
    expect(on.overrides).toEqual([]);
    expect(resolve(on).tools.some((t) => t.id === brush)).toBe(true);
  });

  it("writes a changed panel slot and the Annotators see flags", () => {
    const env = resolve(XRAY);
    const d = initialDraft(env);
    d.panels.left = [ns("core.panels.files"), ns("core.panels.labels")];
    d.studio = { ...d.studio, showSourceLabels: true };
    const next = buildNextSpec(env, d);
    expect(next.panels).toEqual({ left: [ns("core.panels.files"), ns("core.panels.labels")] });
    expect(next.studio).toEqual({ showSourceLabels: true, showFilePaths: true });
    expect(resolve(next).spec.studio).toEqual({ showSourceLabels: true, showFilePaths: true });
  });

  it("is blind by default for classification only", () => {
    expect(studioDefaults(resolve(XRAY)).showSourceLabels).toBe(false);
    expect(studioDefaults(resolve({ ...XRAY, task: "segmentation" })).showSourceLabels).toBe(true);
  });
});

describe("label keys", () => {
  it("flags a key a tool or another class already uses, but not the class's own digit", () => {
    const env = resolve(XRAY);
    const labels = structuredClone(env.spec.labels!);
    const brushKey = env.tools.find((t) => t.name === "brush")!.hotkey!;
    labels[0].classes[0].hotkey = brushKey;
    labels[0].classes[1].hotkey = "2"; // its own position: pick-by-number
    labels[1].classes[0].hotkey = "2";
    const c = hotkeyConflicts(labels, env, env.tools);
    expect(c.get("0:0")).toMatch(/Brush/);
    expect(c.get("0:1")).toMatch(/opacity/);
    expect(c.get("1:0")).toMatch(/pneumonia/);
    labels[1].classes[0].hotkey = "3";
    expect(hotkeyConflicts(labels, env, env.tools).has("1:0")).toBe(false);
  });

  it("names problems that keep the page from saving", () => {
    expect(labelProblems([{ name: "g", control: "Labels", classes: [{ id: "" }, { id: "a" }, { id: "a" }] }])).toHaveLength(2);
    expect(slugify(" Pleural effusion ")).toBe("pleural-effusion");
  });

  it("lets everyone edit until projects have roles", () => {
    expect(canEditTaskSetup(undefined)).toBe(true);
    expect(canEditTaskSetup({ role: "annotator" } as never)).toBe(false);
  });
});
