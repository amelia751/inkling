import { describe, expect, it } from "vitest";
import "@/extension-host/bundled";
import { labelGroupsFrom } from "@/studio/lib/api";
import { ns } from "@studio/contracts/naming";
import { registry } from "./registry";
import { resolveEnvironment } from "./resolve";
import { when } from "./when";

/** todo6 Phase 2: the shell's Sources keys (Space, Enter, mod+f) never claim keys in the Studio. */
const coreCommand = (name: string) => ns(`core.commands.${name}`);

describe("shell commands", () => {
  const SOURCES = ["quickLook", "openItem", "parentFolder", "focusSearch"].map(coreCommand);
  // todo7 §2 Keyboard: the file operations, declared the same way.
  const FILES = ["newFolder", "rename", "cut", "copy", "paste", "duplicate", "moveToTrash", "clearSelection", "expandAllBelow", "toggleInspector"].map(coreCommand);

  it.each(["image-2d", "video", "cine-4d", "ecg"])("preset:%s leaves the Sources keys out of the Studio", (id) => {
    const r = resolveEnvironment({ extends: `preset:${id}`, labels: labelGroupsFrom(["a"], "classification") }, registry);
    expect(r.errors).toBeUndefined();
    expect(r.env!.context.section).toBe("studio");
    const ids = r.env!.commands.map((c) => c.id);
    for (const c of [...SOURCES, ...FILES]) expect(ids).not.toContain(c);
    expect(ids).toContain(coreCommand("toggleNavigation"));
  });

  it("binds them on the Data page (route segment `files`, todo7 D11)", () => {
    for (const c of [...SOURCES, ...FILES]) {
      const def = registry.get("commands", c)!;
      expect(def, c).toBeDefined();
      expect(def.keys?.length, c).toBeGreaterThan(0);
      expect(when(def.when, { section: "files" })).toBe(true);
      expect(when(def.when, { section: "overview" })).toBe(false);
      expect(when(def.when, { section: "studio" })).toBe(false);
    }
  });

  it("undo, redo and select all are the shared Edit commands, active on the Data page", () => {
    for (const name of ["undo", "redo", "selectAll"]) {
      const def = registry.get("commands", coreCommand(name))!;
      expect(when(def.when, { section: "files" })).toBe(true);
    }
  });
});
