/**
 * Viewer SDK (todo10 Phase 5, ladder rung 4): a sandboxed custom viewer is one ESM module with
 * anywidget's shape,
 *
 *   export default { render({ model, el, signal, host }) { … } }      // or `export function render`
 *
 * It runs in an MCP Apps View: an iframe behind a sandbox proxy on a separate origin
 * (`studio.sandbox-frame.v1`, apps/web/public/sandbox-proxy.html), with no network, no storage
 * and no access to the Studio. It talks to its host only over the MCP Apps JSON-RPC bridge
 * (`ui/initialize`, `ui/notifications/tool-input|tool-result`, `tools/call`), so the same
 * document renders in the Studio and in any MCP Apps host (apps/mcp serves it as a
 * `ui://` resource).
 *
 * `host` is everything a viewer may ask for:
 *   - `readAsset(path)`: the bytes of one of the current item's assets (read only);
 *   - `runtime.get(key)` / `runtime.publish(key, value)`: the item's runtime values;
 *   - `annotations.list()` / `annotations.propose([{ label, geometry, attributes }])`: typed
 *     geometries (`@studio/contracts` types), vetted by the host and stored as `ai-suggested`;
 *     a viewer never writes the annotation document itself.
 *
 * This file has no React and no DOM dependency: the runtime is a string the host inlines.
 */
import type { Annotation, Geometry } from "@studio/contracts/types";

/** MCP Apps protocol version the runtime speaks (modelcontextprotocol/ext-apps, stable 2026-01-26). */
export const MCP_APPS_PROTOCOL = "2026-01-26";
/** MIME type of an MCP Apps HTML resource. */
export const MCP_APP_MIME = "text/html;profile=mcp-app";

/** Host tools a viewer calls with `tools/call`. Outside the Studio they are app-only MCP tools (`_meta.ui.visibility: ["app"]`). */
export const VIEWER_TOOLS = {
  readAsset: "viewer_read_asset",
  listAnnotations: "viewer_list_annotations",
  proposeAnnotations: "viewer_propose_annotations",
  getRuntime: "viewer_get_runtime",
  publishRuntime: "viewer_publish_runtime",
} as const;
export type ViewerToolName = (typeof VIEWER_TOOLS)[keyof typeof VIEWER_TOOLS];

/** Largest asset `readAsset` returns (base64 in a JSON-RPC message). */
export const VIEWER_MAX_ASSET_BYTES = 64 * 1024 * 1024;

export interface ViewerAsset {
  path: string;
  mediaType: string;
  bytes?: number;
}

/** The item a viewer shows: `model.get("item")`. */
export interface ViewerItem {
  id: string;
  name: string;
  assets: ViewerAsset[];
}

/** What the host sends as the tool result's `structuredContent` (merged into the model). */
export interface ViewerState {
  item?: ViewerItem;
  /** Label names (with colours) the viewer may propose. */
  labels?: { name: string; color?: string; group?: string }[];
  /** Geometry types the host accepts from this viewer. */
  geometries?: string[];
  /** The renderer config from the environment (schema-free for sandboxed viewers). */
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/** anywidget-style model: the host's state for this view. */
export interface ViewerModel {
  get<K extends keyof ViewerState>(key: K): ViewerState[K];
  set<K extends keyof ViewerState>(key: K, value: ViewerState[K]): void;
  on(event: `change:${string}` | "change", cb: (value: unknown) => void): void;
  off(event: `change:${string}` | "change", cb?: (value: unknown) => void): void;
}

export interface ProposedAnnotation {
  label: string;
  geometry: Geometry;
  attributes?: Annotation["attributes"];
}

export interface ViewerHost {
  item(): ViewerItem | undefined;
  readAsset(path: string): Promise<Uint8Array>;
  annotations: {
    list(): Promise<Annotation[]>;
    propose(list: ProposedAnnotation[]): Promise<{ added: number; rejected: string[] }>;
  };
  runtime: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    publish(key: string, value: unknown): Promise<void>;
  };
  /** Ask the host for a height (the runtime also reports size changes on its own). */
  resize(height: number): void;
  /** Host context from `ui/initialize` (theme, locale, container size). */
  context(): Record<string, unknown>;
}

