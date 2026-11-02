// Sandboxed viewers as MCP Apps (todo10 Phase 5): every rung-4 viewer active in a workspace
// (a `renderers` entry on studio.sandbox-frame.v1 with an ESM `config.module`) becomes
//   - a UI resource `ui://<resourcePrefix>/viewers/<pluginId>/<renderer>` (text/html;profile=mcp-app),
//     the same View document the Studio renders (schemas/viewer-runtime.v1.json), and
//   - a tool `view_<plugin>__<renderer>` whose `_meta.ui.resourceUri` points at it,
// so the viewer renders in any MCP Apps host (Claude, ChatGPT, the ext-apps reference host).
// The View's host tools (`viewer_read_asset`…) are app-only (`_meta.ui.visibility: ["app"]`):
// their results go to the View, never into the model's context. Outside the Studio a viewer is
// read-only: proposals are refused.
import { readFileSync } from "node:fs";

type Json = Record<string, any>;
export interface ToolResult {
  content: Json[];
  structuredContent?: Json;
  isError?: boolean;
}

const VIEWER: { protocolVersion: string; mimeType: string; tools: Record<string, string>; template: string } = JSON.parse(
  readFileSync(new URL("../../../schemas/viewer-runtime.v1.json", import.meta.url), "utf8"),
);
const SANDBOX_FRAME = "studio.sandbox-frame.v1";
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

const MEDIA: [RegExp, string][] = [
  [/\.ply$/i, "application/x-ply"],
  [/\.png$/i, "image/png"],
  [/\.jpe?g$/i, "image/jpeg"],
  [/\.nii(\.gz)?$/i, "application/x-nifti"],
  [/\.json$/i, "application/json"],
  [/\.csv$/i, "text/csv"],
];
const mediaTypeOf = (p: string) => MEDIA.find(([re]) => re.test(p))?.[1] ?? "application/octet-stream";
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The same document as viewerDocument() in packages/plugin-ui-sdk/src/viewer.ts. */
export function viewerDocument(source: string, title: string): string {
  return VIEWER.template.replace("{{title}}", () => escapeHtml(title)).replace("{{module}}", () => JSON.stringify(source).replace(/</g, "\\u003c"));
}

export interface Viewer {
  pluginId: string;
  version: string;
  renderer: string;
  title: string;
  description: string;
  module: string;
  uri: string;
  tool: string;
}

