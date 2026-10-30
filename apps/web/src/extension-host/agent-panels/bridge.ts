import { labelNames } from "@studio/contracts/environment";
import type { ResolvedEnv } from "@/extension-host/resolve";
import type { Annotation, Geometry, StudioItem } from "@studio/contracts/types";
import type { STORE_SELECTORS } from "./manifest";
import { RES } from "@studio/contracts/naming";
import type { StudioHostState } from "@studio/plugin-ui-sdk";

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
export function vetProposals(raw: unknown, env: ResolvedEnv): { ok: Proposal[]; rejected: string[] } {
  const ok: Proposal[] = [], rejected: string[] = [];
  if (!Array.isArray(raw)) return { ok, rejected: ["expected an array of { label, geometry }"] };
  const labels = new Set(labelNames(env.labels));
  // Only what this environment's tools could have drawn (plus item classes if it has Choices).
  const types = new Set(env.tools.map((t) => t.creates).filter((t): t is string => !!t));
  if (env.labels.some((g) => g.control === "Choices")) types.add("class");
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
 * Prepended to every sandbox document: a CSP that blocks all network access (so annotations
 * can't leave the machine; only inline script/style and data:/blob: images run), then the
 * `window.inkling` bridge over postMessage.
 */
export const SANDBOX_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;
export const BRIDGE_SCRIPT = SANDBOX_CSP + `<script>
(() => {
  let seq = 0; const waiting = new Map();
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    const { reply, type, payload } = e.data;
    if (reply !== undefined && waiting.has(reply)) { waiting.get(reply)(payload); waiting.delete(reply); return; }
    if (type === "${RES}:item") dispatchEvent(new CustomEvent("${RES}:item", { detail: payload }));
  });
  const ask = (type, payload) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); parent.postMessage({ id, type, payload }, "*"); });
  window.${RES} = {
    getAnnotations: () => ask("${RES}:getAnnotations"),
    propose: (annotations) => ask("${RES}:propose", annotations),
  };
})();
</script>`;
