import { createElement, Suspense } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bindHost, HostProvider, type HostListener, type StudioHost, type StudioHostState } from "@studio/plugin-ui-sdk";
import { MODULES } from "./bundled";
import { registry } from "./registry";
import { resolveEnvironment } from "./resolve";
import { studioHost } from "./host";

/**
 * Plugins depend only on the SDK (todo/done/todo2.md §1.6): with a hand-written host (a plain
 * object store, no Zustand, no shell imports), every plugin's renderers and panels render.
 */
function fakeHost(): StudioHost {
  const noop = () => {};
  let state = {
    projectId: "p", itemIndex: 0, tool: "select", toolOptions: {}, outlineOnly: false, env: null, envPast: [], envFuture: [],
    activeLabel: "a", annotations: [], revision: 0, dirty: false, saveState: "idle", past: [], future: [], aiOpen: false,
    viewerStatus: "", selectedId: null, selectedIds: [], hiddenLabels: [], lockedLabels: [], overlayOpacity: 1,
  } as unknown as StudioHostState;
  const listeners = new Set<HostListener>();
  const set = (patch: Partial<StudioHostState>) => {
    const prev = state;
    state = { ...state, ...patch };
    listeners.forEach((l) => l(state, prev));
  };
  state = new Proxy(state, { get: (t, k) => (k in t ? t[k as keyof StudioHostState] : noop) });
  return {
    store: { getState: () => state, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) },
    assetUrl: (p) => `/fake/${p}`,
    useCommands: noop,
    useHotkeys: noop,
    execute: () => false,
    registerCommand: () => noop,
    commandDef: () => undefined,
    commandId: (n) => n,
    describeGeometry: (a) => a.geometry.type,
    inspectRows: () => [],
    resolveSpec: (spec) => resolveEnvironment(spec, registry),
    // Not part of the contract; lets the test drive state.
    ...({ set } as object),
  };
}

const PLUGINS = MODULES.filter((m) => m.load && !m.id.endsWith(".core") && !m.id.endsWith(".presets"));

describe("plugins against a fake host", () => {
  it.each(PLUGINS.map((m) => [m.id, m] as const))("%s renders inside a fake host", { timeout: 30_000 }, async (_id, m) => {
    const host = fakeHost();
    bindHost(host);
    try {
      const impl = await registry.loadModule(m.id);
      const preset = registry.list("presets").find((p) => {
        const r = resolveEnvironment({ extends: `preset:${p.name}` }, registry);
        return r.env?.modules.some((x) => x.id === m.id);
      });
      const env = preset ? resolveEnvironment({ extends: `preset:${preset.name}` }, registry).env : undefined;
      const item = { id: "item", name: "item", assets: [{ path: "x.png", role: "image" }], dataKind: env?.dataKind.id ?? "" };
      const project = { id: "p", title: "P", assets: item.assets, environment: {}, labels: [], status: "available", source: "", license: "" };
      const components = [...Object.entries(impl.renderers ?? {}), ...Object.entries(impl.panels ?? {})];
      // Export-only plugins (DICOM export) have nothing to render; their exporters must load.
      if (!components.length) expect(Object.keys(impl.exporters ?? {}).length).toBeGreaterThan(0);
      for (const [name, C] of components) {
        const viewport = env?.viewports[0];
        const props = { env, viewport, project, item, items: [item], config: {}, runtime: { publish: () => {}, get: () => undefined } };
        let html = "";
        expect(() => (html = renderToString(createElement(HostProvider, { host }, createElement(Suspense, { fallback: null }, createElement(C as never, props as never))))), `${m.id} ${name}`).not.toThrow();
        expect(typeof html).toBe("string");
      }
    } finally {
      bindHost(studioHost);
    }
  });
});
