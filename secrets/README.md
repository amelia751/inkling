# secrets/

Local development secrets. Everything in this folder is git-ignored except this README and `*.example` templates.

| File | Keys | Used by |
|---|---|---|
| `daytona.env` | `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET` | `apps/agent` sandboxes |
| `models.env` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | `apps/agent` model runtime |
| `agent.env` | `INTERNAL_AGENT_SERVICE_TOKEN` | Vite proxy → `apps/agent` bearer auth (generated on first start if missing; the proxy reads it too) |

How it's loaded: `apps/agent/src/secrets.ts` reads every `secrets/*.env` (`KEY=VALUE`, `#` comments) when `APP_ENV` is not `production`, and **never overrides** a variable already set in the real environment. Production reads only the real environment or a secret manager.

Rules:

- Never commit, paste, or log values. Logs show only which keys are present and their last 3 characters.
- Never pass these into a sandbox (`envVars`). Sandbox code that needs a credential uses Daytona Secrets, which only expose a placeholder inside the sandbox.
- Rotate the Daytona key in the Daytona dashboard (Keys), then update `daytona.env`. The current key was copied from `jetrun/kiwi/cloud/.env.local`; rotating it affects that project too.

To run without sandboxes even though `daytona.env` exists, start the service with `AGENT_SANDBOX=off`. A value exported as an empty string does not block a key from these files.
