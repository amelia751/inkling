import { describe, expect, it } from "vitest";
import { ns } from "@studio/plugin-contracts/naming";
import { defineModule } from "@studio/plugin-ui-sdk";
import { BUILTIN_MODULES, MODULES } from "./bundled";
import { describeCatalog } from "./catalog";
import { createRegistry } from "./registry";
import { resolveEnvironment, type ResolveOptions } from "./resolve";

const base: ResolveOptions = { baseModules: [ns("core")] };
const fresh = () => {
  const r = createRegistry(MODULES);
  r.pin(BUILTIN_MODULES.map((m) => m.id));
  return r;
};

describe("per-workspace activation", () => {
  it("two workspaces with different plugin sets see different catalogues", () => {
    const a = fresh();
    const b = fresh();
    a.setActive([ns("image2d")]);
    b.setActive([ns("wsi"), ns("video")]);
    const mods = (r: ReturnType<typeof fresh>) => describeCatalog(r).modules.map((m) => m.id);
    expect(mods(a)).toContain(ns("image2d"));
    expect(mods(a)).not.toContain(ns("wsi"));
    expect(mods(b)).toEqual(expect.arrayContaining([ns("wsi"), ns("video")]));
    expect(mods(b)).not.toContain(ns("image2d"));
    // Built-ins are in both; no inactive plugin's contribution leaks into the catalogue.
    expect(mods(a)).toContain(ns("core"));
    expect(describeCatalog(a).contributions.some((c) => c.module === ns("wsi"))).toBe(false);
  });

  it("activate then deactivate restores the previous resolved environment exactly", () => {
    const r = fresh();
    r.setActive([ns("image2d"), ns("dicom-export")]);
    const before = resolveEnvironment({ extends: "preset:image-2d" }, r, base);
    expect(before.errors, JSON.stringify(before.errors)).toBeUndefined();
    r.activate(ns("wsi"));
    expect(r.isActive(ns("wsi"))).toBe(true);
    r.deactivate(ns("wsi"));
    const after = resolveEnvironment({ extends: "preset:image-2d" }, r, base);
    expect(after.env).toEqual(before.env);
  });

  it("an environment that needs an inactive plugin doesn't resolve until it's enabled", () => {
    const r = fresh();
    r.setActive([ns("image2d")]);
    const off = resolveEnvironment({ extends: "preset:pathology" }, r, base);
    expect(off.errors?.some((e) => e.message.includes(ns("wsi")))).toBe(true);
    r.activate(ns("wsi"));
    expect(resolveEnvironment({ extends: "preset:pathology" }, r, base).errors).toBeUndefined();
  });

  it("pulls requirements from available modules and reports missing ones", () => {
    const r = fresh();
    r.setActive([ns("cardiac-metrics")]);
    expect(r.isActive(ns("cine"))).toBe(true); // required, available, so activated
    const orphan = defineModule({ id: "test.orphan", version: "1.0.0", title: "Orphan", description: "", requires: ["test.nowhere"], contributes: {} });
    const r2 = createRegistry([...MODULES, orphan]);
    const res = r2.setActive(["test.orphan"]);
    expect(res.missing).toEqual([{ module: "test.orphan", requires: "test.nowhere" }]);
    expect(r2.isActive("test.orphan")).toBe(false);
  });

  it("deactivating a plugin also deactivates plugins that require it", () => {
    const r = fresh();
    r.setActive([ns("cine"), ns("cardiac-metrics")]);
    r.deactivate(ns("cine"));
    expect(r.isActive(ns("cardiac-metrics"))).toBe(false);
  });
});
