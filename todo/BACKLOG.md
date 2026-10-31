# Backlog

Open items from finished plans, one line each. The plans themselves are in `todo/done/`; each
line links back to the section that explains it. Take an item by moving it into a new plan
(or a PR description) and deleting it here.

## CI and the first GitHub run
- First CI run on GitHub (`ci.yml`, `images.yml` and `e2e.yml` are written but have never run; nothing is pushed). It covers the schema, registry and contract drift checks and the plugin, isolation and builder e2e tests. [todo3 F](done/todo3.md#whats-left), [todo2 Phase 4/6](done/todo2.md#whats-left)
- Run `make check-generated` for `apps/versioning` in CI's `go` job. [todo4 Phase 4](done/todo4.md#whats-left)
- `apps/versioning` lint needs `golangci-lint`; CI installs it, local machines may not. [todo3](done/todo3.md#whats-left)

## Projects, sources and Explore (todo6)
- Cross-project Datasets index (datasets are only listed inside their project). [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Expand archives: a ZIP or TAR is kept as one file in P0; add an "Expand archive" action that imports its contents as a new source. [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Connectors: an S3 bucket and PACS/DICOMweb (via Orthanc) as sources (`sources.kind = connector` exists, nothing creates one). [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Relationships graph view in Explore (P0 is the list). [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Schema mapping for many-field tables (P0 maps one categorical column to label classes). [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Assistant write tools beyond proposals: create a collection or task behind an approval card. [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Review status per item ("13 of 20 reviewed"); Overview shows only "annotated" today. [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Members and roles UI (`organization_members` has roles; Settings › Members is a placeholder; the workspace switcher has one personal org). [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Version comparison in Activity (Activity links to versions; the diff stays on the Versions page). [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Mobile parity: phones get the shell drawer and a "larger screen" notice in the Studio, not a phone layout. [todo6 Phase 10](done/todo6.md#phase-10-leave-the-rest-on-the-backlog)
- Presigned S3 `PUT` (multipart above 64 MB) for uploads; today every upload goes through the API in ≤ 64 MB chunks. [todo6 Phase 1](done/todo6.md#phase-1-domain-model-and-api-backend-first-no-ui-change)
- Run migration `0004`'s Postgres branch (named constraints) against Postgres; only SQLite upgrade/downgrade was checked. [todo6 Phase 1](done/todo6.md#phase-1-domain-model-and-api-backend-first-no-ui-change)

## Files (todo7)
- Shared links to a file or folder (today a link opens only for project members). [todo7 Phase 9](todo7.md#phase-9-verification-and-docs)
- A column view in Files (Finder), next to list and grid. [todo7 Phase 9](todo7.md#phase-9-verification-and-docs)
- Drag files out of Files to the desktop (Chrome `DownloadURL` on `dragstart`). [todo7 Phase 9](todo7.md#phase-9-verification-and-docs)
- Folder colors. [todo7 Phase 9](todo7.md#phase-9-verification-and-docs)
- Comments on a file. [todo7 Phase 9](todo7.md#phase-9-verification-and-docs)
- Connectors that keep a remote folder in sync with a folder in Files. [todo7 Phase 9](todo7.md#phase-9-verification-and-docs)

## Studio (todo8)
- A focus mode: hide the header and both panels, keep the toolbar and decision bar (e.g. on `⌘.`). [todo8 §8](todo8.md#8-not-now-backlog-candidates)
- ⌘K command palette over commands, items and tasks (there is none; ⋯ and `?` cover the gap). [todo8 §8](todo8.md#8-not-now-backlog-candidates)
- A first-run tour, only if people don't find the decision bar or the Queue (tooltips with keys and the `? Shortcuts` hint should be enough). [todo8 §8](todo8.md#8-not-now-backlog-candidates)
- Per-person toolbar customisation (pinning a folded tool); Task setup covers the owner's case. [todo8 §8](todo8.md#8-not-now-backlog-candidates)

## Kubernetes
- Done-when 4: a kind or k3d run following `docs/running.md`, then `tests/e2e/versioning/chaos_test.py` against it (today a documented skip). [todo3](done/todo3.md#whats-left), [todo4 Phase 6/7](done/todo4.md#whats-left)

## Plugins
- Add Meta's `meta-sam-parser` (0.1.0, SAM License) to `plugins/segmentation/uv.lock` after a dependency and licence review; until then `meta.sam` refuses before the billable call. [todo2 Phase 6](done/todo2.md#whats-left)
- Fork an existing plugin into the build sandbox (preference step 4); needs a kernel route that serves a package's files. [todo2 Phase 9](done/todo2.md#whats-left)
- Publish `studio-plugin-sdk` to an internal index so the worker can install generated `python-worker` plugins from the artifact store. [todo2 Phase 9](done/todo2.md#whats-left)
- Plugin-build sandbox on Daytona tiers 1–2 keeps the org's default network (no egress rules); it has no bash, only file tools and `run_plugin_checks`. [todo2 Phase 9](done/todo2.md#whats-left)
- Plugin-contributed `diffPreview`s (mask, span) through module manifests; only the built-in box/polygon preview is registered. [todo4 Phase 6](done/todo4.md#whats-left)

## Versioning
- Complete and record the `INKLING_VERSIONING_LOAD_ENTRIES=1000000` load run in `apps/versioning/README.md` (100k is recorded; run it alone, with more Docker memory). [todo4 Phase 3/7](done/todo4.md#whats-left)
- Write `docs/adr/0002-versioning-storage.md`. [todo4 Phase 5](done/todo4.md#whats-left)

## Observability
- Daytona `otelEnabled` / OTLP export from `apps/agent`, and pi-telemetry contracts once they're stable. [todo3 E.4](done/todo3.md#e4-shared-conventions-every-service), from [todo1 §9](done/todo1.md#9-observability-and-cost)

## Repo hygiene
- Decide on `wip/main-daytona` (one commit not on `main`: the pre-restructure WIP, ported selectively); every other merged branch and worktree is gone. [todo5 1.2](todo5.md#12-branches-and-worktrees-ask-the-user-first-none-of-these-are-on-main)
