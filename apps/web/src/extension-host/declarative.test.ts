import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MODULES } from "./bundled";
import { declarativeModule, itemMediaType, unknownRenderers, visibleToolbarCommands } from "./contributions-loader";
import { loadPluginPackages } from "./manifests";
import { createRegistry } from "./registry";
import { resolveEnvironment } from "./resolve";

const dir = join(__dirname, "__fixtures__/declarative-plugin/");
const { packages, problems } = loadPluginPackages(
  { "/x/plugins/fixture/plugin.yaml": readFileSync(`${dir}plugin.yaml`, "utf8") },
  { "/x/plugins/fixture/ui/contributions.json": JSON.parse(readFileSync(`${dir}ui/contributions.json`, "utf8")) },
);
const pkg = packages[0];
const fixture = declarativeModule(pkg.manifest, pkg.contributions!);
const registry = createRegistry([...MODULES, fixture]);
const env = (preset: string) => {
  const r = resolveEnvironment({ extends: `preset:${preset}` }, registry);
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.env;
};
const item = (path: string) => ({ id: path, name: path, assets: [{ path, role: "image" }], dataKind: "" });

describe("a plugin with only plugin.yaml and contributions.json", () => {
  it("loads and validates", () => {
    expect(problems).toEqual([]);
    expect(pkg.manifest.runtime.kind).toBe("none");
  });

  it("joins every environment while registered (ambient)", () => {
    const e = env("image-2d");
    expect(e.modules.map((m) => m.id)).toContain(fixture.id);
    expect(e.commands.map((c) => c.id)).toContain(`${fixture.id}.commands.segment`);
    expect(e.panels.right.map((p) => p.id)).toContain(`${fixture.id}.panels.summary`);
  });

  it("shows its toolbar button on PNG items and not on DICOM", () => {
    const e = env("image-2d");
    const ids = (path: string) => visibleToolbarCommands(e, item(path), {}).map((c) => c.id);
    expect(itemMediaType(item("a/b.png"))).toBe("image/png");
    expect(ids("a/b.png")).toEqual([`${fixture.id}.commands.segment`]);
    expect(ids("a/b.jpg")).toEqual([`${fixture.id}.commands.segment`]);
    expect(ids("a/b.dcm")).toEqual([]);
  });

  it("renders a named trusted renderer", async () => {
    const impl = await registry.loadModule(fixture.id);
    const Panel = impl.panels!.summary;
    const html = renderToString(createElement(Panel, { env: env("image-2d"), project: {} as never, items: [], item: undefined, config: {} }));
    expect(html).toContain("agent-declarative-panel");
  });

  it("fails closed on renderers outside the trusted registry", async () => {
    expect(unknownRenderers(pkg.contributions!)).toEqual(["acme.evil-panel.v1"]);
    const impl = await registry.loadModule(fixture.id);
    const html = renderToString(createElement(impl.panels!.unknown, { env: env("image-2d"), project: {} as never, items: [], item: undefined, config: {} }));
    expect(html).toContain("renderer-unavailable");
    expect(html).not.toContain("<script");
  });
});
