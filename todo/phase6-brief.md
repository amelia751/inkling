# Phase 6 viewer conversion — shared brief

You are converting ONE legacy viewer of the Inkling Studio into a real module, as part of
the plan in `todo/todo.md` (read section 1, phase 5 and your viewer's section 6.x in full).
Phases 0–4 are done on branch `modular-viewers`; read these to learn the platform you build on:

- `AGENTS.md` (repo root) and `docs/modules.md`: architecture, rules, how to add a module.
- `apps/web/src/platform/module.ts` (contracts: RendererProps, PanelProps, InspectFn,
  ExporterImpl, contribution types), `registry.ts`, `resolve.ts`, `commands.ts`
  (`useCommands(map, { scope: [...] })` — handler names resolve against module scopes),
  `runtime.ts` (`runtime.publish/get`, `useRuntime`), `describe.ts`.
- `apps/web/src/modules/core/` (core commands with capability `when`s, panels, geometries)
  and `apps/web/src/modules/_template/` (minimal module).
- `apps/web/src/viewers/legacy.tsx` (the shim your module currently uses — you remove it for your module).
- Kits: `kits/overlay2d/` (geometry.ts, draw.ts, shapes.ts = ShapeUtils with tests,
  scene.ts / regions.ts / transform.ts moved from pathology), `kits/viewport-chrome/`
  (bar.tsx primitives, controls.tsx: BarSegmented, BarPick, BarToggle, BarIconButton,
  BarTextButton, ToolbarButton), `kits/io/` (nifti, niftiIO, frameSource, zip, wfdb),
  `kits/cornerstone/`, `kits/timeline/manifest.ts`, `kits/tool-catalog.ts`.

## Your worktree

You work ONLY in the worktree directory given in your task (a git worktree on its own
branch, already `pnpm install`ed, seed data linked). Never touch `/Users/anhlam/inkling`
(the user's main checkout, another session is active there) or other worktrees.
Commit your work on your branch (several commits are fine). End commit messages with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't push.

## What "converted" means (definition of done)

1. All code of your viewer moves from `apps/web/src/viewers/<old>/` into
   `apps/web/src/modules/<id>/` following the phase-5 layout (manifest.ts pure data,
   public.ts if another module needs your types, impl.ts default export ModuleImpl,
   renderer/ (imperative engine + thin React host), panels/, geometries.ts, exporters.ts,
   *.test.ts, README.md with an example environment snippet). Code that is generic and useful
   to other modules goes into the matching kit instead (never put domain constants in kits).
   `viewers/<old>/` is deleted. Don't edit `viewers/legacy.tsx` or `viewers/ViewerAdapter.ts`
   (other conversions still use them) — just stop importing them from your module (import
   `Exporter`/`ExportContext` types from `@/platform/module`).
2. The renderer takes `RendererProps` (`env`, `viewport`, `project`, `item`, `config`, `runtime`).
   Module-level singletons read by inspectors are replaced by `runtime.publish(...)` and
   `ctx.runtime.get(...)` in the inspector (see todo problem F).
3. Side panels rendered inside the viewer become `panels` contributions (slot `right`,
   `left`, `bottom` or `viewport-bar`) where the todo says so, and are added to your preset
   (`apps/web/src/platform/presets/<id>.json`). If moving a panel out would break an e2e
   test's DOM expectations, keep the testids/labels identical.
4. Keys: every viewer-specific key goes through `useCommands` with the command declared in
   your manifest (labels/keys/`when`), including any raw `useHotkeys` key switch the viewer
   still has. No hard-coded keys in components (`matches(e, "...")` in a raw handler is the
   thing to remove). Keep exact behaviour (repeat, shift variants, fall-through).
5. Tools and options: per-tool options come from `optionsSchema` (`toolOption`, `brushSizeOf`,
   `useToolOption` in `stores/studio.ts`); outlineOnly is `useStudio(s => s.outlineOnly)`.
6. Geometry migration (todo phase 2) for YOUR legacy geometry types, if any: produce core
   geometries (`span`, `instant`, `keypoint`, `point3d`) with domain vocabulary in
   `annotation.attributes` exactly as `src/migrations/annotations-v1-to-v2.ts` maps them
   (including `attributes.kind`), read both only via the new form, and add your v1 types to
   your line of `MIGRATED_V1_TYPES` in `src/lib/api.ts` (edit only your line). Add a
   `geometries` contribution in your manifest that refines `describe` for your domain
   (e.g. "Beat V · 0.700s") and inspector rows. Update exporters so file outputs are
   byte-identical to before for the same data. Update e2e assertions that read stored
   geometry shapes to the new form (keep the behavioural assertions).
7. Remove your module from `apps/web/scripts/boundaries-allowlist.json` (only your line) and
   make `node scripts/check-boundaries.mjs` pass with no exceptions for your module.
8. e2e tests that `import('/src/viewers/<old>/...')` are updated to the new paths (prefer the
   registry: `(await import('/src/platform/registry.ts')).registry.loadImpl('<full id>')`
   for exporters — see `e2e/cs_helpers.py:blob_from_exporter`).
9. Unit tests (vitest, `src/**/*.test.ts`) for the pure parts you touch (engine math,
   geometry refinement, exporters where feasible).

## Checks you must run before finishing (in `apps/web` of your worktree)

- `pnpm typecheck`, `pnpm test`, `node scripts/check-boundaries.mjs`, `node scripts/check-icons.mjs`
- Do NOT run `pnpm emit:schemas` and do not commit `public/catalog*` or
  `public/schema/*` or `docs/modules-reference.md` (they're regenerated after merging).
- e2e: start your own frozen server on YOUR port:
  `INKLING_E2E=1 nohup pnpm exec vite --port <PORT> --strictPort > /tmp/../<somewhere in your worktree, gitignored e.g. apps/web/e2e/.artifacts/vite.log> 2>&1 &`
  (restart it after code changes: hot reload is off), then
  `python3 e2e/shell_test.py --port <PORT>` and `python3 e2e/<yourviewer>_test.py --port <PORT>`.
  Both must be fully green. `INKLING_ONLY=name1,name2` runs a subset in suites that use
  `cs_helpers.Results` (image2d, volume3d); other suites take names differently — read the
  test file. Several conversions run concurrently on this machine, so a timing-sensitive
  test can flake under load: rerun a failing test alone before concluding it's a bug, and
  never "fix" a real regression by loosening an assertion. Kill your server when done.
- The e2e baseline (before your change) is green; the `data-testid`s and store fields the
  tests read are the regression contract.

## Report back (final message, concise)

Branch name and commit list; what moved where (files); new/changed contributions (ids);
how keys/panels/runtime/geometry changed; test results (counts per suite); anything you
couldn't do and why; files outside your module you had to touch (so the merge is easy).
