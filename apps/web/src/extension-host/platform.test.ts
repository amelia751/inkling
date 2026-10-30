import { describe, expect, it } from "vitest";
import { describeCatalog, environmentJsonSchema, catalogPrompt } from "./catalog";
import { createRegistry, RegistryError } from "./registry";
import { mergeSpecs, resolveEnvironment, satisfies } from "./resolve";
import { alwaysTrue, mayBeTrue, when } from "./when";
import { brokenFixture, coreFixture, imageFixture, videoFixture } from "./fixtures.test-helpers";

const reg = () => createRegistry([coreFixture, imageFixture, videoFixture]);
const codes = (r: ReturnType<typeof resolveEnvironment>) => (r.errors ?? []).map((e) => e.code);

describe("when", () => {
  const ctx = { "renderer.space": "image2d", "renderer.capabilities": ["time", "playback"], tool: "brush", "selection.count": 2, drafting: false };
  it("compares, negates and combines", () => {
    expect(when("renderer.space == image2d", ctx)).toBe(true);
    expect(when("renderer.space != image2d", ctx)).toBe(false);
    expect(when("!drafting && tool == brush", ctx)).toBe(true);
    expect(when("tool == eraser || selection.count > 1", ctx)).toBe(true);
    expect(when("(tool == eraser || tool == brush) && !(selection.count >= 3)", ctx)).toBe(true);
    expect(when("'playback' in renderer.capabilities", ctx)).toBe(true);
    expect(when("'slices' not in renderer.capabilities", ctx)).toBe(true);
    expect(when("tool =~ /^br/", ctx)).toBe(true);
    expect(when(undefined, ctx)).toBe(true);
  });
  it("treats unknown keys as maybe in partial mode", () => {
    expect(mayBeTrue("tool == brush", { "renderer.space": "volume" })).toBe(true);
    expect(mayBeTrue("renderer.space == image2d && tool == brush", { "renderer.space": "volume" })).toBe(false);
    expect(alwaysTrue("tool == brush", {})).toBe(false);
    expect(alwaysTrue("renderer.space == image2d", { "renderer.space": "image2d" })).toBe(true);
  });
  it("rejects bad syntax without eval", () => {
    expect(() => when("tool ==", ctx)).toThrow();
    expect(() => when("a && (b", ctx)).toThrow();
    expect(() => when("alert(1)", ctx)).toThrow();
  });
});

describe("registry", () => {
  it("indexes full ids and is idempotent", () => {
    const r = reg();
    r.registerModule(coreFixture);
    expect(r.get("tools", "test.core.tools.box")?.name).toBe("box");
    expect(r.get("presets", "preset:image")?.module).toBe("test.image");
    expect(r.geometry("span")?.id).toBe("test.core.geometries.span");
    expect(r.modulesFor("test.video.dataKinds.video").map((m) => m.id)).toEqual(["test.video"]);
  });
  it("rejects a second manifest with the same id", () => {
    expect(() => reg().registerModule({ ...coreFixture })).toThrow(RegistryError);
  });
  it("loads implementations lazily and caches them", async () => {
    let loads = 0;
    const r = createRegistry([
      { ...brokenFixture, id: "test.lazy", requires: [], load: async () => (loads++, { panels: { lonely: () => null } }) },
    ]);
    await r.loadImpl("test.lazy.panels.lonely");
    await r.loadImpl("test.lazy.panels.lonely");
    expect(loads).toBe(1);
    await expect(r.loadImpl("test.lazy.panels.nope")).rejects.toThrow();
  });
});

