# One Studio per task, not per data type; every file opens

**Goal.** A project behaves like a repository: Sources is the folder of originals, Datasets are
curated sets, and a Studio is one labelling *task* over a set of items. A mixed drop (X-rays,
MRI, 4D cine, ECG, endoscopy video, a slide) lands in **one** Studio where each item opens in its
own renderer, and every file either opens or says exactly why it can't and what happens next.

**Status (2026-11-02, `main` 572336b).** Plan only. Built from:

- a deep-research pass over 30+ labelling, medical-imaging and dataset tools:
  `todo/research/reports/Mixed modality labelling workspaces.md`, notes in
  `todo/research/research_notes/Mixed modality labelling workspaces/`;
- a code audit of the drop → plan → boot path;
- a hand test of the tester's 35-file drop into `prj-e46d49e0373441be` (sample data in
  `~/Downloads/spurby-sample-data`).

**Naming.** Internal names are `studio` (`studio.<plugin>`, `STUDIO_*`); the product name appears
only in `packages/contracts/src/naming.ts`. Env vars below are written without their prefix.

---

## What the research says (one paragraph each)

**Type the item, not the workspace.** Every data store that is still actively developed leaves
the container untyped and picks a renderer per file. That includes HF Hub, lakeFS, DVC, Oxen,
DagsHub, Labelbox Catalog and Encord Files. Medical tools that lead the field type the *file* or
*series* and keep many modalities in one project: Flywheel, MD.ai, RedBrick, XNAT, Encord, V7.
OHIF 3.13 picks a render path per data type inside one viewer. Most generic labelling tools
(Labelbox, Scale, Kili, Supervisely, CVAT, Roboflow) fix one media type per *project*. The only
reason they give is "the media type decides which tools exist". Labelbox's retreat from DICOM
(Nov 2024) shows what that costs: every modality becomes a separate product surface.

**What really differs per modality is tools, label vocabulary, QA and export, not storage.**
Agreement metrics, review rules and throughput are defined per geometry and kind. FiftyOne runs
statistics over one slice type at a time. Encord doesn't run consensus over mixed groups. So a
mixed Studio needs explicit rules for which tools and classes apply to which item, and per-kind
views for QA and export. Nobody publishes these rules; we have to design them (§1 D6–D8).

