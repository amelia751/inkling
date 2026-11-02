import { describe, expect, it } from "vitest";
import type { EnvironmentSpec } from "@studio/contracts";
import type { ResolvedEnv } from "@studio/plugin-ui-sdk/resolved";
import { activeProfile, envForProfile, FILE_VIEW, type Lookup } from "./active-profile";

const r = (id: string, space = "image2d") => ({ id, name: id.split(".").pop()!, module: "m", kind: "renderers", space, capabilities: [], consumes: [] }) as never;
const t = (id: string) => ({ id, name: id, module: "m", kind: "tools" }) as never;
const p = (id: string) => ({ id, name: id, module: "m", kind: "panels" }) as never;

const RENDERERS: Record<string, unknown> = { "r.image": r("r.image"), "r.ecg": r("r.ecg", "signal"), "r.trace": r("r.trace", "signal") };
const TOOLS: Record<string, unknown> = { box: t("box"), span: t("span") };
const PANELS: Record<string, unknown> = { items: p("items"), leads: p("leads") };
const lookup: Lookup = { get: ((type: string, id: string) => (type === "renderers" ? RENDERERS : type === "tools" ? TOOLS : PANELS)[id]) as Lookup["get"] };

function env(spec: EnvironmentSpec): ResolvedEnv {
  return {
    spec,
    dataKind: { id: "k.image" },
    viewports: [{ name: "main", renderer: RENDERERS["r.image"], config: { merged: true } }],
    tools: [TOOLS.box],
    panels: { left: [PANELS.items], right: [], bottom: [], "viewport-bar": [] },
    context: { section: "studio", renderer: "r.image", dataKind: "k.image" },
  } as unknown as ResolvedEnv;
}

const mixed = env({
  data: { kind: "k.image", kinds: { "k.ecg": { renderer: "r.ecg", config: { leads: 12 }, tools: ["span"], panels: { left: ["items", "leads"] } } } },
  viewports: [{ name: "main", renderer: "r.image" }],
});

describe("activeProfile", () => {
  it("picks the item's kind profile", () => {
    expect(activeProfile(mixed, { dataKind: "k.ecg" })).toMatchObject({ key: "k.ecg", kind: "k.ecg", profile: { renderer: "r.ecg" } });
  });
  it("falls back to the environment's kind for an item without one (the one-kind shorthand)", () => {
    expect(activeProfile(mixed, {})).toMatchObject({ key: "k.image", kind: "k.image", profile: { renderer: "r.image" } });
  });
  it("an unmapped kind opens the file view", () => {
    expect(activeProfile(mixed, { dataKind: "k.video" })).toEqual({ key: FILE_VIEW, kind: "k.video", profile: undefined });
  });
  it("items of the same kind share a key (the renderer stays mounted)", () => {
    expect(activeProfile(mixed, { dataKind: "k.ecg" }).key).toBe(activeProfile(mixed, { dataKind: "k.ecg" }).key);
  });
});

describe("envForProfile", () => {
  it("keeps the environment's resolved viewports, tools and panels for its own kind", () => {
    const e = envForProfile(mixed, activeProfile(mixed, {}), lookup);
    expect(e.viewports).toBe(mixed.viewports);
    expect(e.tools).toBe(mixed.tools);
    expect(e.panels).toBe(mixed.panels);
    expect(e.showFileView).toBe(false);
    expect(e.context).toMatchObject({ renderer: "r.image", "item.kind": "k.image", "item.profile": "k.image" });
  });
  it("uses the profile's renderer, config, tools and panels for another kind", () => {
    const e = envForProfile(mixed, activeProfile(mixed, { dataKind: "k.ecg" }), lookup);
    expect(e.viewports.map((v) => [v.name, v.renderer.id, v.config])).toEqual([["main", "r.ecg", { leads: 12 }]]);
    expect(e.tools.map((x) => x.id)).toEqual(["span"]);
    expect(e.panels.left.map((x) => x.id)).toEqual(["items", "leads"]);
    expect(e.panels.right).toEqual([]);
    expect(e.context).toMatchObject({ renderer: "r.ecg", "renderer.space": "signal", "item.kind": "k.ecg" });
  });
  it("profile.viewports win over renderer/config", () => {
    const spec: EnvironmentSpec = { data: { kinds: { "k.ecg": { renderer: "r.ecg", viewports: [{ name: "a", renderer: "r.ecg" }, { name: "b", renderer: "r.trace" }] } } } };
    const e = envForProfile(env(spec), activeProfile(env(spec), { dataKind: "k.ecg" }), lookup);
    expect(e.viewports.map((v) => v.renderer.id)).toEqual(["r.ecg", "r.trace"]);
  });
  it("an unmapped kind (or an unknown renderer) has no viewports or tools: the file view", () => {
    for (const kind of ["k.video", "k.bad"]) {
      const spec: EnvironmentSpec = { ...mixed.spec, data: { ...mixed.spec.data, kinds: { ...mixed.spec.data!.kinds, "k.bad": { renderer: "r.missing" } } } };
      const e = envForProfile(env(spec), activeProfile(env(spec), { dataKind: kind }), lookup);
      expect(e.showFileView).toBe(true);
      expect(e.viewports).toEqual([]);
      expect(e.tools).toEqual([]);
      expect(e.panels).toEqual(mixed.panels);
      expect(e.context).toMatchObject({ renderer: undefined, "item.kind": kind });
    }
  });
});

describe("commands scoped per profile", () => {
  it("the same key binds per renderer: `when` sees the profile's renderer and item.kind", async () => {
    const { when } = await import("@/extension-host/when");
    const image = envForProfile(mixed, activeProfile(mixed, {}), lookup).context;
    const ecg = envForProfile(mixed, activeProfile(mixed, { dataKind: "k.ecg" }), lookup).context;
    expect([when("renderer == 'r.ecg'", image), when("renderer == 'r.ecg'", ecg)]).toEqual([false, true]);
    expect([when("item.kind == 'k.image'", image), when("item.kind == 'k.image'", ecg)]).toEqual([true, false]);
  });
});