export function createViewers(opts: { prefix: string; displayName: string; apiBase: string; webBase: string; workspace?: string; auth?: Record<string, string> }) {
  const headers: Record<string, string> = { ...opts.auth, ...(opts.workspace ? { "X-Workspace-Id": opts.workspace } : {}) };
  const get = async (url: string) => {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json() as Promise<Json>;
  };
  let cache: { at: number; list: Viewer[] } | null = null;
  // Files a view tool opened in this session: the only ones viewer_read_asset serves.
  const opened = new Set<string>();

  /** Viewers of the workspace's active plugins (kernel Workspace API + plugin manifests). */
  async function list(): Promise<Viewer[]> {
    if (!opts.workspace) return [];
    if (cache && Date.now() - cache.at < 5000) return cache.list;
    const state = await get(`${opts.apiBase}/api/v1/workspaces/${encodeURIComponent(opts.workspace)}/state`);
    const out: Viewer[] = [];
    for (const p of state.plugins ?? []) {
      if (p.state !== "ACTIVATED") continue;
      const body = await get(`${opts.apiBase}/api/v1/plugins/${encodeURIComponent(p.pluginId)}?version=${encodeURIComponent(p.version)}`).catch(() => null);
      for (const r of body?.contributions?.renderers ?? []) {
        if (r.renderer !== SANDBOX_FRAME || typeof r.config?.module !== "string" || !r.config.module) continue;
        const slug = `${p.pluginId}__${r.id}`.replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
        out.push({
          pluginId: p.pluginId,
          version: p.version,
          renderer: r.id,
          title: r.title ?? r.config.title ?? r.id,
          description: r.description ?? `${p.pluginId} viewer`,
          module: r.config.module,
          uri: `ui://${opts.prefix}/viewers/${p.pluginId}/${r.id}`,
          tool: `view_${slug}`.slice(0, 64),
        });
      }
    }
    cache = { at: Date.now(), list: out };
    return out;
  }

  const appOnly = { ui: { visibility: ["app"] } };
  const obj = (properties: Json, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

  async function tools(): Promise<Json[]> {
    const viewers = await list().catch(() => []);
    if (!viewers.length) return [];
    return [
      ...viewers.map((v) => ({
        name: v.tool,
        title: v.title,
        description: `Open a file in the sandboxed "${v.title}" viewer (${v.pluginId}@${v.version}): ${v.description}. Shows it to the user; returns only the file's name.`,
        inputSchema: obj({ path: { type: "string", description: `Asset path as served by the ${opts.displayName} Studio under /seed/` } }, ["path"]),
        _meta: { ui: { resourceUri: v.uri }, "ui/resourceUri": v.uri },
      })),
      { name: VIEWER.tools.readAsset, description: "Bytes of the file a viewer shows (app-only).", inputSchema: obj({ path: { type: "string" } }, ["path"]), _meta: appOnly },
      { name: VIEWER.tools.listAnnotations, description: "Annotations of the file a viewer shows (app-only; none outside the Studio).", inputSchema: obj({}), _meta: appOnly },
      { name: VIEWER.tools.proposeAnnotations, description: "Refused outside the Studio (app-only).", inputSchema: obj({ annotations: { type: "array" } }), _meta: appOnly },
      { name: VIEWER.tools.getRuntime, description: "Runtime value for the file (app-only).", inputSchema: obj({ key: { type: "string" } }, ["key"]), _meta: appOnly },
      { name: VIEWER.tools.publishRuntime, description: "Publish a runtime value (app-only; ignored outside the Studio).", inputSchema: obj({ key: { type: "string" }, value: {} }, ["key"]), _meta: appOnly },
    ];
  }

  async function resources(): Promise<Json[]> {
    return (await list().catch(() => [])).map((v) => ({ uri: v.uri, name: v.title, description: v.description, mimeType: VIEWER.mimeType }));
  }

  async function read(uri: string): Promise<Json | null> {
    const v = (await list()).find((x) => x.uri === uri);
    if (!v) return null;
    // No network for the View: no connect or resource domains declared.
    return { contents: [{ uri, mimeType: VIEWER.mimeType, text: viewerDocument(v.module, v.title), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } } }] };
  }

  const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });
  const safePath = (p: unknown) => (typeof p === "string" && /^[\w./-]+$/.test(p) && !p.split("/").includes("..") ? p : null);

  /** Handle a viewer tool; null when `name` isn't one. */
  async function call(name: string, args: Json): Promise<ToolResult | null> {
    if (name.startsWith("view_")) {
      const v = (await list()).find((x) => x.tool === name);
      if (!v) return null;
      const path = safePath(args.path);
      if (!path) return text("path must be a plain relative asset path", true);
      const fileName = path.split("/").pop()!;
      opened.add(path);
      return {
        content: [{ type: "text", text: `Showing ${fileName} in ${v.title}.` }],
        structuredContent: { item: { id: path, name: fileName, assets: [{ path, mediaType: mediaTypeOf(path) }] }, labels: [], geometries: [], config: { title: v.title } },
      };
    }
    switch (name) {
      case VIEWER.tools.readAsset: {
        const path = safePath(args.path);
        if (!path || !opened.has(path)) return text("not a file opened in a viewer", true);
        const r = await fetch(`${opts.webBase}/seed/${path}`, { headers });
        if (!r.ok) return text(`asset unavailable (${r.status})`, true);
        const bytes = Buffer.from(await r.arrayBuffer());
        if (bytes.length > MAX_ASSET_BYTES) return text("asset too large", true);
        return { content: [{ type: "resource", resource: { uri: `asset:${encodeURIComponent(path)}`, mimeType: mediaTypeOf(path), blob: bytes.toString("base64") } }] };
      }
      case VIEWER.tools.listAnnotations:
        return { content: [{ type: "text", text: "[]" }], structuredContent: { annotations: [] } };
      case VIEWER.tools.proposeAnnotations:
        return { content: [{ type: "text", text: "read-only outside the Studio" }], structuredContent: { added: 0, rejected: ["annotations can only be added in the Studio"] } };
      case VIEWER.tools.getRuntime:
        return { content: [{ type: "text", text: "null" }], structuredContent: { value: null } };
      case VIEWER.tools.publishRuntime:
        return { content: [{ type: "text", text: "ok" }], structuredContent: {} };
    }
    return null;
  }

  return { list, tools, resources, read, call };
}
