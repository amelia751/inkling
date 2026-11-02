# secrets/

Local development secrets. Everything in this folder is git-ignored except this README and `*.example` templates.

| File | Keys | Used by |
|---|---|---|
| `daytona.env` | `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET` | `apps/agent` sandboxes |
| `models.env` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, optional `INKLING_AGENT_MODEL` (`provider:model` from the allowlist); see `models.env.example` | `apps/agent` model runtime. `pnpm dev` runs the agent `scripted` unless `INKLING_AGENT_MODEL` is set here or in the shell (todo15 D6; `docs/running.md`, "Real model") |
| `agent.env` | `INKLING_AGENT_TOKEN` | Vite proxy → `apps/agent` bearer auth (generated on first start if missing; the proxy reads it too) |
| `workos.env` | `INKLING_API_WORKOS_API_KEY`, `INKLING_API_WORKOS_COOKIE_PASSWORD`, `INKLING_API_WORKOS_CLIENT_ID`, `INKLING_MCP_API_KEY`; optional `INKLING_API_AUTH_MODE`, `…_REDIRECT_URI`, `…_ISSUER`, `…_BASE_URL`, `INKLING_API_PUBLIC_URL`, `INKLING_AGENT_AUTH_MODE`, `INKLING_AGENT_WORKOS_*`; see `workos.env.example` | `apps/api` sign-in (todo9; `secrets/api.env` wins over it), `apps/agent`; `apps/mcp` reads only its process env (pass the key in the MCP client's `env`). WorkOS **staging** keys only (`sk_test_…`); Emulate needs none (`docs/running.md`, "Signing in"). `pnpm dev:signin` loads it into api, web and agent in `workos` mode ("Sign in locally") |
| `versioning.env` | `VERSIONING_*` (with the naming config's env prefix), see `versioning.env.example` | `apps/versioning`: Postgres role, object-store endpoint and bucket credentials, JWT public key |

How it's loaded: `apps/agent/src/secrets.ts` reads every `secrets/*.env` (`KEY=VALUE`, `#` comments) when `INKLING_ENV` is not `production`, and **never overrides** a variable already set in the real environment. Production reads only the real environment or a secret manager. `pnpm dev` / `pnpm dev:signin` (`tools/dev.mjs`) read the same files to choose the agent model and, for `dev:signin`, pass `workos.env` to Vite, which reads only its process env.

Env-var names (one scheme for every service; `INKLING_` is the naming config's `envPrefix`):

- `INKLING_<ROLE>_<KEY>` for a setting a service owns (`INKLING_AGENT_MODEL`, `INKLING_API_DATABASE_URL`, `INKLING_WORKER_PLUGINS`, `INKLING_VERSIONING_DATABASE_URL`);
- `INKLING_<ROLE>_URL` / `INKLING_<ROLE>_TOKEN` for how other services reach it (`INKLING_API_URL`, `INKLING_AGENT_URL`, `INKLING_AGENT_TOKEN`);
- `INKLING_ENV` (`development|test|production`) and `INKLING_LOG_LEVEL` / `INKLING_LOG_FORMAT`, shared by every service;
- unprefixed only for third-party standards (`DAYTONA_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `OTEL_*`) and `NAMING_FILE`, which can't carry the prefix because the prefix is read from it.

Each service reads them in one module (its `config`), checked by `node tools/check-names.mjs`. After a rename, `node tools/migrate-env.mjs` rewrites the key names in your local `secrets/*.env` in place (it never prints values).

Rules:

- Never commit, paste, or log values. Logs show only which keys are present and their last 3 characters.
- Never pass these into a sandbox (`envVars`). Sandbox code that needs a credential uses Daytona Secrets, which only expose a placeholder inside the sandbox.
- Rotate the Daytona key in the Daytona dashboard (Keys), then update `daytona.env`.

To run without sandboxes even though `daytona.env` exists, start the service with `INKLING_AGENT_SANDBOX=off`. A value exported as an empty string does not block a key from these files.