export interface ViewerRenderContext {
  model: ViewerModel;
  el: HTMLElement;
  /** Aborted when the item changes or the view is torn down. */
  signal: AbortSignal;
  host: ViewerHost;
}

/** A rung-4 viewer module. `render` may return a cleanup function. */
export interface ViewerModule {
  initialize?(ctx: { model: ViewerModel; host: ViewerHost }): void | Promise<void>;
  render(ctx: ViewerRenderContext): void | (() => void) | Promise<void | (() => void)>;
}

/** Identity helper for authors writing viewers in TypeScript. */
export const defineViewer = (m: ViewerModule): ViewerModule => m;

/**
 * Inner document CSP (on top of the proxy's header, which the srcdoc frame inherits): inline
 * runtime, the viewer module from a blob: URL, data:/blob: images and media. No network.
 */
export const VIEWER_CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The View side of the bridge, inlined into every viewer document. Plain ES2020, no imports:
 * a JSON-RPC 2.0 client over `postMessage` to `parent` (the sandbox proxy relays to the host),
 * the anywidget model, and the `host` object above.
 */
export const VIEWER_RUNTIME = String.raw`(() => {
  "use strict";
  const PROTOCOL = ${JSON.stringify(MCP_APPS_PROTOCOL)};
  const TOOLS = ${JSON.stringify(VIEWER_TOOLS)};
  let seq = 0, ctrl = null, cleanup = null, hostContext = {}, rendered = false;
  const pending = new Map(), listeners = new Map(), state = {};
  const send = (msg) => parent.postMessage(Object.assign({ jsonrpc: "2.0" }, msg), "*");
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); send({ id, method, params }); });
  const notify = (method, params) => send({ method, params: params || {} });
  const emit = (ev, v) => (listeners.get(ev) || []).slice().forEach((cb) => { try { cb(v); } catch (e) { console.error(e); } });
  const model = {
    get: (k) => state[k],
    set: (k, v) => { state[k] = v; emit("change:" + k, v); emit("change", { [k]: v }); },
    on: (ev, cb) => { listeners.set(ev, (listeners.get(ev) || []).concat(cb)); },
    off: (ev, cb) => { listeners.set(ev, cb ? (listeners.get(ev) || []).filter((x) => x !== cb) : []); },
    save_changes: () => {},
  };
  const b64 = (s) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  const text = (r) => ((r && r.content) || []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
  async function call(name, args) {
    const r = await request("tools/call", { name, arguments: args || {} });
    if (r && r.isError) throw new Error(text(r) || name + " failed");
    return r || {};
  }
  const host = {
    item: () => state.item,
    async readAsset(path) {
      const r = await call(TOOLS.readAsset, { path });
      const res = (r.content || []).find((c) => c.type === "resource" && c.resource && typeof c.resource.blob === "string");
      if (!res) throw new Error("no bytes for " + path);
      return b64(res.resource.blob);
    },
    annotations: {
      list: async () => ((await call(TOOLS.listAnnotations, {})).structuredContent || {}).annotations || [],
      propose: async (list) => (await call(TOOLS.proposeAnnotations, { annotations: list })).structuredContent || { added: 0, rejected: [] },
    },
    runtime: {
      get: async (key) => ((await call(TOOLS.getRuntime, { key })).structuredContent || {}).value,
      publish: async (key, value) => { await call(TOOLS.publishRuntime, { key, value }); },
    },
    resize: (height) => notify("ui/notifications/size-changed", { height: Math.ceil(height) }),
    context: () => hostContext,
  };
  const root = document.getElementById("viewer-root");
  function fail(where, err) {
    const p = document.createElement("p");
    p.setAttribute("role", "alert"); p.dataset.viewerError = where;
    p.textContent = "Viewer error (" + where + "): " + (err && err.message ? err.message : String(err));
    root.replaceChildren(p);
    notify("notifications/message", { level: "error", logger: "viewer", data: { where, error: String(err && err.message ? err.message : err).slice(0, 500) } });
  }
  let modPromise = null;
  function loadModule() {
    if (modPromise) return modPromise;
    const src = JSON.parse(document.getElementById("viewer-module").textContent || '""');
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    modPromise = import(url).then(async (m) => {
      const def = m.default && typeof m.default === "object" ? m.default : {};
      const mod = { render: m.render || def.render || (typeof m.default === "function" ? m.default : undefined), initialize: m.initialize || def.initialize };
      if (typeof mod.render !== "function") throw new Error("the module exports no render()");
      if (mod.initialize) await mod.initialize({ model, host });
      return mod;
    });
    return modPromise;
  }
  async function render() {
    if (!state.item) return;
    if (ctrl) ctrl.abort();
    const c = (ctrl = new AbortController());
    if (cleanup) { try { await cleanup(); } catch (e) { console.error(e); } cleanup = null; }
    root.replaceChildren();
    let mod;
    try { mod = await loadModule(); } catch (e) { return fail("load", e); }
    if (c.signal.aborted) return;
    try {
      const r = await mod.render({ model, el: root, signal: c.signal, host });
      if (typeof r === "function") cleanup = r;
      rendered = true;
      document.documentElement.dataset.viewerRendered = state.item.id;
    } catch (e) { fail("render", e); }
  }
  function applyTheme(ctx) {
    const vars = ctx && ctx.styles && ctx.styles.variables;
    if (vars) for (const [k, v] of Object.entries(vars)) if (v) document.documentElement.style.setProperty(k, v);
    if (ctx && ctx.theme) document.documentElement.dataset.theme = ctx.theme;
  }
  function merge(next) {
    if (!next || typeof next !== "object") return;
    const itemChanged = next.item && (!state.item || next.item.id !== state.item.id);
    for (const [k, v] of Object.entries(next)) model.set(k, v);
    if (itemChanged || !rendered) render();
  }
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined && m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      return m.error ? p.reject(new Error(m.error.message || "error")) : p.resolve(m.result);
    }
    if (m.id !== undefined) {
      if (m.method === "ui/resource-teardown") {
        if (ctrl) ctrl.abort();
        Promise.resolve(cleanup && cleanup()).finally(() => send({ id: m.id, result: {} }));
      } else if (m.method === "ping") send({ id: m.id, result: {} });
      else send({ id: m.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    const params = m.params || {};
    if (m.method === "ui/notifications/tool-input") model.set("toolInput", params.arguments || {});
    else if (m.method === "ui/notifications/tool-result") merge(params.structuredContent);
    else if (m.method === "ui/notifications/host-context-changed") { Object.assign(hostContext, params); applyTheme(params); model.set("hostContext", hostContext); }
    else if (m.method === "ui/notifications/tool-cancelled") fail("cancelled", params.reason || "cancelled");
  });
  new ResizeObserver(() => host.resize(document.documentElement.scrollHeight)).observe(document.documentElement);
  request("ui/initialize", { appInfo: { name: document.title || "viewer", version: "1.0.0" }, appCapabilities: { availableDisplayModes: ["inline"] }, protocolVersion: PROTOCOL })
    .then((r) => {
      hostContext = (r && r.hostContext) || {};
      applyTheme(hostContext);
      notify("ui/notifications/initialized", {});
      document.documentElement.dataset.viewerConnected = (r && r.hostInfo && r.hostInfo.name) || "host";
    })
    .catch((e) => fail("initialize", e));
})();`;

/** The document template; `{{title}}` and `{{module}}` are filled by `viewerDocument`. */
export const VIEWER_TEMPLATE = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VIEWER_CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{{title}}</title>
<style>html,body{margin:0;padding:0;background:var(--color-background-primary,#fff);color:var(--color-text-primary,#111);font:13px/1.4 var(--font-sans,system-ui,sans-serif)}#viewer-root{min-height:120px}[data-viewer-error]{color:#b00020;padding:12px}</style>
</head><body><div id="viewer-root"></div>
<script type="application/json" id="viewer-module">{{module}}</script>
<script>${VIEWER_RUNTIME}</script>
</body></html>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A complete MCP Apps View document for one viewer module (its ESM source). */
export function viewerDocument(opts: { source: string; title: string }): string {
  const module = JSON.stringify(opts.source).replace(/</g, "\\u003c");
  return VIEWER_TEMPLATE.replace("{{title}}", () => escapeHtml(opts.title)).replace("{{module}}", () => module);
}
