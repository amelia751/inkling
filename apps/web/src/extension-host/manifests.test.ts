import { describe, expect, it } from "vitest";
import { BUILTIN_MODULES, MODULES } from "./bundled";
import { PLUGIN_PACKAGES, parsePluginManifest } from "./manifests";
import { registry } from "./registry";

describe("plugin.yaml manifests", () => {
  it("every plugin.yaml and contributions.json validates", () => {
    expect(PLUGIN_PACKAGES.problems).toEqual([]);
    expect(PLUGIN_PACKAGES.packages.length).toBeGreaterThan(0);
  });

  // _template is the SDK template (registered by its own test, not bundled).
  it.each(PLUGIN_PACKAGES.packages.filter((p) => p.manifest.ui?.module && p.dir !== "_template").map((p) => [p.dir, p] as const))("%s: id and version match the TS module", (_dir, p) => {
    const m = registry.module(p.manifest.id);
    expect(m, `no bundled module ${p.manifest.id}`).toBeDefined();
    expect(m!.version).toBe(p.manifest.version);
    for (const req of Object.keys(p.manifest.requires ?? {})) expect(m!.requires ?? [], `${p.dir} requires ${req}`).toContain(req);
  });

  it("every bundled plugin module has a plugin.yaml", () => {
    const declared = new Set(PLUGIN_PACKAGES.packages.map((p) => p.manifest.id));
    const builtins = new Set(BUILTIN_MODULES.map((m) => m.id));
    for (const m of MODULES) if (!builtins.has(m.id)) expect(declared.has(m.id), `${m.id} has no plugins/*/plugin.yaml`).toBe(true);
  });

  it("rejects unknown (possibly privileged) fields and undeclared egress", () => {
    const base = PLUGIN_PACKAGES.packages[0];
    const text = (extra: string) => `schemaVersion: ${base.manifest.schemaVersion}\nid: test.x\nname: X\nversion: 1.0.0\npublisher: t\nlicense: MIT\ncompatibility: { studio: "*", pluginApi: "^1" }\nruntime: { kind: none }\npermissions: { required: [], optional: [] }\n${extra}`;
    expect(parsePluginManifest(text("")).errors).toBeUndefined();
    expect(parsePluginManifest(text("sudo: true")).errors?.[0]).toMatch(/sudo|unrecognized/i);
    const provider = `capabilities: [{ id: image.segment }]\nproviders: [{ id: meta.sam, implements: [image.segment], egress: [api.example.com], secrets: [KEY] }]`;
    const errs = parsePluginManifest(text(provider)).errors ?? [];
    expect(errs.join("\n")).toMatch(/network\.egress:api\.example\.com/);
    expect(errs.join("\n")).toMatch(/secrets\.use:KEY/);
  });
});
