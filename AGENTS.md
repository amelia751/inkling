# Working in this repo

pnpm + uv monorepo, orchestrated by Turborepo. Deployables are `apps/*` (`web`: React 19,
Vite 7, TypeScript, zustand, Tailwind + shadcn; `api` and `worker`: Python 3.12; `agent` and
`mcp`: Node 24; `versioning`: Go). Seed data is fetched locally with `pnpm seeds` and is
gitignored. Map of the repo: `docs/README.md`; how to run it: `docs/running.md`. Words like
Studio, module, kernel, environment and workspace have one meaning each: see the
[glossary](docs/README.md#glossary).

## Layout rules

- `apps/*` are deployables: one Dockerfile, one k8s Deployment each. **Never import across
  `apps/*`**; apps talk over HTTP and events. Shared code goes in `packages/*`, which never
  import `apps/*` or `plugins/*`. Plugins live in `plugins/` (not under `apps/`).
  `node tools/check-boundaries.mjs` and `uv run lint-imports` enforce this.
- Services are stateless: state in Postgres, blobs through the `BlobStore`, queue and events
  through `JobQueue` / `EventBus` / the agent's run-event bus. Never keep request state in
  process memory or on local disk (except `/tmp`), or replicas > 1 break.
- Customer data lives only in the `spurby-phi` Google Cloud project; nothing reads it from
 `spurby-ai`, where the agent runs. No real sample or item bytes ever reach a sandbox or the model's
 context. See `docs/deployment-gcp.md`.
- Config comes only from env vars (named with the naming config's `envPrefix` in Python);
  `secrets/*.env` is a dev overlay. Every HTTP service serves `/healthz`, `/readyz`, `/version`.

## Parallel work

Several agents may work at once. Each takes its own worktree **inside** the repo, never a
sibling folder in `~`:

```sh
git worktree add .worktrees/<branch> -b <branch>    # .worktrees/ is git-ignored
git worktree remove .worktrees/<branch> && git worktree prune
```

Don't switch branches or commit in someone else's checkout.

## Checks

From the repo root: `pnpm typecheck`, `pnpm test` and `pnpm lint` (Turborepo, every
package; `pnpm affected` for only what changed vs `origin/main`), `pnpm check:boundaries`,
`pnpm check:names`, `pnpm check:python-imports`, `uv run ruff check apps packages tools tests`.

In `apps/web` before you hand work back:

- `pnpm typecheck`
- `pnpm test` (vitest unit tests: extension host, packages, plugins)
- `pnpm check:boundaries`, `pnpm check:names` and `pnpm check:icons`
- `pnpm emit:schemas --check` (fails if generated schemas are stale; run `pnpm emit:schemas`)
- e2e: start a frozen dev server with `STUDIO_E2E=1 pnpm exec vite --port 5199 --strictPort`
  (it serves annotations from a temp copy of `e2e/fixtures/annotations/`, never your
  `seed-data/.annotations`), then run `python3 e2e/<name>_test.py --port 5199`. Tests that span services (agent,
  plugin install + worker) are in `tests/e2e/`. The `data-testid`s and store fields
  those tests use are a regression contract: keep them working.

## Testing the product: drive it yourself, not through the in-house agent

**Key rule.** When you test the product (does an environment validate and boot, does a drop land in
Files, does the Studio render, does a plan apply), *you* drive it. Don't send chat messages to the
in-house agent (`apps/agent`) to do work you can do yourself; every such run costs model calls and
proves nothing about your change. Use:

- the repo's MCP server (`pnpm mcp`; `catalog`, `get_environment`, `validate_environment`,
  `patch_environment`, `set_environment`) for environments;
- the kernel's HTTP API with a dev person token (`POST …/boots`, `…/imports`, `GET …/drops/{id}`,
  …) for boots, uploads and data;