**Multi-file samples become one grouped item with typed slots.** Examples are a patient with MRI,
ECG and a report, a DICOM series, a WFDB `.hea`+`.mat` record, a volume plus its `_seg`. Encord
Data Groups, V7 slots, FiftyOne groups and OHIF hanging protocols all work this way. Seven
Studios for one patient recreate the "open several browsers" problem that CVAT users have asked
to fix since 2022 (cvat#4648).

**Convert on ingest, keep the original, show each file's state.** Video becomes H.264 MP4 at a
constant frame rate with faststart. Slides are read with OpenSlide or libvips into a tiled
pyramid by a background job. DICOM series are grouped by SeriesInstanceUID. NIfTI can be parsed
in the browser. Each file shows its own state machine (stored → detecting → converting n % →
ready | failed(reason) | unsupported). Transient failures retry, permanent ones say why, and one
bad file never blocks the batch. No vendor ingests WFDB natively; we already do, so keep it.

---

## Start here (agents)

1. Read `AGENTS.md`, this file and the research report, then the workstream you take (§3).
2. One worktree per workstream: `git worktree add .worktrees/todo19-<ws> -b todo19-<ws> main`.
3. Every change gets a test that fails first. The drop test below (§4) is the acceptance test
   for the whole plan.
4. Test with the tester's sample folder and the scripted model; drive the product yourself.
   Keep `data-testid`s.

---

## 0. Fix first (P0: broken today, small, independent of the redesign)

| # | What breaks | Evidence | Fix |
|---|---|---|---|
| P0-1 | **Uploaded slides never open: "Slide tiling isn't available: OpenSlide isn't installed on the worker".** The worker imports `openslide`, but neither `openslide-python` nor the native library is a dependency; seeds hide it because `tools/fetch-seeds.py` tiles them offline. | `apps/worker/src/studio_worker/derive.py` 128–134; `apps/worker/pyproject.toml` 6–16; `derivatives` row `slide-dzi failed` | Add `openslide-python` and **`openslide-bin`** (wheels that bundle libopenslide for macOS arm64, Linux and Windows, so no brew or apt) to `apps/worker/pyproject.toml`; `uv lock`. Worker Dockerfile: `apt-get install ffmpeg` (ffprobe included). Test: tiling a small fixture slide in `apps/worker/tests` runs in CI without mocks. |
| P0-2 | **A failure caused by a missing converter is permanent.** The slide stays failed after the tool is installed, because `DeriveError` for a missing tool is `retry=False`. | `derive.py` 94, 134; `kernel/derivatives.py` fail path | New error class `unavailable` (missing tool or capability). The derivative state becomes `waiting` ("Waiting for a converter: OpenSlide"), not `failed`. On startup the worker reports its capabilities (§1 D10) and re-queues `waiting` derivatives it can now serve. Also a one-off re-queue of today's `failed` rows whose error starts "… isn't installed". |
| P0-3 | **Converted files show their storage key instead of their name.** In the Videos Studio items are `1b41cc0a….avi`; in the slide Studio the item is `sources/prj-…/4bb16896….svs`. The API sends the right `name` (`colitis-29c2….avi`, `TCGA-A6-5665….svs`). | `plugins/video/ui/manifest.ts` 13 (`a.path.split("/").pop()`); `plugins/wsi/ui/manifest.ts` 23 (`a.slide ?? a.path`); `plugins/text-spans/ui/manifest.ts` 26; `plugins/_template/ui/manifest.ts` 15 (copied by every new plugin) | One SDK helper `assetName(a)` (`a.name` → `a.record`/`a.slide` → basename of `a.path`, never a storage key) in `packages/plugin-ui-sdk`. Every `groupItems` uses it; fix the template. A contract test in `apps/web` runs every bundled data kind's `groupItems` over a fixture project whose paths are storage keys, and fails if any item name contains `sources/` or a 64-hex hash. |
| P0-4 | **One drop makes a Studio per data kind.** 35 files gave seven Studios (images, 3D volumes, 4D cine, videos, waveforms, slides, masks). The BraTS `_seg` was attached to its MRI as a reference **and** got its own "Masks" Studio. | `kernel/drops_classify.py` 274–283 (`new_collection` per viewable group), 35–36 (`mask` is viewable); `kernel/drops_plan.py` 372–417 (one `_boot` per collection); `apps/api/tests/test_drop_subjects.py` 74–76 asserts two tasks | Stopgap until M2 lands: a mask that is `part_of` a subject never forms its own group or collection. The full fix is the redesign below (§1 D1–D5, §3 W2). |

---

## 1. Decisions

| # | Decision |
|---|---|
| D1 | **Type the item, not the container.** Sources and Datasets stay untyped. Every item carries its detected `kind` (already `source_nodes.detected_kind`) and its representations (original, browser copy, thumbnail). Collections stop being "one per kind". They are organisational (split, cohort, patient, site), and kind is a facet you filter by. |
| D2 | **A Studio is a task: a question, a label schema, a workflow and assignees, over a set of items.** It **accepts** a set of kinds (default: every kind the dataset has). It is no longer bound to one data kind. Specialised Studios ("segment the LV", accepting `volume` and `volume-time`) are created on purpose: from a filter in the dataset, from "New Studio from these items", or by the assistant. A drop never creates more than one. |
| D3 | **The environment maps kinds to views.** `data.kind` (one id) becomes `data.kinds: { <kind id>: { renderer, config?, tools?, panels? } }`. Each entry is a *profile*. The active item's kind picks its profile, so the viewport, toolbar, panels and keyboard scope follow the item. `data.kind` + `viewports` stays valid as shorthand for a one-kind environment and is normalised on load (schema migration, no stored rewrite). Kinds the environment doesn't map open in a generic **file view** (name, size, facts, download): nothing disappears. |
| D4 | **Presets become per-kind profiles, composed per drop.** `preset:image-2d`, `preset:mri-3d`, `preset:cine-4d`, `preset:ecg`, `preset:video`, `preset:pathology` stay as files. Each is the profile for its kind (renderer, tools, default labels, review rules). A drop's environment is `extends: [ …profiles of the kinds present ]`, deep-merged into `data.kinds`. `registry/intents.json` keeps mapping kind → profile. |
| D5 | **One draft dataset and one Studio per drop.** Classification and grouping stay as they are: they are good. The plan applies as one dataset (one collection, or none), one boot and one task. The fast path opens that Studio on the first ready item. Existing per-kind Studios keep working (no migration). On those projects the Studio picker offers "Combine into one Studio" (new task over the union, old tasks left as they were). |
| D6 | **Groups are items with typed slots and a layout.** A subject (BraTS t1/t1ce/t2/flair + seg), a cine study (4D NIfTI + `Info.cfg` + `_gt`), a WFDB record (`.hea` + `.mat`/`.dat`), a DICOM series (by SeriesInstanceUID) and, later, a patient across modalities are one item. A reference mask is a slot of its subject, never its own item or Studio. A group's layout is a hanging protocol: which slot goes in which viewport, chosen by slot kind. |
| D7 | **Label classes say where they apply.** Each label group declares `appliesTo: [kind ids]` (default: all) and its geometries. The Labels panel and tool palette show what applies to the active item. A tool shows only when the item's renderer supports it **and** an applicable label uses its geometry. Item-level classifications ("adequate for diagnosis?") apply to any kind. |
| D8 | **Progress, review and export are per kind inside the task.** "To do / Needs review / Done" counts show per kind as well as in total. Review rules and agreement run over single-kind views. Throughput units differ (frames, slices, items), so never add them up. Exporters are chosen per kind (COCO for images, NIfTI/DICOM SEG for volumes, WFDB annotations for ECG), and one export produces one archive with a folder per kind. |
| D9 | **Every file has one visible state, everywhere.** `stored → inspecting → converting (n %) → ready`, or `waiting for a converter`, `failed (reason, retryable?)`, `unsupported`. The same badge appears in Sources, the dataset and the Studio item list. A failed or waiting item stays in the list with its reason and a Retry button. It never hides and never blocks other items. Bulk "Retry failed" exists per drop. |
| D10 | **Converters are capabilities the worker advertises.** At startup the worker reports `{video: ffmpeg x.y, slide: openslide x.y, …}` to the kernel (`POST /api/v1/workers/capabilities`, kept in Postgres with a TTL; no process memory). Derivative jobs are routed only to workers that can serve them. When none can, the item is `waiting for a converter` (D9). The worker's `/readyz` includes the capability list, `pnpm dev` prints missing ones, and `pnpm doctor` checks them. |
| D11 | **The Studio looks like a worktree.** The item list mirrors the Sources folder tree (already `withFolders`) and shows a kind icon and state badge on each item. Kind filter chips appear when a Studio mixes kinds. Switching between items of different kinds swaps the renderer without a page reload and keeps the item list, Labels panel and assistant in place. |
| D12 | **The assistant and MCP speak the new shape.** `boot_studio` takes `accepts` (kinds) and optional `filter`. `patch_studio` edits `data.kinds.<kind>`. `get_studio_state` reports the active item's kind and profile. The catalogue (`/catalog.json`) lists profiles. Prompts stop saying "one Studio per data type". |

---

## 2. Findings to fix, by area

Severity: **P1** wrong or stuck, **P2** polish. Paths are relative to the repo root.

### A. Ingest and conversion

- [ ] P1 **Slide tiling is a Python loop writing one JPEG and one blob per tile.** A typical TCGA slide has well over 100 k tiles, so this takes minutes and uploads one object per tile. Switch to libvips `dzsave` through `pyvips` + **`pyvips-binary`** (wheels, no system libs), writing a zip or a tile pack per level. Keep OpenSlide for header facts (mpp, levels) and as the fallback. Progress comes from vips' `eval` signal. `apps/worker/src/studio_worker/derive.py` 137–175.
- [ ] P1 **Slide and video notices show no progress and need a reload.** `plugins/wsi/ui/renderer/Host.tsx` 30 and `plugins/video/ui/renderer/Host.tsx` 27 render `derivativeNotice`. Add `n %` from the derivative row, and open the result when `ready` arrives over the event stream.
- [ ] P1 **Video: the transcode ignores frame-rate variability.** Add `-fps_mode cfr` (constant frame rate, needed for frame-accurate labels) and keep the source fps from ffprobe. Keep the original for export. `derive.py` 104–106.
- [ ] P1 **Lone `.mat` ECG files aren't paired the way `.dat` is.** `apps/worker/src/studio_worker/inspect/__init__.py` 149–150 checks `.dat` only; add `.mat` (PTB-XL and PhysioNet 2020 use `.mat`). A lone `.hea` or signal file is flagged "needs its pair" (todo18 D5).
- [ ] P1 **DICOM series grouping.** Group single-frame DICOM by SeriesInstanceUID and order by ImagePositionPatient along the normal, falling back to InstanceNumber. Check the tags a volume needs (spacing, orientation) and flag a series missing them as "opens as 2D images". `kernel/drops_classify.py` 184–185.
- [ ] P1 **`Info.cfg` and other sidecars appear as loose documents.** A sidecar consumed into item metadata (ED/ES, height, weight) becomes a hidden slot of its group, not a `keep_reference` file in the plan. `inspect/__init__.py` 117–124.
- [ ] P2 **Derived copies are invisible in Sources.** The node inspector lists "Browser copy: MP4, 12 MB, ready" and "Tiles: DZI, 128 k tiles", with a "Rebuild" action.
- [ ] P2 **`dciodvfy` is optional and silent.** Report it in capabilities (D10) so "DICOM checks skipped" is visible.

### B. Drop plan and boot (the redesign)

- [ ] P1 `kernel/drops_classify.py` 274–283: the plan has one `new_dataset` action. Viewable groups become *members*, not `new_collection` actions. `mask` groups that are `part_of` a subject are slots (P0-4).
- [ ] P1 `kernel/drops_plan.py` 372–417: one dataset, one boot with `extends: [profiles]` (D4), `accepts: [kinds]`. The fast path (`_fast_path_preset` 283–291) becomes "always one Studio". `intents.unambiguous` is no longer needed to avoid opening ECG in a volume preset, because each kind gets its own profile.
- [ ] P1 `kernel/boots.py` 96–111, 158–197: accept `extends` as a list and `accepts`. A task's item filter is the dataset ∩ `accepts` (∩ optional `filter`), not `collection_id`.
- [ ] P1 `kernel/projects.py` 930–931 `task_document`: items from every accepted kind, each with `kind` and `profile`; `collections.item_filter` stays only for legacy tasks.
- [ ] P1 `kernel/environment_resolve.py` and `environment_policy.py`: the effective environment merges profile lists; the policy validates `data.kinds` entries (renderer consumes kind, tools exist, labels' `appliesTo` refer to accepted kinds).
- [ ] P1 Plan card (`apps/web/src/studio/core/drops/PlanCard.tsx`) shows "One Studio · 35 files · 6 kinds" with per-kind counts and states, instead of a list of Studios.
- [ ] P2 "Combine into one Studio" on projects with per-kind tasks (D5): new task, `accepts` = union, annotations copied by item id, old tasks untouched.

### C. Contracts, resolver and shell

- [ ] P1 `packages/contracts/src/environment.ts` 89: add `data.kinds` (record of profile objects) and `accepts`; keep `data.kind`; a pure `normalizeEnvironment()` turns the one-kind form into `data.kinds`. `pnpm emit:schemas`.
- [ ] P1 `apps/web/src/extension-host/resolve.ts` 165–186: resolve every profile (each renderer must `consume` its kind); the `when` context gains `item.kind` and `item.profile`. Report `renderer-data-mismatch` per profile.
- [ ] P1 `apps/web/src/studio/lib/item-folders.ts` 257: `studioItems` groups per kind with that kind's `groupItems` and concatenates, so group items (D6) still come from their plugin.
- [ ] P1 `ViewportHost` / `ModuleSlot`: renderer chosen per active item. `itemSwap` keeps the renderer mounted between items of the same profile; a profile change unmounts, mounts and keeps the item-list scroll. Preload the next item's plugin bundle.
- [ ] P1 Toolbar, panels and inspectors filter by the active item's profile and the label rules (D7). Commands are scoped per profile, so the same key can mean "next frame" for video and "next slice" for volumes without conflicts.
- [ ] P1 **Generic file view** renderer in `packages/renderers` for unmapped kinds and `unsupported` files: metadata, preview when possible, download.
- [ ] P2 Item list: kind icons, state badges and kind filter chips (D11); `mixesKinds` (`item-folders.ts` 248) already exists.

### D. Labels, review and export

- [ ] P1 `LabelGroupSchema`: `appliesTo?: string[]`. A drop composes each profile's default labels, keeps them separate and tags them with the kind they came from ("Normal / Pneumonia" for X-rays, "Source Dx" for ECG).
- [ ] P1 Progress counters and review rules per kind (D8), from the same task document. The Overview shows per-kind progress.
- [ ] P1 Export: the exporter list comes from the accepted kinds' profiles; one "Export" writes one archive with a folder per kind and a manifest.
- [ ] P2 Changing a label schema after annotations exist is a versioned migration (rename or merge classes with a preview), never a silent drop.

### E. Assistant, MCP and catalogue

- [ ] P1 `apps/agent/src/tools/*` (boot, patch, state) and `apps/mcp` tools follow D12. Scripted-model fixtures are updated, and the boot-tools unit test (failing on `main` today) is fixed or rewritten for the new shape.
- [ ] P1 The catalogue and `docs/modules.md` describe profiles and `data.kinds`; `docs/README.md` glossary: Studio = task, profile = per-kind view.

### F. Developer setup

- [ ] P1 `pnpm doctor`: checks ffmpeg/ffprobe, OpenSlide (import plus a version call), pyvips, `dciodvfy` (optional), the database migrated and the seeds present. It prints the one command that fixes each one. `docs/running.md` lists the same.
- [ ] P1 `tools/dev.mjs` prints the worker's missing capabilities at start ("slides will wait for a converter: install with `uv sync`").

---

## 3. Workstreams and order

| WS | Scope | Order |
|---|---|---|
| W1 `todo19-ingest` | P0-1, P0-2, D9, D10, §2 A, §2 F | **Now** (independent) |
| W2 `todo19-names` | P0-3 (SDK `assetName`, plugin fixes, contract test) | **Now** (one day) |
| W3 `todo19-contracts` | §2 C contracts + resolver + `normalizeEnvironment`, schemas | Next (unblocks W4–W6) |
| W4 `todo19-shell` | §2 C viewport per item, toolbar and panels per profile, generic file view, item list | After W3 |
| W5 `todo19-boot` | P0-4, §2 B (plan, boots, task document, policy, plan card, combine) | After W3, in parallel with W4 |
| W6 `todo19-labels` | §2 D | After W4 |
| W7 `todo19-agent` | §2 E | After W5 |
| W8 `todo19-groups` | D6 hanging layouts for group items (subject, study, record, series, patient) | Last |

Milestones:

- **M1:** every file in the sample folder opens (W1, W2).
- **M2:** one drop gives one Studio and every item opens in its own renderer (W3–W5).
- **M3:** labels, review and export per kind (W6, W7).
- **M4:** grouped items with layouts (W8).

---

## 4. Tests that prove it

- **Acceptance (e2e, `tests/e2e/mixed_drop_test.py`).** Drop the 35-file sample folder (or a tiny
  fixture with one file per kind, for CI). Expect exactly one draft dataset and **one** Studio.
  Walk every item:
  - the X-ray opens in the 2D viewer;
  - the BraTS subject opens as one item in the MPR viewer, with its seg as reference;
  - the cine opens with ED/ES from `Info.cfg`;
  - each ECG record opens with 12 leads;
  - each AVI plays after "Converting video";
  - the slide opens after "Preparing slide n %".
  Item names equal the original filenames.
- **Missing converter:** start the worker without OpenSlide. The slide shows "Waiting for a
  converter: OpenSlide", not failed. Install it and restart: the slide becomes ready without
  re-uploading.
- **Legacy:** a project with per-kind Studios (today's tester project) still opens every Studio,
  and "Combine into one Studio" produces one task with the same annotations.
- **Contract:** every bundled data kind's `groupItems` keeps original names (P0-3);
  `normalizeEnvironment` round-trips every preset in `registry/presets/`; the resolver rejects a
  profile whose renderer doesn't consume its kind.
- **Policy:** a label group whose `appliesTo` names a kind the task doesn't accept is rejected by
  admission with a fix suggestion.

---

## 5. Not in this plan

- Cross-modality group items for one patient across separate uploads (needs patient matching;
  design it after W8).
- DICOM WSI export, IIIF serving, on-demand tiles from the original slide (pre-generated DZI is
  enough until slides are routinely > 5 GB).
- Consensus across different kinds (no tool does it; per-kind agreement per D8 is the rule).
