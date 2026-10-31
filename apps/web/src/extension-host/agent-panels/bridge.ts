import { labelNames } from "@studio/contracts/environment";
import type { ResolvedEnv } from "@/extension-host/resolve";
import type { Annotation, Geometry, StudioItem } from "@studio/contracts/types";
import type { STORE_SELECTORS } from "./manifest";
import { RES } from "@studio/contracts/naming";
import type { StudioHostState } from "@studio/plugin-ui-sdk";
import { MCP_APPS_PROTOCOL, VIEWER_TOOLS } from "@studio/plugin-ui-sdk/viewer";

/** Pure logic of the agent panels, kept apart from React so it can be tested. */

export type Selector = (typeof STORE_SELECTORS)[number];

export function selectValue(sel: Selector, s: Pick<StudioHostState, "annotations" | "selectedIds" | "activeLabel" | "tool">, items: StudioItem[], item: StudioItem | undefined): unknown {
  switch (sel) {
    case "annotations.count":
      return s.annotations.length;
    case "annotations.item":
      return item ? s.annotations.filter((a) => a.itemId === item.id).length : 0;
    case "items.total":
      return items.length;
    case "items.annotated": {
      const ids = new Set(items.map((i) => i.id));
      return new Set(s.annotations.map((a) => a.itemId).filter((id) => ids.has(id))).size;
    }
    case "selection.count":
      return s.selectedIds.length;
    case "activeLabel":
      return s.activeLabel ?? "";
    case "tool":
      return s.tool;
    case "labels.counts": {
      const out: Record<string, number> = {};
      for (const a of s.annotations) out[a.label] = (out[a.label] ?? 0) + 1;
      return out;
    }
  }
}

export interface Proposal {
  label: string;
  geometry: Geometry;
  attributes?: Annotation["attributes"];
}

const MAX_PROPOSALS = 500;

/**
 * Check what a sandboxed tool proposes before anything reaches the store: known label,
 * a geometry type this environment has, plain JSON only, bounded size. Rejections are
 * reported back to the sandbox, never thrown.
 */
/** Geometry types this environment's tools could have drawn (plus item classes if it has Choices). */
export function toolGeometries(env: ResolvedEnv): Set<string> {
  const types = new Set(env.tools.map((t) => t.creates).filter((t): t is string => !!t));
  if (env.labels.some((g) => g.control === "Choices")) types.add("class");
  return types;
}

export function vetProposals(raw: unknown, env: ResolvedEnv, types: Set<string> = toolGeometries(env)): { ok: Proposal[]; rejected: string[] } {
  const ok: Proposal[] = [], rejected: string[] = [];
  if (!Array.isArray(raw)) return { ok, rejected: ["expected an array of { label, geometry }"] };
  const labels = new Set(labelNames(env.labels));
  raw.slice(0, MAX_PROPOSALS).forEach((p, i) => {
    const where = `#${i}`;
    if (!p || typeof p !== "object") return rejected.push(`${where}: not an object`);
    const { label, geometry, attributes } = p as Record<string, unknown>;
    if (typeof label !== "string" || !labels.has(label)) return rejected.push(`${where}: unknown label ${JSON.stringify(label)}`);
    const g = geometry as Geometry | undefined;
    if (!g || typeof g !== "object" || typeof g.type !== "string" || !types.has(g.type)) return rejected.push(`${where}: geometry type ${JSON.stringify(g?.type)} isn't in this environment`);
    if (JSON.stringify(g).length > 200_000) return rejected.push(`${where}: geometry too large`);
    const attrs = attributes && typeof attributes === "object" ? Object.fromEntries(Object.entries(attributes).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))) : undefined;
    ok.push({ label, geometry: JSON.parse(JSON.stringify(g)), attributes: attrs as Annotation["attributes"] });
  });
  if (raw.length > MAX_PROPOSALS) rejected.push(`only the first ${MAX_PROPOSALS} proposals were read`);
  return { ok, rejected };
}

/**
 * Prepended to every tier-3 sandbox document: a CSP that blocks all network access (so
 * annotations can't leave the machine; only inline script/style and data:/blob: images run),
 * then `window.inkling`, kept as the agent-facing API but carried over the MCP Apps bridge
 * (todo10 Phase 5): `ui/initialize`, then `tools/call` to the viewer tools
 * (`viewer_list_annotations`, `viewer_propose_annotations`); the item arrives as a tool result
 * and is re-dispatched as the `inkling:item` event.
 */
export const SANDBOX_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;
export const BRIDGE_SCRIPT = SANDBOX_CSP + `<script>
(() => {
  let seq = 0, item = null, ready;
  const waiting = new Map();
  const send = (m) => parent.postMessage(Object.assign({ jsonrpc: "2.0" }, m), "*");
  const request = (method, params) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); send({ id, method, params }); });
  addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== parent || !m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); return m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result); }
    if (m.method === "ui/notifications/tool-result") {
      const next = (m.params && m.params.structuredContent && m.params.structuredContent.item) || null;
      item = next && { id: next.id, name: next.name };
      dispatchEvent(new CustomEvent("${RES}:item", { detail: item }));
    }
  });
  ready = request("ui/initialize", { appInfo: { name: "sandboxed-tool", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "${MCP_APPS_PROTOCOL}" }).then(() => send({ method: "ui/notifications/initialized", params: {} }));
  const call = async (name, args) => { await ready; const r = await request("tools/call", { name, arguments: args }); return r.structuredContent || {}; };
  window.${RES} = {
    getAnnotations: async () => { const r = await call("${VIEWER_TOOLS.listAnnotations}", {}); return { item: r.item || item, annotations: r.annotations || [] }; },
    propose: (annotations) => call("${VIEWER_TOOLS.proposeAnnotations}", { annotations }),
  };
})();
</script>`;