describe("resolveEnvironment", () => {
  it("resolves a preset with defaults, requirements and commands", () => {
    const { env, errors } = resolveEnvironment({ extends: "preset:image" }, reg());
    expect(errors).toBeUndefined();
    expect(env!.tools.map((t) => t.name)).toEqual(["select", "box"]);
    expect(env!.viewports[0].config).toEqual({ smoothing: true });
    expect(env!.modules.map((m) => m.id).sort()).toEqual(["test.core", "test.image"]);
    expect(env!.commands.map((c) => c.name).sort()).toEqual(["fit", "nextItem", "undo"]);
    expect(env!.panels.left.map((p) => p.name)).toEqual(["files"]);
  });

  it("merges extends then overrides", () => {
    const { env } = resolveEnvironment(
      {
        extends: "preset:image",
        labels: [{ name: "objects", control: "RectangleLabels", classes: [{ id: "car", color: "#f00" }] }],
        overrides: [
          { id: "test.core.tools.select", disabled: true },
          { id: "test.image.renderers.canvas", config: { smoothing: false } },
        ],
      },
      reg(),
    );
    expect(env!.tools.map((t) => t.name)).toEqual(["box"]);
    expect(env!.labels[0].classes.map((c) => c.id)).toEqual(["car"]);
    expect(env!.viewports[0].config.smoothing).toBe(false);
  });

  it("reports unknown ids with a suggestion", () => {
    const r = resolveEnvironment({ extends: "preset:image", tools: ["test.core.tools.bx"] }, reg());
    expect(r.errors?.[0]).toMatchObject({ path: "/tools/0", code: "unknown-contribution", suggestion: "test.core.tools.box" });
  });

  it("reports wrong types and unknown presets", () => {
    expect(codes(resolveEnvironment({ extends: "preset:image", tools: ["test.core.panels.files"] }, reg()))).toEqual(["wrong-type"]);
    expect(resolveEnvironment({ extends: "preset:imag" }, reg()).errors?.[0]).toMatchObject({ code: "unknown-contribution", suggestion: "preset:image" });
  });

  it("reports missing requirements", () => {
    const r = createRegistry([coreFixture, imageFixture, brokenFixture]);
    const res = resolveEnvironment({ extends: "preset:image", panels: { right: ["test.broken.panels.lonely"] } }, r);
    expect(codes(res)).toContain("missing-requirement");
  });

  it("reports tool / space mismatches", () => {
    const res = resolveEnvironment({ extends: "preset:image", tools: ["test.core.tools.span"] }, reg());
    expect(codes(res)).toEqual(["tool-unsupported"]);
  });

  it("reports renderer / data mismatches", () => {
    const res = resolveEnvironment({ extends: "preset:image", data: { kind: "test.video.dataKinds.video" } }, reg());
    expect(res.errors?.[0]).toMatchObject({ code: "renderer-data-mismatch", suggestion: "test.video.renderers.frames" });
  });

  it("reports hotkey clashes", () => {
    const res = resolveEnvironment(
      { extends: "preset:image", labels: [{ name: "objects", control: "RectangleLabels", classes: [{ id: "cat", hotkey: "r" }] }] },
      reg(),
    );
    expect(res.errors?.[0]).toMatchObject({ code: "hotkey-conflict" });
    expect(res.errors?.[0].message).toContain("test.core.tools.box");
  });

  it("lets rebinding resolve a clash", () => {
    const res = resolveEnvironment(
      { extends: "preset:image", keybindings: [{ command: "test.image.commands.fit", keys: ["r"] }] },
      reg(),
    );
    expect(codes(res)).toEqual(["hotkey-conflict"]);
    const ok = resolveEnvironment({ extends: "preset:image", keybindings: [{ command: "test.image.commands.fit", keys: ["f"] }] }, reg());
    expect(ok.env!.commands.find((c) => c.name === "fit")!.keys).toEqual(["f"]);
  });

  it("applies replaces for commands", () => {
    const { env, errors } = resolveEnvironment(
      { data: { kind: "test.video.dataKinds.video" }, viewports: [{ name: "main", renderer: "test.video.renderers.frames" }], tools: ["test.core.tools.select"], modules: { "test.core": "^1" } },
      reg(),
    );
    expect(errors).toBeUndefined();
    expect(env!.commands.map((c) => c.name).sort()).toEqual(["stepFrame", "undo"]);
  });

  it("checks module versions, label targets, exporters and config", () => {
    expect(codes(resolveEnvironment({ extends: "preset:image", modules: { "test.core": "^2" } }, reg()))).toEqual(["module-version"]);
    expect(codes(resolveEnvironment({ extends: "preset:image", labels: [{ name: "x", control: "RectangleLabels", toName: "side", classes: [] }] }, reg()))).toEqual(["label-target"]);
    expect(codes(resolveEnvironment({ extends: "preset:image", exporters: ["test.image.exporters.wfdb"] }, reg()))).toEqual(["exporter-unused"]);
    expect(codes(resolveEnvironment({ extends: "preset:image", viewports: [{ name: "main", renderer: "test.image.renderers.canvas", config: { smoothing: "yes" } }] }, reg()))).toEqual(["invalid-config"]);
  });

  it("returns schema errors with JSON pointers", () => {
    const res = resolveEnvironment({ tools: "box" }, reg());
    expect(res.errors?.[0]).toMatchObject({ path: "/tools", code: "schema" });
  });
});

