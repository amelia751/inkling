#!/usr/bin/env node
// `pnpm mcp`: an MCP server (stdio) that lets an outside agent (Claude Code, Cursor…)
// inspect and boot Studio environments. It talks to a running Studio dev server over its
// HTTP API, so every edit is validated by the app's own registry and resolver,
// saved with author `agent:mcp`, and picked up by the Studio on reload.
//
//   <envPrefix>URL=http://localhost:5173 node apps/web/scripts/mcp.mjs
//   claude mcp add <resourcePrefix> -- node /abs/path/apps/web/scripts/mcp.mjs
// Names (env vars, server name, copy) come from schemas/naming.json (`pnpm emit:schemas`).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";

const NAMING = JSON.parse(readFileSync(new URL("../../../schemas/naming.json", import.meta.url), "utf8"));
const env = (name) => process.env[`${NAMING.envPrefix}${name}`];

const BASE = (env("URL") ?? "http://localhost:5173").replace(/\/$/, "");
const AUTHOR = env("AGENT_AUTHOR") ?? "agent:mcp";

async function http(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const PATCH = {
  type: "array",
  description: "RFC 6902 JSON Patch against the project's stored environment (`source` from get_environment)",
  items: obj({ op: { type: "string", enum: ["add", "remove", "replace", "move", "copy", "test"] }, path: { type: "string" }, from: { type: "string" }, value: {} }, ["op", "path"]),
};

const TOOLS = [
  { name: "list_projects", description: `Datasets in this ${NAMING.displayName} workspace with their environment presets.`, inputSchema: obj({}) },
  { name: "catalog", description: "Markdown catalogue of every module and contribution id (data kinds, renderers, tools, panels, exporters, label controls, presets). Read this before writing an environment.", inputSchema: obj({}) },
  { name: "list_modules", description: "Registered modules with versions and descriptions.", inputSchema: obj({}) },
  {
    name: "describe_contribution",
    description: "One contribution's catalogue entry: description, config JSON Schema, example snippet, consumes/creates/accepts.",
    inputSchema: obj({ id: { type: "string", description: "Full id <module>.<type>.<name>" } }, ["id"]),
  },
  {
    name: "get_environment",
    description: "A project's environment: `source` (what patches apply to), its saved revision and the merged (`resolved`) form.",
    inputSchema: obj({ projectId: { type: "string" } }, ["projectId"]),
  },
  {
    name: "validate_environment",
    description: "Resolve an environment spec without saving it; returns structured errors ({path, code, message, suggestion}) or the merged spec.",
    inputSchema: obj({ spec: { type: "object" } }, ["spec"]),
  },
  {
    name: "patch_environment",
    description: "Apply a JSON Patch to a project's environment. Validated first; nothing is saved on error. The Studio shows it on its next load of the project.",
    inputSchema: obj({ projectId: { type: "string" }, patch: PATCH }, ["projectId", "patch"]),
  },
  {
    name: "set_environment",
    description: "Replace a project's environment with a complete spec (validated first). Use to boot a brand-new environment for a dataset.",
    inputSchema: obj({ projectId: { type: "string" }, spec: { type: "object" } }, ["projectId", "spec"]),
  },
];

async function call(name, args) {
  switch (name) {
    case "list_projects": {
      const r = await http("GET", "/seed/manifest.json");
      if (!r.ok) return r;
      return { ok: true, data: r.data.projects.map((p) => ({ id: p.id, title: p.title, status: p.status, environment: p.environment?.extends ?? p.viewer, items: p.assets?.length })) };
    }
    case "catalog":
      return http("GET", "/api/catalog/prompt");
    case "list_modules": {
      const r = await http("GET", "/api/catalog");
      return r.ok ? { ok: true, data: r.data.modules } : r;
    }
    case "describe_contribution": {
      const r = await http("GET", "/api/catalog");
      if (!r.ok) return r;
      const id = String(args.id ?? "");
      const hit = r.data.contributions.find((c) => c.id === id || (c.type === "presets" && `preset:${c.id.split(".").pop()}` === id));
      return hit ? { ok: true, data: hit } : { ok: false, data: { error: `Unknown contribution "${id}"` } };
    }
    case "get_environment": {
      const r = await http("GET", `/api/environments/${encodeURIComponent(args.projectId)}`);
      if (!r.ok) return r;
      const v = await http("POST", "/api/environments/validate", r.data.effective);
      return { ok: true, data: { revision: r.data.revision, source: r.data.effective, resolved: v.data.resolved, errors: v.data.errors } };
    }
    case "validate_environment":
      return http("POST", "/api/environments/validate", args.spec);
    case "patch_environment":
      return http("PATCH", `/api/environments/${encodeURIComponent(args.projectId)}`, { patch: args.patch, author: AUTHOR });
    case "set_environment":
      return http("PUT", `/api/environments/${encodeURIComponent(args.projectId)}`, { environment: args.spec, author: AUTHOR });
    default:
      return { ok: false, data: { error: `Unknown tool "${name}"` } };
  }
}

const server = new Server({ name: NAMING.resourcePrefix, version: "1.0.0" }, { capabilities: { tools: {} }, instructions: `${NAMING.displayName} Studio environments: read `catalog`, then get_environment / validate_environment / patch_environment. Fix errors using their path and suggestion.` });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const r = await call(req.params.name, req.params.arguments ?? {});
    const text = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
    return { content: [{ type: "text", text }], isError: !r.ok };
  } catch (e) {
    return { content: [{ type: "text", text: `${NAMING.displayName} dev server unreachable at ${BASE}: ${e instanceof Error ? e.message : e}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
