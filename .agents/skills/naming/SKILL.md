---
name: naming
description: Neutral internal names and a swappable display name. Use before adding or renaming ids, schema ids, env vars, resource names (queues, events, buckets, labels), packages, images, or any user-visible copy that names the product.
---

# Naming: neutral internal names, swappable display name

The product's display name will change. Nothing internal may depend on it.

| What | Value | Where it comes from |
|---|---|---|
| Display name (what people see) | `NAMING.displayName` | `packages/contracts/src/naming.ts` only |
| Contribution / plugin ids | `studio.<local>` (`studio.wsi`, `studio.segmentation.segment_objects`) | `ns("wsi")`, `NS` |
| Schema ids and versions | `studio://schema/...`, `studio.plugins/v1` | `NAMING.schemaPrefix` |
| Resource names (queues, events, buckets, labels, temp dirs) | `studio:jobs:ready`, `studio-objects`, `app=studio` | `RES` / `naming()['resourcePrefix']` |
| Env vars | `STUDIO_<ROLE>_<KEY>` | `NAMING.envPrefix`, read in each service's config module |
| Packages, images | `@studio/<x>`, `studio-<x>`, `studio_<x>` | folder name |
| Published plugin packages | `ghcr.io/<owner>/studio-plugins/<name>` | `.github/workflows/sign-plugins.yml` |

Rules:

- Never write the display name or a past namespace (`legacyNamespaces` in
  `schemas/naming.json`) in code, ids, env vars, resource names, file formats, schema ids,
  package names or test fixtures. `pnpm check:boundaries` rejects both in strings and
  identifiers, and the project's PreToolUse hook refuses the edit.
- User-visible copy that names the product uses `NAMING.displayName`
  (`` `${NAMING.displayName} AI` ``), never a literal.
- Docs: prefer "the Studio", "the assistant" or "the product". Name the brand only where the doc
  describes on-screen text.
- Don't rename `studio` when the brand changes. A brand change edits `displayName` in
  `packages/contracts/src/naming.ts` and nothing else.
- If an internal namespace ever must change: edit `naming.ts`, push the old one onto
  `legacyNamespaces` (stored documents keep resolving), run
  `node tools/rename-namespace.mjs --from <old> --to <new>`, then `pnpm emit:schemas`.
