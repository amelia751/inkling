import { labelNames } from "@studio/contracts/environment";
import { mediaTypeOf } from "@studio/contracts/media-types";
import type { StudioItem } from "@studio/contracts/types";
import { assetUrl, runtimeFor, useHost, visibleFor, type ResolvedEnv } from "@studio/plugin-ui-sdk";
import { VIEWER_MAX_ASSET_BYTES, VIEWER_TOOLS, type ViewerState } from "@studio/plugin-ui-sdk/viewer";
import { resolveLabelColor } from "@studio/plugin-ui-sdk/labels";
import { toolGeometries, vetProposals } from "../agent-panels/bridge";
import { registry } from "../registry";
import type { CallToolResult } from "./bridge-host";

/**
 * The Studio's answers to a sandboxed View's `tools/call` (packages/plugin-ui-sdk/src/viewer.ts):
 * read the current item's assets, read and publish its runtime values, list its annotations
 * and propose typed geometries. Everything is scoped to the item on screen; proposals are
 * vetted (known label, accepted geometry type, plain values) and land as `ai-suggested`.
 */

/** Runtime keys a View may publish: its own namespace only, so it can't spoof `playhead` or `volume`. */
export const VIEWER_RUNTIME_PREFIX = "viewer.";

/** Geometry types a viewer may propose: what the tools draw plus what the label groups accept. */
export function viewerGeometries(env: ResolvedEnv): Set<string> {
  const types = toolGeometries(env);
  for (const g of env.labels) {
    const c = registry.list("labelControls", (x) => x.name === g.control || x.id === g.control)[0];
    c?.geometries.forEach((t) => types.add(t));
  }
  return types;
}

export function viewerState(env: ResolvedEnv, item: StudioItem | undefined, config: Record<string, unknown>): ViewerState {
  const all = labelNames(env.labels);
  // Resolved colours: the View can't read the Studio's CSS variables.
  const labels = env.labels.flatMap((g) => labelNames([g]).map((name) => ({ name, group: g.name, color: resolveLabelColor(all, name) })));
  return {
    item: item && { id: item.id, name: item.name, assets: item.assets.filter((a) => a.role !== "thumbnail").map((a) => ({ path: a.path, mediaType: mediaTypeOf(a.path), bytes: a.bytes })) },
    labels,
    geometries: [...viewerGeometries(env)],
    config,
  };
}

const ok = (structuredContent: Record<string, unknown>, text = "ok"): CallToolResult => ({ content: [{ type: "text", text }], structuredContent });
const err = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function viewerTools(opts: { env: () => ResolvedEnv; item: () => StudioItem | undefined; author: string; onProposed?: (added: number, rejected: number) => void }) {
  return async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    const item = opts.item();
    const env = opts.env();
    switch (name) {
      case VIEWER_TOOLS.readAsset: {
        const path = typeof args.path === "string" ? args.path : "";
        const asset = item?.assets.find((a) => a.path === path);
        if (!asset) return err("not an asset of the current item");
        const res = await fetch(assetUrl(asset.path));
        if (!res.ok) return err(`asset unavailable (${res.status})`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > VIEWER_MAX_ASSET_BYTES) return err("asset too large for a sandboxed viewer");
        return { content: [{ type: "resource", resource: { uri: `asset:${encodeURIComponent(asset.path)}`, mimeType: mediaTypeOf(asset.path), blob: base64(bytes) } }] };
      }
      case VIEWER_TOOLS.listAnnotations: {
        const s = useHost.getState();
        return ok({ item: item && { id: item.id, name: item.name }, annotations: item ? visibleFor(s.annotations, item.id, s.hiddenLabels) : [] });
      }
      case VIEWER_TOOLS.proposeAnnotations: {
        if (!item) return ok({ added: 0, rejected: ["no item open"] });
        const { ok: good, rejected } = vetProposals(args.annotations, env, viewerGeometries(env));
        const now = new Date().toISOString();
        if (good.length) useHost.getState().addMany(good.map((p) => ({ ...p, id: crypto.randomUUID(), itemId: item.id, provenance: "ai-suggested" as const, author: opts.author, createdAt: now })));
        opts.onProposed?.(good.length, rejected.length);
        return ok({ added: good.length, rejected });
      }
      case VIEWER_TOOLS.getRuntime: {
        if (!item || typeof args.key !== "string") return ok({ value: null });
        const v = runtimeFor(item.id).get(args.key);
        // Plain JSON only (runtime values can hold functions, e.g. image2d.controls).
        return ok({ value: v === undefined ? null : JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "function" ? undefined : x)) ?? "null") });
      }
      case VIEWER_TOOLS.publishRuntime: {
        const key = typeof args.key === "string" ? args.key : "";
        if (!item || !key.startsWith(VIEWER_RUNTIME_PREFIX) || key.length > 80) return err(`viewers publish only ${VIEWER_RUNTIME_PREFIX}* keys`);
        if (JSON.stringify(args.value ?? null).length > 100_000) return err("value too large");
        runtimeFor(item.id).publish(key, args.value ?? null);
        return ok({});
      }
      default:
        return err(`unknown tool ${name}`);
    }
  };
}