- a browser (the IDE's browser tools, or the Playwright e2e in `apps/web/e2e/` and `tests/e2e/`)
  for what a person sees.

**Testing the in-house agent itself** (its tools, policy, protocol, prompts) is the only reason to
run it, and it must be small:

- use the scripted model by default (`AGENT_MODEL=scripted` with a fixture, prefixed as usual);
  it's free and deterministic;
- a real model only when the test is about the model's behavior: one conversation, the fewest
  turns that prove the point, the smallest fixture, a cheap model from the allowlist, a hard stop
  after a few turns; never in a loop, watch mode or the default `pnpm test` (live tests stay in
  `test/live`, run by hand);
- report how many real-model runs you made and roughly what they cost in your hand-back;
- stop the agent service (and anything else you started) when you're done.

## Architecture in one paragraph

The Studio shell runs an **environment** (JSON) that references **modules** (the UI half of
a plugin, `docs/plugins.md`). First-party plugins live in `plugins/<name>/ui/` and contribute
data kinds, renderers, tools, commands, panels, inspectors, exporters, label controls,
review rules and presets. Shared building blocks (Cornerstone, overlay2d, timeline, viewport
chrome, IO) are trusted renderers in `packages/renderers`. Canonical types and the
environment schema are `packages/contracts`; what a plugin may import is
`packages/plugin-ui-sdk` (module contract, host API) and `packages/ui` (shadcn,
icons). The registry, resolver, `when` clauses, commands, catalogue and agent tools are the
**extension host** (`apps/web/src/extension-host/`); the shell is `apps/web/src/studio/`.
Read `docs/modules.md`.

## Adding a first-party plugin

1. Copy `plugins/_template/` to `plugins/<name>/`, rename its id (`ns("<name>")`, never a
   literal namespace).
2. Write `ui/manifest.ts`: pure data (types, icons, zod schemas, small pure functions such as
   `groupItems`). Every contribution gets a one-line `description`; add an `example` when
   the default one (generated by the catalogue) isn't a good snippet.
3. Put components and heavy code behind `load()` in `ui/impl.ts`.
4. Renderers get everything from `RendererProps` (`env`, `viewport`, `item`, `config`,
   `runtime`) and read and write Studio state through `useHost` from
   `@studio/plugin-ui-sdk`. Asset URLs come from `assetUrl`. Publish live values with
   `runtime.publish`, never module-level singletons.
5. Bind keys with `useCommands({ name: handler }, { scope: MODULE_ID })`; declare the command
   (keys, `when`, label) in the manifest. Never hard-code a key in a component.
6. Register the plugin in `apps/web/src/extension-host/bundled.ts` (one import, one array
   entry) and add its `@plugins/<name>/*` path to `apps/web/tsconfig.json`. A plugin with a
   Python worker keeps its own `pyproject.toml` + `uv.lock` (not a uv workspace member).
7. Add a preset (`registry/presets/<id>.json`) if it boots a Studio on its own.
8. Run `pnpm emit:schemas` and add an e2e smoke test.

## Rules

- Names are scope + role, where the role is the folder: `apps/<x>` and `packages/<x>` are
  `@studio/<x>` (Python `studio-<x>` / `studio_<x>`), `plugins/<x>` is `@studio/plugin-<x>`;
  images `studio-<x>`. Env vars are `STUDIO_<ROLE>_<KEY>` (the prefix is `NAMING.envPrefix`),
  read in each service's config module only (`secrets/README.md`). `pnpm check:names` enforces both.
- Layers (enforced by `tools/check-boundaries.mjs`): `@studio/contracts` and `@studio/ui` import
  nothing internal; `@studio/plugin-ui-sdk` only contracts; `@studio/renderers` the SDK,
  contracts and ui; plugins those plus
  other plugins' `manifest.ts` / `public.ts`; the shell never imports `@plugins/*` and
  reaches plugins only through the registry.
- Internal names are the neutral word `studio` and never follow the brand: ids `studio.<x>`,
  schemas `studio://schema/…`, resources `studio:…` / `studio-…`, env `STUDIO_…`. The product
  name (`NAMING.displayName`) and past namespaces (`legacyNamespaces`) appear in code only in
  `packages/contracts/src/naming.ts`; use `NAMING`, `ns()`, `NS` and `RES` everywhere else, and
  `NAMING.displayName` for user-visible copy. A rebrand edits `displayName` and nothing else.
- Domain constants (WFDB codes, cardiac structures, CT presets) live in module config
  defaults or preset vocabularies, never in kits or the platform.
- Core geometries are domain-neutral (`box`, `polygon`, `span`, `instant`…); domain meaning
  goes in `annotation.attributes`. Stored v1 geometries migrate on load
  (`packages/contracts/src/migrations/annotations-v1-to-v2.ts`).
- Icons come only from `@studio/ui/icons`.
- Never hand-edit generated files: `schemas/*.json`, `schemas/catalog.md`,
  `docs/modules-reference.md`. The web server serves the catalogue and environment schema from
  `schemas/` at `/catalog.json`, `/catalog.md` and `/schema/environment.v1.json`.
