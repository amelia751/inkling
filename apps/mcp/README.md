# apps/mcp

An MCP server (stdio) that lets an outside agent (Claude Code, Cursor…) inspect and boot Studio
environments. It calls a running Studio over HTTP, so every edit is validated by the app's own
registry and resolver and saved with author `agent:mcp`.

```sh
pnpm mcp                                   # from the repo root; talks to http://localhost:5173
claude mcp add <resourcePrefix> -- pnpm --dir /abs/path/to/repo mcp
```

Env vars use the naming config's `envPrefix` (`schemas/naming.json`): `<envPrefix>WEB_URL`,
`<envPrefix>MCP_AUTHOR`.

The catalogue and environment routes (`/api/catalog`, `/api/environments`) are still served by
the web dev server (`apps/web/dev/seed-server.ts`). When `apps/api` serves them, point
`<envPrefix>URL` at it; nothing here imports another app (`tools/check-boundaries.mjs`).

## Sandboxed viewers as MCP Apps (todo10 Phase 5)

With `<envPrefix>MCP_WORKSPACE` set, every active rung-4 viewer in that workspace (a
`renderers` entry on `studio.sandbox-frame.v1` with an ESM `config.module`) is served as an
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) UI resource
(`ui://<resourcePrefix>/viewers/<pluginId>/<renderer>`, `text/html;profile=mcp-app`, the same
document the Studio renders: `schemas/viewer-runtime.v1.json`) plus a `view_<plugin>__<renderer>`
tool pointing at it. The View's host tools (`viewer_read_asset`, …) are app-only, so file bytes
never enter the model's context; `viewer_read_asset` serves only files a view tool opened in
this session, from `<envPrefix>WEB_URL/seed/`. Outside the Studio viewers are read-only.
`<envPrefix>API_URL` is the kernel (default: the web URL, which proxies `/api`).

`test/apps-host/` is a minimal MCP Apps host built on the official SDK (MCP client +
`@modelcontextprotocol/ext-apps` AppBridge, the reference sandbox proxy); `tests/e2e/mcp_apps_host_test.py`
drives it in Chromium.
