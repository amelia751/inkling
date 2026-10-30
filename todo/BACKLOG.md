# Backlog

Open items from finished plans, one line each. The plans themselves are in `todo/done/`; each
line links back to the section that explains it. Take an item by moving it into a new plan
(or a PR description) and deleting it here.

## CI and the first GitHub run
- First CI run on GitHub (`ci.yml`, `images.yml` and `e2e.yml` are written but have never run; nothing is pushed). It covers the schema, registry and contract drift checks and the plugin, isolation and builder e2e tests. [todo3 F](done/todo3.md#whats-left), [todo2 Phase 4/6](done/todo2.md#whats-left)
- Run `make check-generated` for `apps/versioning` in CI's `go` job. [todo4 Phase 4](done/todo4.md#whats-left)
- `apps/versioning` lint needs `golangci-lint`; CI installs it, local machines may not. [todo3](done/todo3.md#whats-left)

## Kubernetes
- Done-when 4: a kind or k3d run following `docs/running.md`, then `tests/e2e/versioning/chaos_test.py` against it (today a documented skip). [todo3](done/todo3.md#whats-left), [todo4 Phase 6/7](done/todo4.md#whats-left)

## Plugins
- Add Meta's `meta-sam-parser` (0.1.0, SAM License) to `plugins/segmentation/uv.lock` after a dependency and licence review; until then `meta.sam` refuses before the billable call. [todo2 Phase 6](done/todo2.md#whats-left)
- Fork an existing plugin into the build sandbox (preference step 4); needs a kernel route that serves a package's files. [todo2 Phase 9](done/todo2.md#whats-left)
- Publish `studio-plugin-sdk` to an internal index so the worker can install generated `python-worker` plugins from the artifact store. [todo2 Phase 9](done/todo2.md#whats-left)
- Plugin-build sandbox on Daytona tiers 1–2 keeps the org's default network (no egress rules); it has no bash, only file tools and `run_plugin_checks`. [todo2 Phase 9](done/todo2.md#whats-left)
- Plugin-contributed `diffPreview`s (mask, span) through module manifests; only the built-in box/polygon preview is registered. [todo4 Phase 6](done/todo4.md#whats-left)

## Versioning
- Complete and record the `LOAD_ENTRIES=1000000` load run in `apps/versioning/README.md` (100k is recorded; run it alone, with more Docker memory). [todo4 Phase 3/7](done/todo4.md#whats-left)
- Write `docs/adr/0002-versioning-storage.md`. [todo4 Phase 5](done/todo4.md#whats-left)

## Observability
- Daytona `otelEnabled` / OTLP export from `apps/agent`, and pi-telemetry contracts once they're stable. [todo3 E.4](done/todo3.md#e4-shared-conventions-every-service), from [todo1 §9](done/todo1.md#9-observability-and-cost)

## Repo hygiene
- Delete the merged worktrees and branches (`conv-*`, `wip/main-daytona`, `todo3-monorepo`, `.worktrees/*`, `.claude/worktrees/agent-*`). Tracked in [todo5 1.2](todo5.md#12-branches-and-worktrees-ask-the-user-first-none-of-these-are-on-main).
