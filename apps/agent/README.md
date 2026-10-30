# @inkling/agent

The Inkling AI agent service: one [pi](https://github.com/earendil-works/pi) `AgentSession` per chat, typed Inkling tools, [Daytona](https://www.daytona.io/docs/) sandboxes for code, and a replayable event feed for the Studio. Private: it listens on `127.0.0.1:8100` and only the Vite proxy (dev) or `apps/api` (later) talks to it. Design: [`agent.md`](../../agent.md); plan: [`todo/todo1.md`](../../todo/todo1.md).

## Run

```bash
pnpm install
pnpm agent                     # from the repo root: tsx watch src/main.ts
pnpm dev                       # the Studio; /api/agent/* is proxied here with the service token
```

Node: the package pins `devEngines.runtime` Node `^24` (`onFail: download`), so pnpm fetches it. Check with `pnpm --filter @inkling/agent exec node -v` (needs ≥ 22.19).

Keys come from the real environment or, outside production, `secrets/*.env` (see [`secrets/README.md`](../../secrets/README.md)):

| Key | Needed for |
|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | the model in `AGENT_MODEL` (default `openai:gpt-6.1-sol`, must be in `AGENT_MODEL_ALLOWLIST`) |
| `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET` | the `coder` profile; without them sandboxes are off |
| `INTERNAL_AGENT_SERVICE_TOKEN` | bearer auth; generated into `secrets/agent.env` on first dev start |

Other settings are in [`.env.example`](.env.example). With no model key, set `AGENT_MODEL=scripted AGENT_SCRIPT=<fixture.json>` to replay a script offline.

## Test

```bash
pnpm agent:test                                # unit + in-process HTTP tests on the scripted model, no network
pnpm --filter @inkling/agent typecheck
pnpm agent:live                                # real Daytona: one labelled sandbox, always deleted
INKLING_SNAPSHOT_LIVE=1 pnpm agent:live        # also builds/checks the snapshot (slow, manual)
pnpm --filter @inkling/agent smoke             # real model + Daytona end to end; prints tokens and cost
```

Studio e2e against this service (scripted model; the test starts the service itself on port 8299):

```bash
cd apps/web
INKLING_E2E=1 INKLING_AGENT_URL=http://127.0.0.1:8299 INTERNAL_AGENT_SERVICE_TOKEN=e2e-agent-token \
  pnpm exec vite --port 5299 --strictPort &
python3 e2e/agent_test.py --port 5299
```

## Sandboxes

```bash
pnpm --filter @inkling/agent snapshot                       # build inkling-agent-<hash> if missing (minutes)
pnpm --filter @inkling/agent sweep                          # dry run: list app=inkling sandboxes and the plan
pnpm --filter @inkling/agent sweep -- --stop                # stop idle ones
pnpm --filter @inkling/agent sweep -- --delete              # also delete orphans / past retention (max 5)
pnpm --filter @inkling/agent sweep -- --env test --label test=live --all --delete   # clear leftovers from live tests
```

The running service sweeps every 10 minutes too. Only sandboxes labelled `app=inkling` in the current env are ever touched.

## HTTP API

All `/v1/*` routes need `Authorization: Bearer <INTERNAL_AGENT_SERVICE_TOKEN>`; bodies are validated with zod.

```
GET  /health/live                         process up (no Daytona or model calls)
GET  /health/ready                        config, model key, Daytona reachable (cached 60 s), egress tier
GET  /v1/status                           { configured, provider, model, sandbox, profiles }
POST /v1/sessions                         { projectId, profile?, clientTools?, catalogPrompt?, restricted? } → 201 { sessionId }
GET  /v1/sessions/:id                     meta, active run, sandbox, artifacts
DELETE /v1/sessions/:id                   cancel, delete the sandbox and the record
POST /v1/sessions/:id/messages            { text, context?, snapshot? } → 202 { runId, steered }
GET  /v1/runs/:runId/events?after=seq     SSE; resumable with Last-Event-ID; ends after `done`
POST /v1/runs/:runId/cancel
POST /v1/runs/:runId/client-tools/:callId { ok, output }        409 if not pending
POST /v1/approvals/:approvalId            { decision: approve|reject, note? }
GET  /v1/sessions/:id/artifacts
GET  /v1/artifacts/:artifactId            download (dev only)
```

Types: [`src/protocol.ts`](src/protocol.ts) (the web app imports them as `@inkling/agent/protocol`).

## Layout

| Path | What |
|---|---|
| `src/agent/` | session factory (no host discovery, no pi built-ins), profiles, `ModelRuntime` + scripted model, prompts |
| `src/tools/` | `dataset` (server), `client` (browser bridge), `sandbox` (Daytona), `policy` (approval matrix + budgets) |
| `src/sandbox/` | Daytona client and errors, per-session manager, ops, exec, search, snapshot, sweeper, egress probe |
| `src/runtime/` | sessions (registry, JSONL in `.data/sessions/`), runs, event projection + replay buffer, approvals |
| `test/unit`, `test/live` | vitest; `test/unit/fixtures/pi-events.jsonl` is a recorded pi event stream |

## Rotating secrets

- **Daytona:** create a new key in the Daytona dashboard (Keys), update `secrets/daytona.env`, restart, then revoke the old key. The current key is shared with another project (see `secrets/README.md`).
- **Model keys:** update `secrets/models.env` (or the real env) and restart.
- **Service token:** delete `secrets/agent.env` and restart the service and the Vite dev server; a new one is generated.

## Upgrading pi or the Daytona SDK

Versions are pinned exactly. Follow the checklist in [`agent.md` §17](../../agent.md): read the changelogs, diff `createAgentSession` / `AgentSessionEvent` / `*Operations` / `ToolCallEvent`, re-record the event fixture if the stream changed, rerun unit, live, smoke and e2e, and check `@daytona/pi` for fixes worth porting (keep [`NOTICE`](NOTICE)).
