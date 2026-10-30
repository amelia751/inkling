import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * A rename is a config change (todo/todo2.md D3): with the namespace switched to `acme` and
 * the old one kept in `legacyNamespaces`, documents stored with old full ids (presets, seed
 * manifests, saved environments, annotation geometry types) still resolve.
 */
describe("namespace rename", async () => {
  vi.resetModules();
  const naming = await import("@studio/plugin-contracts/naming");
  const OLD = naming.NAMING.namespace;
  naming.configureNaming({ namespace: "acme", legacyNamespaces: [OLD] });
  const { MODULES, presets } = await import("@/extension-host/bundled");
  const { registry } = await import("./registry");
  const { resolveEnvironment } = await import("./resolve");
  const { normalizeProject } = await import("@/studio/lib/api");

  it("registers every module under the new namespace", () => {
    for (const m of MODULES) expect(m.id.startsWith("acme.")).toBe(true);
    expect(registry.module(`${OLD}.wsi`)?.id).toBe("acme.wsi");
    expect(registry.get("renderers", `${OLD}.wsi.renderers.osd`)?.id).toBe("acme.wsi.renderers.osd");
  });

  it.each(presets.contributes.presets!.map((p) => p.id))("preset:%s (stored with old ids) resolves", (id) => {
    const r = resolveEnvironment({ extends: `preset:${id}` }, registry);
    expect(r.errors).toBeUndefined();
    expect(r.env!.dataKind.id.startsWith("acme.")).toBe(true);
  });

  it("resolves a spec written with old ids, including overrides and keybindings", () => {
    const r = resolveEnvironment(
      {
        extends: "preset:pathology",
        overrides: [{ id: `${OLD}.wsi.renderers.osd`, config: { showNavigator: false } }],
        keybindings: [{ command: `${OLD}.wsi.commands.toggleClassNames`, keys: ["shift+n"] }],
        modules: { [`${OLD}.wsi`]: "^1" },
      },
      registry,
    );
    expect(r.errors).toBeUndefined();
    expect(r.env!.tools.map((t) => t.id)).toContain("acme.wsi.tools.brush");
    expect(r.env!.commands.find((c) => c.id === "acme.wsi.commands.toggleClassNames")?.keys).toEqual(["shift+n"]);
    expect(r.env!.configs["acme.wsi.renderers.osd"]).toMatchObject({ showNavigator: false });
  });

  it("finds geometry types stored under the old namespace", () => {
    expect(registry.geometry(`${OLD}.text-spans.span`)?.type).toBe("acme.text-spans.span");
  });

  it("every seed-manifest project environment validates", () => {
    const path = new URL("../../../../seed-data/manifest.json", import.meta.url).pathname;
    let raw: { projects: Parameters<typeof normalizeProject>[0][] };
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return; // seed data not fetched (`pnpm seeds`)
    }
    for (const p of raw.projects) expect(resolveEnvironment(normalizeProject(p).environment, registry).errors, p.id).toBeUndefined();
  });
});