describe("helpers", () => {
  it("merges specs: objects merge, arrays replace, overrides concatenate", () => {
    const m = mergeSpecs(
      { panels: { left: ["a"], right: ["b"] }, tools: ["x"], overrides: [{ id: "1" }] },
      { panels: { left: ["c"] }, tools: ["y"], overrides: [{ id: "2" }] },
    );
    expect(m).toEqual({ panels: { left: ["c"], right: ["b"] }, tools: ["y"], overrides: [{ id: "1" }, { id: "2" }] });
  });
  it("merges label groups by name: same name replaces in place, new groups append", () => {
    const g = (name: string, id: string) => ({ name, control: "Labels", classes: [{ id }] });
    const m = mergeSpecs({ labels: [g("labels", "a"), g("statements", "s")] }, { labels: [g("labels", "b"), g("extra", "x")] });
    expect(m.labels).toEqual([g("labels", "b"), g("statements", "s"), g("extra", "x")]);
  });
  it("checks semver ranges", () => {
    expect(satisfies("1.4.2", "^1")).toBe(true);
    expect(satisfies("2.0.0", "^1.2")).toBe(false);
    expect(satisfies("0.2.5", "^0.2.1")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.1")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("3.0.0", "*")).toBe(true);
    expect(satisfies("1.0.0", ">=0.9")).toBe(true);
  });
});

describe("catalog", () => {
  it("describes every contribution with edges and schemas", () => {
    const c = describeCatalog(reg());
    const canvas = c.contributions.find((x) => x.id === "test.image.renderers.canvas")!;
    expect(canvas.consumes).toEqual(["test.image.dataKinds.raster"]);
    expect(canvas.configSchema).toMatchObject({ type: "object", properties: { smoothing: { type: "boolean" } } });
    expect(c.contributions.find((x) => x.id === "test.core.tools.box")!.creates).toBe("box");
    expect(catalogPrompt(reg())).toContain("`preset:image`");
  });
  it("builds a JSON Schema whose id fields are enums of registered ids", () => {
    const s = environmentJsonSchema(reg()) as any;
    const root = s.$defs?.EnvironmentSpec ?? s;
    expect(root.properties.tools.items.enum).toContain("test.core.tools.box");
    expect(root.properties.viewports.items.properties.renderer.enum).toEqual(["test.image.renderers.canvas", "test.video.renderers.frames"]);
    expect(root.properties.extends.anyOf[0].enum).toEqual(["preset:image"]);
  });
});

describe("shadows", () => {
  it("takes only the overlapping keys", () => {
    const r = createRegistry([
      coreFixture,
      imageFixture,
      { ...videoFixture, id: "test.video2", contributes: { ...videoFixture.contributes, commands: [{ id: "step", label: "Step", group: "Playback", keys: ["ArrowRight"], shadows: ["test.core.commands.nextItem"], description: "Step" }] } },
    ]);
    const { env } = resolveEnvironment({ extends: "preset:image", modules: { "test.video2": "*" } }, r);
    expect(env!.commands.find((c) => c.name === "nextItem")!.keys).toEqual([]);
    expect(env!.commands.find((c) => c.name === "step")!.keys).toEqual(["ArrowRight"]);
  });
});
