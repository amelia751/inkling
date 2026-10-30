# @inkling/agent

Inkling's agent runtime: a [pi](https://github.com/earendil-works/pi) session per chat, with code tools running in a per-session [Daytona](https://www.daytona.io/docs) sandbox, exposed as a private HTTP/SSE service on `127.0.0.1:8100`. The plan behind it is `todo/todo1.md`.

## Run

```sh
pnpm install                                   # pnpm fetches Node 24 for this package (devEngines.runtime)
pnpm --filter @inkling/agent exec node -v      # v24.x
pnpm agent                                     # dev server with reload
```

Keys come from `secrets/*.env` in dev (see `secrets/README.md`) or the real environment; a key already exported in your shell wins. Startup logs which keys are present and their last 3 characters, never values. `secrets/agent.env` (the bearer token the Vite proxy sends) is generated on first start.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | Hono routes, bearer auth, SSE (`Last-Event-ID` replay), periodic sweeper |
| `src/protocol.ts` | Wire types shared with `apps/web` (types only) |
| `src/agent/` | pi session factory (no disk discovery), model runtime, profiles, prompts |
| `src/tools/sandbox.ts` | pi's bash/read/write/edit/ls/find/grep re-pointed at Daytona, plus `run_python`, `preview_url`, `export_artifact` |
| `src/tools/client.ts` | Browser-executed tools: request on the event feed, result via POST |
| `src/tools/policy.ts` | Approval matrix and budgets, applied through pi's `tool_call` hook |
| `src/sandbox/` | Daytona client, lifecycle manager, exec/streaming, snapshot, sweeper |
| `src/runtime/` | Sessions, run state machine, event projection, approvals |

Profiles: `assistant` (card tools), `environment-designer` (+ environment tools from the browser), `coder` (+ sandbox tools). The browser picks a profile by name and can only register tools that profile allows.

## Sandboxes

- One sandbox per session, created lazily on the first sandbox tool call, named `inkling-<env>-<session>` and labelled `app=inkling, env, session, project, owner, profile`. Labels are what the sweeper selects on.
- Private (`public: false`), auto-stop after 15 idle minutes, archive after 1 day, delete after 7 days, and a hard `ttlMinutes` cap (24 h by default). Settings are in `.env.example`.
- If a sandbox stopped, tools restart it and retry once. If it's gone, they raise `SandboxUnavailableError`. **Tools never fall back to the host.**
- `bash` streams through a Daytona session, so output is incremental and abort or timeout really kill the command. Internal file checks use one-shot `executeCommand`.
- Preview links are signed and per-port (`getSignedPreviewUrl`). The standard preview token unlocks every port, so it is never used.
- Snapshot: `pnpm --filter @inkling/agent snapshot` builds `inkling-agent-<hash>` from `sandbox-image/requirements.txt`. Until it's active, sandboxes use Daytona's default image (with a warning) rather than blocking a chat.
- Clean up: `pnpm --filter @inkling/agent sweep -- --env test --label test=live` (dry run), then add `--stop` or `--delete`.

## Test

```sh
pnpm agent:test                                # unit: no network (FakeSandbox, projection, policy, HTTP)
pnpm agent:live                                # real Daytona: one sandbox labelled test=live, deleted in afterAll
pnpm --filter @inkling/agent smoke             # pi + model + Daytona end to end (~$0.01)
```

The live suite refuses to run if more than 3 leftover `test=live` sandboxes exist.
