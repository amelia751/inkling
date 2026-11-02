# apps/mcp

An MCP server that lets an outside agent (Claude Code, Cursor…) work in projects and inspect and
boot Studio environments. It calls the API over HTTP, so every write goes through the API's own
checks (admission, the project's rules, revisions) under the caller's identity. Two transports:

- **stdio** (local): `pnpm mcp`; the API sees `<envPrefix>MCP_API_KEY` / `<envPrefix>MCP_PERSON_TOKEN`.
- **streamable HTTP** (remote, `studio-mcp`, todo17 D12): `pnpm mcp:http` (or
  `<envPrefix>MCP_TRANSPORT=http`); stateless (a fresh server per request), so any replica answers.

```sh
pnpm mcp                                   # from the repo root, stdio
claude mcp add <resourcePrefix> -- pnpm --dir /abs/path/to/repo mcp
pnpm mcp:http                              # http://127.0.0.1:8300/mcp
claude mcp add --transport http <resourcePrefix> http://127.0.0.1:8300/mcp
```

## Tools

- `project_context` comes first (todo17 D9): rules, open findings, what's published, how to add data.
  Also the resource `studio://projects/{projectId}/context`.
- One tool per operation in the catalogue (`packages/contracts/src/operations.ts` →
  `schemas/operations.json`), named after it (`dataset_create`). `readOnlyHint` / `destructiveHint` /
  `idempotentHint` come from the tier (hints for clients' confirm screens only). Writes take
  `dryRun` (the API runs every check, saves nothing); every write sends an `Idempotency-Key` (a uuid
  per call, the same on its retries after a network error or 502/503/504); updates to versioned
  resources (`REVISIONED` in `src/operations.ts`, or the catalogue's `revision.get`) send the
  revision you passed, else the current one. Destroy needs `confirm: true`.
- A rejected write (RFC 9457 problem JSON) comes back as a tool error listing every violation with
  its fix inline; a 202 with a change request reads "Opened change request …".
- The environment and catalogue tools below are unchanged.

## Remote: OAuth, scopes, limits (todo17 D12)

`/mcp` (POST only) needs `Authorization: Bearer <token>`. The server is an OAuth resource server:
`/.well-known/oauth-protected-resource[/mcp]` names the authorization server (WorkOS AuthKit:
dynamic client registration, PKCE) and the scopes `project:read|write|trash|destroy`,
`rules:propose`. Without a usable token: 401 with
`WWW-Authenticate: Bearer resource_metadata="…", scope="…"`. The token is forwarded to the API,
which verifies it (signature, audience, revocation); the server asks the API once per request
(`GET /api/v1/projects`), so a revoked token gets 401 on its next call. A JWT that is expired or
bound to another audience is refused without asking; one whose `scope` lacks the tool's tier
scope gets 403 `insufficient_scope` (step-up). `/healthz`, `/readyz`, `/version` as every service.

Per token (sha-256, never the token itself): `MCP_RATE_LIMIT_PER_MIN` calls a minute and
`MCP_WRITE_QUOTA_PER_DAY` writes a day (dry runs don't count); past either, 429 with `Retry-After`.
Counters live in Redis (`MCP_REDIS_URL`); without it they're in process memory, which is **not
replica-safe** (each replica counts on its own): local dev and tests only. If Redis is down the
server keeps serving and `/readyz` says so.

The MCP Apps viewers (below) are stdio-only for now: their app-only asset tool serves only files a
view tool opened in the same session, which a stateless request doesn't have.

| Key (`<envPrefix>…`) | Default | Meaning |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `http` for the remote server (`--http` does the same) |
| `MCP_HOST`, `MCP_PORT` | `127.0.0.1`, `8300` | HTTP listen address |
| `MCP_PUBLIC_URL` | `http://<host>:<port>/mcp` | Public URL of the endpoint: the OAuth resource and token audience |
| `MCP_AUTH_SERVER` | — | Authorization server (the AuthKit domain) in the metadata |
| `MCP_RATE_LIMIT_PER_MIN` | `120` | Calls per token per minute (0: off) |
| `MCP_WRITE_QUOTA_PER_DAY` | `5000` | Writes per token per day (0: off) |
| `MCP_REDIS_URL`, `MCP_REDIS_CA_FILE` | — | Redis for the counters; CA for `rediss://` (Memorystore) |

Deploy: `apps/mcp/Dockerfile` (`studio-mcp`, HTTP on 8300), `infra/k8s/base/mcp` (Deployment,
Service, HPA, PDB), `/mcp` and `/.well-known/oauth-protected-resource` on the Studio ingress,
NetworkPolicy `mcp` (ingress controller in; api and Redis out). `tests/e2e/mcp_remote_test.py`
drives it with a scripted client.

## Environments and catalogue

Env vars use the naming config's `envPrefix` (`schemas/naming.json`): `<envPrefix>MCP_STUDIO_URL`
(environments, catalogue, seeds; default the api's dev URL `http://127.0.0.1:8000`; `<envPrefix>WEB_URL`
is still honoured, and `list_capabilities` / `inspect_plugin` need it: the api answers 501),
`<envPrefix>MCP_AUTHOR`. `patch_environment` / `set_environment` send the `revision` you edited
(fetched when omitted); a stale one comes back as a conflict error.

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
this session, from `<Studio URL>/seed/`. Outside the Studio viewers are read-only.
`<envPrefix>API_URL` is the kernel (default: the Studio URL above).

`test/apps-host/` is a minimal MCP Apps host built on the official SDK (MCP client +
`@modelcontextprotocol/ext-apps` AppBridge, the reference sandbox proxy); `tests/e2e/mcp_apps_host_test.py`
drives it in Chromium.
