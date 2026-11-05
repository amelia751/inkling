# secrets/

Local development secrets. Everything in this folder is git-ignored except this README and `*.example` templates.

| File | Keys | Used by |
|---|---|---|
| `daytona.env` | `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET` | `apps/agent` sandboxes |
| `models.env` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, optional `STUDIO_AGENT_MODEL` (`provider:model` from the allowlist); see `models.env.example` | `apps/agent` model runtime. `pnpm dev` runs `STUDIO_AGENT_MODEL` if set, else the agent's default when a key is present, else `scripted` (todo15 D6; `README.md`, "Real model") |
| `api.env` / `agent.env` (optional) | `STUDIO_API_APPROVAL_SECRET` / `STUDIO_AGENT_APPROVAL_SECRET`, one value | the HMAC key for the assistant's signed "delete forever" approvals (todo16 D8): the agent signs, the api verifies. Unset in dev, both use the same built-in dev value (`DEV_APPROVAL_SECRET` in each config module); set both, to the same value, to test another one. Required in production (`.agents/skills/data-boundary/deployment-gcp.md`) |
| `api.env` / `agent.env` (optional) | `STUDIO_API_AGENT_SERVICE_TOKEN` / `STUDIO_AGENT_KERNEL_SERVICE_TOKEN`, one value | how the agent service calls the kernel's agent-service routes (todo21 D7: chat titles rename `Shared in chat/…` folders). Unset in dev, both use `dev-only-agent-service-token`; unset in production, the agent makes no such calls |
| `agent.env` | `STUDIO_AGENT_TOKEN` | Vite proxy → `apps/agent` bearer auth (generated on first start if missing; the proxy reads it too) |
| `workos.env` | `STUDIO_API_WORKOS_API_KEY`, `STUDIO_API_WORKOS_COOKIE_PASSWORD`, `STUDIO_API_WORKOS_CLIENT_ID`, `STUDIO_MCP_API_KEY`; optional `STUDIO_API_AUTH_MODE`, `…_REDIRECT_URI`, `…_ISSUER`, `…_BASE_URL`, `STUDIO_API_PUBLIC_URL`, `STUDIO_AGENT_AUTH_MODE`, `STUDIO_AGENT_WORKOS_*`; see `workos.env.example` | `apps/api` sign-in (todo9; `secrets/api.env` wins over it), `apps/agent`; `apps/mcp` reads only its process env (pass the key in the MCP client's `env`). WorkOS **staging** keys only (`sk_test_…`); Emulate needs none (`README.md`, "Signing in"). `pnpm dev:signin` loads it into api, web and agent in `workos` mode ("Sign in locally") |
| `google-oauth-staging.json` | Google OAuth web client (`spurby-ai` › Google Auth Platform › Clients, "WorkOS AuthKit (staging)") | Backup only: the client id and secret are entered in WorkOS Staging › Authentication › Providers › Google. Nothing in the repo reads it |
| `versioning.env` | `VERSIONING_*` (with the naming config's env prefix), see `versioning.env.example` | `apps/versioning`: Postgres role, object-store endpoint and bucket credentials, JWT public key |

How it's loaded: `apps/agent/src/secrets.ts` reads every `secrets/*.env` (`KEY=VALUE`, `#` comments) when `STUDIO_ENV` is not `production`, and **never overrides** a variable already set in the real environment. Production reads only the real environment or a secret manager. `pnpm dev` / `pnpm dev:signin` (`tools/dev.mjs`) read the same files to choose the agent model and, for `dev:signin`, pass `workos.env` to Vite, which reads only its process env.

Env-var names (one scheme for every service; `STUDIO_` is the naming config's `envPrefix`):

- `STUDIO_<ROLE>_<KEY>` for a setting a service owns (`STUDIO_AGENT_MODEL`, `STUDIO_API_DATABASE_URL`, `STUDIO_WORKER_PLUGINS`, `STUDIO_VERSIONING_DATABASE_URL`);
- `STUDIO_<ROLE>_URL` / `STUDIO_<ROLE>_TOKEN` for how other services reach it (`STUDIO_API_URL`, `STUDIO_AGENT_URL`, `STUDIO_AGENT_TOKEN`);
- `STUDIO_ENV` (`development|test|production`) and `STUDIO_LOG_LEVEL` / `STUDIO_LOG_FORMAT`, shared by every service;
- unprefixed only for third-party standards (`DAYTONA_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AWS_*`, `OTEL_*`) and `NAMING_FILE`, which can't carry the prefix because the prefix is read from it.

Each service reads them in one module (its `config`), checked by `node tools/check-names.mjs`. After a rename, `node tools/migrate-env.mjs` rewrites the key names in your local `secrets/*.env` in place (it never prints values).

Rules:

- Never commit, paste, or log values. Logs show only which keys are present and their last 3 characters.
- Never pass these into a sandbox (`envVars`). Sandbox code that needs a credential uses Daytona Secrets, which only expose a placeholder inside the sandbox.
- Rotate the Daytona key in the Daytona dashboard (Keys), then update `daytona.env`.

To run without sandboxes even though `daytona.env` exists, start the service with `STUDIO_AGENT_SANDBOX=off`. A value exported as an empty string does not block a key from these files.
