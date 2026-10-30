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
