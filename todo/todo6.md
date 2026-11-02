# Projects, Sources and Explore: implementing `docs/ux.md`

**Goal.** Take the product from "a list of seed datasets that open in the Studio" to the shape in `docs/ux.md`:
a researcher creates a **project**, drops in a messy folder, sees what Inkling found in it, confirms how it
fits together, and lands in a correctly configured Studio. The assistant stays with them the whole way. The
working Studio (canvas, tools, autosave, versioning, plugins) is preserved, not redesigned.

**Scope.** `docs/ux.md` P0 in full, plus the slice of P1 that the "Mixed data import" acceptance criterion
needs (approve a CSV-to-image mapping, then open the 2D Studio). Everything else in P1 and P2 goes to
`BACKLOG.md` at the end (Phase 10).

**When.** Start now. `main` is at 347d815 (todo5 merged, `docs/ux.md` committed). Work in
`.worktrees/todo6-<phase>` branches, one phase per branch, merged in order.

**Audit date:** 2026-10-30, against `main` 347d815.

## Status (2026-10-30)

Code complete (Phases 1–8 and 10, Phase 9's checks and docs), merged as `todo6-int`. Open: Phase 9's
accessibility pass, performance budget and moderated user sessions (see its "Status" note).

---

## 0. Where we are today (what the plan builds on)

| Area | Today | Gap against `ux.md` |
|---|---|---|
| Home | `WorkspacePage` (`/`): a grid of seed dataset cards with progress and three metrics | No projects, no "New project", no natural-language entry |
| Data model | A seed entry in `seed-data/manifest.json` is a "project" in contracts (`Project`), a "dataset" in routes (`/datasets/:id`) and a kernel `Workspace` row (`workspace_id` = seed id) at the same time | ux.md needs Workspace (org) ⊃ Project ⊃ Dataset ⊃ Task, plus Sources |
| Assets | `kernel/assets.py` registers seed files (`ensure_seed_assets`); `BlobStore` (local + S3) can `put`, `read` and `presign` GETs | No upload, no import session, no checksum check on arrival, no source tree |
| Navigation | `AppLayout`: a Nebius-style header and a left nav with "Workspace" plus the dataset's sections (Annotate, Review, Export, Plugins) | No project sidebar; the Studio is full-bleed with its own top bar |
| Studio | `DatasetStudioPage`: dockview slots, Files / Labels / Review tabs, AI as the right slot | Fine. It needs a task route, a collapsed project rail and a resume write |
| Assistant | `core/panels/ai.tsx` is a Studio panel; its context (`lib/agent/context.ts`) reads `useStudio`; threads are keyed by project id and persisted | Only exists inside the Studio |
| Review | `/datasets/:id/review` (annotation list) and the versioning review pages | No project-level queue covering import issues, mappings and privacy |
| Activity | `PluginAudit` (append-only), versioning commits, environment history | No feed |
| Versioning | `DatasetRepo` is already keyed by `(workspace_id, dataset_id)` | Good: it was built for several datasets per workspace |
| Design system | Gravity UI tokens (`styles/globals.css`, `--g-*`), Gravity icons behind `@studio/ui/icons`, shadcn primitives in `packages/ui` | No tree, virtual list, resizable split or dropzone primitives |
| Dev without the API | `apps/web/dev/seed-server.ts` serves `/seed/*`, annotations and environments from disk; `apps/web/e2e` runs against it | New project APIs need a story for this mode (D4) |

The e2e regression contract this plan must keep: `apps/web/e2e/harness.py` opens `/datasets/{id}`,
`shell_test.py` opens `/datasets/{id}/export`, and every `data-testid` and store field those tests use.

---

## 1. Who we're designing for (research summary)

The first users are **medical imaging researchers who don't program**. The design follows from how they
work today, not from how ML tools are usually built.

### People

| Person | What they bring | What they fear | What they need from us |
|---|---|---|---|
| **Clinician-researcher** (radiologist, cardiologist, PhD in a lab). The primary user. | A hospital export: deep DICOM folders with meaningless names (`IM-0001-0001.dcm`, `DICOMDIR`), plus a spreadsheet from REDCap or Excel | Leaking patient data. Breaking or losing the originals. Looking incompetent in an "ML tool". Wasting a clinic afternoon on uploads | Their own vocabulary (patient, study, series, case), one obvious next step, visible safety, work that resumes exactly |
| **Research coordinator / grad student.** Does the data wrangling. | Several exports with inconsistent IDs (`P001` vs `1` vs `pt-001`), duplicate folders, a PDF protocol, measurements in `.xlsx` | Silently wrong joins. Redoing work when a new batch arrives | Explanations of how things were matched, a list of ambiguous rows to fix, re-import that only adds new files |
| **ML collaborator.** Consumes the output, rarely uses the UI. | Nothing | Datasets without provenance or spacing metadata | Versions, manifests and exports (already built: `apps/versioning`, exporters) |

### What their tools teach us

- **Imaging tools (Horos/OsiriX, 3D Slicer's DICOM browser, OHIF's worklist):** researchers browse by
  **patient, then study, then series**, never by file. A folder of 120 slices is *one series*, not 120 rows.
- **Research data platforms (XNAT, Flywheel):** the hierarchy is project › subject › session › scan, and
  originals are never edited. Organizing means *labeling and linking*, not moving files. This is exactly
  ux.md's "Source ≠ Dataset".
- **Google Drive and Finder:** drag a folder anywhere, see a progress tray, keep working; list view with
  sortable columns; Space for Quick Look; breadcrumbs. Researchers already know these moves.
- **Roboflow and Encord upload flows:** after a drop, show a *summary before commitment* ("118 images,
  1 table, 3 files we can't read"), detect annotation formats, and flag duplicates. Encord keeps files in
  folders and has datasets *reference* them, which matches our source/dataset split.
- **kiwifs (`~/kiwifs/ui`):** a production tree on our exact stack. React 19, Tailwind 4, shadcn,
  zustand and **react-arborist**, with path ids, compact folder chains, natural sort, live refresh over SSE,
  skeleton rows, a reveal-in-tree flash and context menus. It loads the whole tree at once and can't drop
  folders recursively; both are fine for a wiki and wrong for imaging, and we fix both.
- **Patch (`~/patch/apps/web`):** a compact tree recipe (12px indent, `text-xs`, child counts, a filter
  that keeps matching subtrees), one `FileIcon` component behind a file-name and extension map, row-shaped
  skeletons, an indexing progress strip, and a breadcrumb plus flat folder list (`add-secret-dialog.tsx`)
  for non-technical drill-down. Patch colors each file icon with its brand color (simple-icons); that
  clashes with our calm Gravity chrome, so we keep the *mapping pattern* and drop the colors.
- **Gravity UI (already ours):** the token set, icons on a 16px grid, and the AsideHeader navigation
  pattern (a full sidebar that collapses to an icon rail). We mimic AsideHeader's behavior in Tailwind
  rather than adopting `@gravity-ui/navigation`, whose CSS would fight shadcn.

### Design implications (each is a requirement below)

1. **Two views of the same data:** *Files* (exactly what was uploaded) and *Studies* (what it means).
   Sources shows files, but collapses file sequences (`scan001…scan120.dcm`) into one row. Explore shows
   studies and relationships.
2. **Originals are read-only in the UI.** No rename, move or delete inside a source. You can add and
   remove whole uploads (removal only while no dataset uses them), and add notes and tags. Organizing
   happens in Datasets.
   *Superseded by [todo7](todo7.md): bytes stay immutable, but names and folders are now the user's
   (rename, move, Trash, undo, all journaled), and the name a file arrived with is kept as
   provenance. See todo7 §1 (D1–D12) and `docs/ux.md` principle 3.*
3. **Safety is visible and specific:** a short rights attestation on the first upload, privacy flags on
   exact files, "held for privacy review" as a real state, and no patient identifiers in trees, URLs or
   chat by default.
4. **Facts, proposals and confirmations look different:** detected facts are solid, proposals are dashed
   with their evidence one click away, and confirmed items get a check. Nothing proposed changes data until
   the user confirms it.
5. **Plain words, domain nouns:** "Table", "MRI series", "Video", "We can't read this file yet", never
   "MIME", "schema" or "ETL". Confidence is shown as words (*Strong / Possible / Weak match*) with a
   "Why?" link, not as percentages.
6. **Uploads never block:** a Drive-style tray, partial success, resume after reload, and a duplicate skip
   ("Already in this project").
7. **Resume is exact:** task, item, slice or frame, and tool. "Continue" is one click.
8. **The assistant is a guide, not a gate:** every flow works with chat closed, and the assistant can
   point at things ("Open Sources › MRI/patient_002").

---

## 2. Decisions (decide once, before Phase 1)

Taken 2026-10-30: the **recommended** option of each, with the deviations listed under each phase's
"Done" note (ids use hyphens, `task_id` is part of the key, dataset routes live under the project).

- [x] **D1. What "Workspace" means.** ux.md uses *workspace* for the account or organization; the glossary
  (`docs/README.md`) uses it for per-project plugin activation (the kernel's `workspace_id`).
  **Recommended:**
  - Code and docs call the account level **Organization** (`organizations` table, `org_id`).
  - UI copy may say "Workspace" for it, because users know the word from Slack and Notion. The glossary
    gets a row saying so, and `check:names` stays code-only.
  - The kernel `Workspace` row stays, now 1:1 with a **Project** (`workspace_id == project_id`). So the
    glossary's "per-project plugin activation" becomes literally true.
  - *Alternative:* rename the kernel's `workspace_id` to `project_id` everywhere. It's cleaner, but it
    touches every kernel table, the plugin SDK and agent session tokens. Not now.
- [x] **D2. Project, dataset and task ids for existing seeds.** **Recommended:** each seed becomes one
  project, one dataset and one task, all with the **same id** as the seed (`2d-xray`). Everything keyed by
  the old id keeps working unchanged: `/api/annotations/:id`, `/api/environments/:id`, `DatasetRepo`,
  e2e fixtures and `localStorage` layouts. New projects get opaque ids (`prj_…`, `ds_…`, `tsk_…`).
- [x] **D3. Where a task's state lives.** Today the environment and the annotation document are per
  workspace. **Recommended:**
  - Both move to per-**task** keys: add a nullable `task_id` to `workspace_environments`, the history
    table and `annotation_documents`.
  - Migration `0004` sets `task_id = workspace_id` for existing rows (seeds only, by D2).
  - The legacy routes treat their `:projectId` as a task id.
  - `DatasetRepo.dataset_id` is already per dataset; nothing changes there.
- [x] **D4. The dev mode without the API.** `apps/web/e2e` runs on the Vite seed server. **Recommended:**
  - The seed server *synthesizes* read-only projects, datasets, tasks and a source tree from
    `manifest.json` (one source per seed, its folder tree).
  - Overview, Sources browsing and the Studio then work without the API.
  - Creating projects, uploading and inspecting need the API and worker; their e2e tests live in
    `tests/e2e/`.
- [x] **D5. Tree component.** **Recommended: `react-arborist`** (as in kiwifs: proven on React 19 and
  Tailwind 4, with virtualization, keyboard handling, selection and type-ahead built in). Children load on
  expand from a per-folder endpoint; kiwifs's whole-tree fetch won't survive 100k DICOM files.
  - It lives in `packages/ui/src/ui/file-tree.tsx` as a generic primitive (nodes carry their own icon and
    badges), because `@studio/ui` may not import contracts.
  - The mapping from file kind to icon lives in the shell (`apps/web/src/studio/lib/file-kinds.ts`).
  - *Alternative:* `@headless-tree/react`. It has async loading built in and good ARIA, but we have no
    production use of it to copy from.
- [x] **D6. Long lists.** **Recommended:** `@tanstack/react-virtual` for the Sources list and grid views
  and the Explore tables (TanStack is already in the app via React Query). Splits use the existing dockview
  only in the Studio. Other pages use a small resizable split in `packages/ui`
  (`resizable.tsx`, shadcn's wrapper over `react-resizable-panels`).
- [x] **D7. Upload transport.** **Recommended:**
  - The API creates an **upload session**, and the browser sends one file per request.
  - Production uses presigned S3 `PUT` (multipart above 64 MB). Dev uses `PUT /v1/uploads/:session/files/:fileId`
    against `LocalBlobStore`.
  - The browser hashes each file (SHA-256 in a Web Worker, streamed with `hash-wasm`; check its licence)
    before upload. That makes duplicates and resume free: the server skips known hashes and re-verifies
    on completion.
  - Uploads land in a `quarantine/` prefix and move to `sources/` after inspection.
  - *Alternative:* tus (resumable uploads protocol). It's sturdier on bad networks but adds a server
    component.
- [x] **D8. Imported labels.** A CSV column that becomes classification labels isn't `human-created`.
  **Recommended:**
  - Add the provenance `imported` with a reference to its source (file and row) in
    `packages/contracts` (one migration-free union member).
  - Show it as its own badge, counting as unreviewed until a human confirms it.
  - *Alternative:* don't write annotations; only use the CSV to build the label set. That's simpler, but
    loses the user's existing work.
- [x] **D9. Resume state.** **Recommended:** server-side, per principal and project
  (`project_resume` table: task id, item id, placement, tool and when). It's stateless across replicas and
  follows the user to another browser. Panel layout stays in `localStorage` as today.
- [x] **D10. Section naming in the UI.** Use ux.md's names exactly: Overview, Sources, Explore, Datasets,
  Studio, Review, Activity. "Plugins" and "Export" stop being top-level dataset pages:
  - Plugins → **Project settings › Plugins**.
  - Export → **Datasets › (dataset) › Publish & export**.
  - Versions → **Datasets › (dataset) › Versions**, with a summary in Activity.

---

## 3. Design system additions (apply in every phase)

Everything below uses existing tokens; no new colors.

### Layout and density

| Element | Spec | Source |
|---|---|---|
| Global header | Existing `AppHeader`, 56px; breadcrumb `Workspace / Project / Section` | `app-layout.tsx` |
| Project sidebar | 240px; same `NavItem` (32px rows, gradient icon when active); collapses to a **48px icon rail** with tooltips in the Studio and below 1280px | Gravity AsideHeader |
| Page content | `max-w-6xl` for Overview, Explore and Review; **full width** for Sources (a working surface) | ux.md §4 |
| Tree row | **28px** high, 12px indent per level, 1px indent guides in `--g-line` drawn on hover and focus only, 16px icon, `text-body` | kiwifs uses 30/14 and Patch 12px indent; we sit between them, matching Gravity's medium (M) control height |
| List row | 36px; columns Name, Kind, Size, Status, Added; sticky header; `tnum` numbers | Drive |
| Grid tile | Minimum 168px; a 4:3 thumbnail on `--canvas` (the dark image surface even in light theme); a one-line name | Finder |
| Inspector | 320px right pane on Sources and Explore, collapsible | Figma and ux.md |
| Assistant drawer | 340px (300–480, as in the Studio's right slot); its open state is remembered per user | `StudioLayout.tsx` |

### Visual grammar for facts, proposals and confirmations

| State | Treatment | Copy |
|---|---|---|
| **Detected** (a fact read from the file) | Solid neutral text and icon | "DICOM · MR · 256×256 · 120 slices" |
| **Proposed** (by the worker or the assistant) | **Dashed** `--g-line-hover` border, `--g-utility-tint` fill; assistant-made proposals add the lime AI sparkle (`--g-ai-*`), never brand violet | "Possible match · Why?" |
| **Confirmed** | Solid border, `DoneIcon` in `--g-positive` | "Confirmed by you · Oct 30" |
| **Dismissed** | Hidden by default, with a "Show dismissed" toggle | — |
| **Needs attention** | `--g-warning` icon plus text; never color alone | "7 rows need matching" |
| **Privacy hold** | `ShieldExclamation` in `--g-warning`, with the reason | "Held: header has a patient name field" |

### Icons (`packages/ui/src/icons/index.ts`, named by job, all Gravity)

New exports. Glyphs may repeat across jobs, but a job never gets two glyphs.

| Export | Gravity glyph | Used for |
|---|---|---|
| `HomeIcon` | `House` | Global nav: Home |
| `ProjectsIcon` | `LayoutCellsLarge` | Global nav: Projects |
| `OverviewIcon` | `House` | Project nav: Overview |
| `SourcesIcon` | `FolderTree` | Project nav: Sources |
| `ExploreIcon` | `Compass` | Project nav: Explore |
| `ActivityIcon` | `ListTimeline` | Project nav: Activity |
| `ProjectSettingsIcon` | `Gear` | Project settings |
| `AddDataIcon` | `CloudArrowUpIn` | "Add data" button and dropzone |
| `FolderIcon` / `FolderOpenIcon` | `Folder` / `FolderOpen` | Tree folders (open while expanded) |
| `FileSequenceIcon` | `Files` | A collapsed run of numbered files |
| `TableFileIcon` | `LayoutHeaderCellsLarge` | CSV, TSV, XLSX |
| `ArchiveFileIcon` | `FileZipper` | ZIP, TAR, GZ (not `.nii.gz`) |
| `MaskFileIcon` | `Layers3Diagonal` | Segmentation masks |
| `AnnotationFileIcon` | `Tags` | COCO, GeoJSON or annotation exports |
| `UnknownFileIcon` | `FileQuestion` | Files we can't read yet |
| `QueuedIcon` | `Hourglass` | Upload or inspection queued |
| `PrivacyIcon` | `ShieldExclamation` | Privacy flags and holds |
| `RelationshipIcon` / `NoRelationshipIcon` | `Link` / `LinkSlash` | Proposed or confirmed links / dismissed links |

These are reused as they are: `ImageIcon`, `VolumeIcon`, `VideoIcon`, `WaveformIcon`, `SlideIcon`,
`DocumentIcon`, `DatasetsIcon`, `AnnotateIcon` (Studio), `ReviewIcon`, `HistoryIcon` (versions), `AiIcon`,
`UploadIcon`, `WarningIcon`, `ErrorIcon` and `DoneIcon`. Icons are monochrome `text-hint`; the selected
row and the active nav item use the existing `icon-gradient`.

### File kinds (`apps/web/src/studio/lib/file-kinds.ts`)

The worker detects kinds from file content; the client only *displays* them. The client falls back to the
extension only for rows that haven't been inspected yet, marked "Checking…".

| Kind (UI label) | Detected by | Icon |
|---|---|---|
| Image (PNG, JPEG, TIFF) | magic bytes | `ImageIcon` |
| DICOM image / DICOM series | `DICM` preamble; series grouped by SeriesInstanceUID | `ImageIcon` / `VolumeIcon` |
| Volume (NIfTI, NRRD, MHA) | header | `VolumeIcon` |
| Video (MP4, AVI, DICOM cine) | container probe | `VideoIcon` |
| Waveform (WFDB, EDF) | header pair / magic | `WaveformIcon` |
| Whole-slide image (SVS, OME-TIFF, DZI) | TIFF tags / XML | `SlideIcon` |
| Table (CSV, TSV, XLSX) | sniffing and parsing | `TableFileIcon` |
| Document (PDF, DOCX, TXT, MD) | magic bytes | `DocumentIcon` |
| Mask | volume plus integer label values, or a `mask`/`seg` name hint (a hint only) | `MaskFileIcon` |
| Annotations (COCO, GeoJSON, VOC) | JSON/XML shape | `AnnotationFileIcon` |
| Archive | magic bytes | `ArchiveFileIcon` |
| Unknown | — | `UnknownFileIcon` |

System junk (`.DS_Store`, `Thumbs.db`, `__MACOSX/`, `desktop.ini`) is skipped at upload, with
"12 system files skipped" in the session summary.

### Copy rules

- Sentence case. Verbs on buttons ("Add data", "Confirm match", "Open Studio").
- Never "upload failed" alone: always "*3 files* didn't upload. **Retry** · **Show files**".
- Counts come only from the server ("verified project state", ux.md §4). While loading, show a skeleton,
  never a 0.
- Keyboard keys are declared as commands (core manifest), never hard-coded in components (`AGENTS.md`).

---

## Phase 1. Domain model and API (backend first, no UI change)

### 1.1 Tables (`apps/api/src/studio_api/models.py`, migration `0004_projects_sources_tasks`)
- [x] `organizations` (id, name, kind `personal|team`); `organization_members` (org, principal, role
  `owner|editor|viewer`). Dev creates a personal org for `settings().dev_principal`.
- [x] `projects` (id, org_id, title, description, visibility `private|shared`, created_by, timestamps). Creating
  a project creates its kernel `workspaces` row with the same id (D1), in one transaction.
- [x] `sources` (id, project_id, title, kind `upload|seed|connector`, root_node_id, created_by, status).
- [x] `source_nodes`: the immutable tree.
  - Columns: id, source_id, parent_id, name, `rel_path` (as uploaded), is_dir, `asset_id` (files), sha256,
    size, `detected_kind`, `facts` JSON, `flags` JSON (privacy, unsupported, duplicate-of), and child and
    descendant counts for folders.
  - Index on (source_id, parent_id, name).
  - Also store `sequence_key`, so numbered runs collapse without a client-side scan.
- [x] `import_sessions` (id, project_id, source_id, state, totals JSON, attested_by, attested_at,
  started_at, finished_at, error).
  - States: `uploading → inspecting → needs_review | ready → imported | failed`, and `cancelled`. Partial
    success is the normal case.
- [x] `upload_files` (session_id, client_file_id, rel_path, size, sha256, state
  `pending|uploaded|skipped_duplicate|rejected|failed`, reason).
- [x] `datasets` (id, project_id, title, description, `definition` JSON: which source nodes and how items are
  grouped, created_from_proposal_id).
- [x] `tasks` (id, dataset_id, title, kind, revision). The environment for a task is the existing
  `workspace_environments` row keyed by `task_id` (D3).
- [x] `proposals` (id, project_id, kind `group|relationship|mapping|dataset|task`, payload, `evidence` JSON,
  strength `strong|possible|weak`, status `proposed|confirmed|dismissed|superseded`, created_by
  (`worker:inspect`, `agent:<run>`, `user:…`), decided_by, decided_at).
- [x] `project_resume` (project_id, principal, task_id, item_id, placement JSON, tool, at) (D9).
- [x] Add `task_id` to `annotation_documents`, `workspace_environments` and its history table; backfill it
  for seeds (D2, D3).
- [x] Seeds: on API start, `ensure_seed_assets` also upserts one project, source, dataset and task per
  seed (same ids), and the `source_nodes` tree from manifest paths. It must be idempotent, because the
  get-or-create race in `BACKLOG.md` is fixed here (insert … on conflict do nothing, then select).

### 1.2 Routes (`apps/api/src/studio_api/routes/projects.py`, `sources.py`, `explore.py`)
- [x] `GET/POST /v1/projects`, `GET/PATCH /v1/projects/:id`. List items carry `lastActivityAt` and a
  `resume` summary for the cards.
- [x] `GET /v1/projects/:id/overview`: the three Overview blocks in one call (`resume`, `data` cards,
  `attention`). Each block is computed from real rows; a block with nothing to show is omitted.
- [x] `GET /v1/projects/:id/sources`, `GET /v1/sources/:id/children?node=&cursor=` (page of 500,
  folders first, natural sort, collapsed sequences, compact single-child chains as `displayPath`),
  `GET /v1/source-nodes/:id` (facts, flags, used-in datasets) and `GET /v1/source-nodes/:id/preview`
  (type-specific JSON: table head and column profile, DICOM header *minus* PHI tags, video probe; or a
  signed thumbnail URL).
- [x] `POST /v1/projects/:id/imports` (create a session with the file list, the attestation, and target
  folder), `PUT /v1/uploads/:session/files/:fileId` (dev) or presigned targets (S3),
  `POST /v1/imports/:id/complete`, `POST /v1/imports/:id/cancel`, `GET /v1/imports/:id`.
- [x] `GET /v1/projects/:id/proposals?status=`, `POST /v1/proposals/:id/confirm` (optional edited
  payload), `POST /v1/proposals/:id/dismiss`.
  - Only `user:` principals can confirm. Agents can create proposals but never confirm them (ux.md §9).
- [x] `GET/POST /v1/projects/:id/datasets`, `GET /v1/datasets/:id`, `GET/POST /v1/datasets/:id/tasks`.
- [x] `GET /v1/tasks/:id/document`: a **`Project`-shaped document** (id, title, environment, assets with
  the `SeedAsset` fields). Every data kind's `groupItems(project)` then works unchanged for uploaded data.
  This is the compatibility seam that lets uploaded data reuse every viewer.
- [x] `GET/PUT /v1/projects/:id/resume`.
- [x] `GET /v1/projects/:id/activity?cursor=`: a merged feed (see Phase 8).
- [x] `GET /v1/projects/:id/events`: SSE through `EventBus` (Redis in compose, in-process in dev), never
  per-replica memory. Event types `import.updated`, `source.node.inspected`, `proposal.created`,
  `proposal.decided`. The client invalidates React Query keys, as kiwifs's `App.tsx` does with
  `EventSource`.
- [x] Every route reads the org and project from `RequestContext` and checks membership, never from the
  body (`docs/plugins.md` §6 rules).
- [x] Regenerate `schemas/api/openapi.json` and `packages/api-client`. Add the types to
  `packages/contracts/src/types` (`ProjectSummary`, `SourceNode`, `ImportSession`, `Proposal`,
  `DatasetSummary`, `TaskSummary`, `ResumeState`).

### 1.3 Dev stand-in (D4)
- [x] `apps/web/dev/seed-server.ts` serves the read-only subset from `manifest.json`: `/api/v1/projects`,
  `…/overview`, `…/sources`, `…/children`, `…/source-nodes/:id`, `/api/v1/tasks/:id/document`, and resume
  stored in `seed-data/.resume/`. Writes return `501 { error: "needs the API" }`, which the UI shows as
  "Adding data needs the full stack: see docs/running.md".

**Exit:** `uv run pytest` covers seed backfill idempotency, the legacy ids still serving annotations and
environments, project isolation (one org can't read another's sources), children paging, natural sort
(`scan2` before `scan10`), and the rule that agents can't confirm proposals. The OpenAPI and client
drift checks pass.

**Done (2026-10-30, branch `todo6-p1`).** `apps/api/tests/test_projects.py` (10 tests) covers every exit
item plus uploads (verify, chunked, damaged-file retry, resume after reload, re-drop skip). Code:
`kernel/projects.py`, `tree.py`, `imports.py`, `overview.py`, `kinds.py`, `routes/projects.py`,
`sources.py`, `explore.py`, migration `0004`, `dev/project-stand-in.ts` (checked to return the same
trees, ids and data cards as the kernel for every seed). Deviations:
- Opaque ids are `prj-…`, `ds-…`, `tsk-…` (hyphen, not underscore), so every existing `[a-z0-9-]` id
  check and the agent's `projectId` slug rule keep working unchanged.
- `task_id` is part of the primary key of `annotation_documents` and `workspace_environments` (and of the
  history's unique key), so it is `NOT NULL` after the backfill rather than nullable. Plugin jobs carry
  a nullable `task_id` so plugin writes land in the task's document. The audit log gained `on_behalf_of`.
- Dataset detail and tasks are `GET /v1/projects/:p/datasets/:d` and `…/:d/tasks`: `apps/versioning`'s
  proxy already owns `GET /v1/datasets/:id`.
- Uploaded bytes live in the data BlobStore (never served by `/seed`): chunks under
  `quarantine/<session>/`, then, once size and SHA-256 verify, content-addressed
  `sources/<project>/<sha256><ext>` (no file names in keys or URLs). Files are "Checking…" and kept out
  of task documents until inspected. Presigned S3 `PUT` is not done: every upload goes through the API
  in ≤ 64 MB chunks (BACKLOG).
- `GET /v1/projects/:id/events` polls the outbox table every second (shared by every replica, nothing
  in process memory) instead of a Redis subscription; project events skip the plugin event rate limit,
  and only the kernel may publish them.
- The Postgres branch of migration `0004` (named constraints) is written but untested here (no Docker);
  SQLite upgrade → downgrade → upgrade was checked with data.

---

## Phase 2. Shell, routes and navigation

### 2.1 Routes (`apps/web/src/studio/app/AppShell.tsx`)
```text
/                                       Home (projects)
/projects                               All projects
/projects/new                           Create project
/projects/:projectId                    → overview
/projects/:projectId/overview
/projects/:projectId/sources/:nodeId?   node ids, never paths (paths can contain PHI; ux.md §11)
/projects/:projectId/explore/:tab?      summary | relationships | mappings | quality
/projects/:projectId/datasets
/projects/:projectId/datasets/:datasetId            (+ /versions, /publish)
/projects/:projectId/studio/:taskId
/projects/:projectId/review
/projects/:projectId/activity
/projects/:projectId/settings/:tab?     general | plugins | members
```
- [x] Legacy redirects keep the e2e contract: `/datasets/:id` → `/projects/:id/studio/:id`;
  `/datasets/:id/{review,export,plugins,versions}` → their new homes (D2 makes the ids line up).
  `harness.py` keeps working without edits. Update it to the new URL in Phase 9 and keep the redirect test.
- [x] Project and task ids live in the path. Selections that are safe (the tab, the view mode) go in the
  query; file names and patient-ish strings never do.

### 2.2 `ProjectShell` (`apps/web/src/studio/components/layout/project-shell.tsx`)
- [x] Extend `AppLayout`, don't fork it. Outside a project, the sidebar shows **Home, Projects** (and
  Recent: the last 5 opened projects). Inside one, it shows a project header (icon tile, title, a
  "← All projects" link) and **Overview, Sources, Explore, Datasets, Studio, Review, Activity**, with
  **Settings** pinned at the bottom.
- [x] The header breadcrumb becomes `Workspace ▾ / Project ▾ / Section`. Both are switchers: the
  workspace switcher is a placeholder with a single personal org, and the project switcher replaces
  `DatasetSwitcher`.
- [x] Studio mode: the project sidebar becomes a **48px rail** (icons plus tooltips; the active section is
  marked with a 2px bar). `StudioTopBar` gains the same breadcrumb. Keyboard: the existing sidebar toggle
  command, so it's declared once.
- [x] "Studio" in the nav opens the last-used task (from resume). With several tasks, it opens a small
  picker; with none, it goes to Datasets with a hint.
- [x] Phone and tablet use the existing `Sheet` drawer behavior; Studio routes show "Annotation works best
  on a larger screen" on phones but still open (ux.md §4, responsive).
- [x] Icons from §3, exported from `@studio/ui/icons` (`pnpm check:icons`).

**Exit:** every existing page is reachable from the new nav; the old URLs redirect; the `apps/web/e2e`
suite passes unchanged; there's a new `apps/web/e2e/navigation_test.py` (rail collapse, breadcrumb
switchers, redirects).


**Done (2026-10-30, branch `todo6-p2`).** Taken over from an interrupted session's uncommitted work
(`e8d9658`), then finished. Every §2.1 route exists; the old `/datasets/:id[/…]` URLs redirect.
`AppLayout` is the project shell: Home/Projects/Recent outside a project, the seven sections plus
Settings inside, a 48px rail (mod+B, the `toggleNavigation` command), `Workspace ▾ / Project ▾ /
Section` switchers. Code: `components/layout/{app-layout,switchers}.tsx`, `stores/shell.ts`,
`lib/routes.ts`, `app/routes/project-pages.tsx`. `navigation_test.py` (30 checks). Deviations:
- New shell commands are scoped with `when` clauses: Sources keys have `when: "section == sources"`,
  every environment resolves with `section: "studio"`, and outside the Studio `AppLayout` sets the
  section through `setShellContext()` (`extension-host/commands.ts`). Otherwise Space and Enter
  collided with plugin keys (11 preset tests failed). `shell-commands.test.ts` covers it.
- The switcher menu is keyed by project id: the old menu's closing animation swallowed the next
  click after a switch (`switcher-new-project` timed out).
---

## Phase 3. Home, Create project and Project Overview

### 3.1 Home (`routes/HomePage.tsx`, replacing `WorkspacePage`)
- [x] The heading asks "What are you working on?". The primary action is **New project**. A natural-language
  field below it ("Describe what you want to build, or drop files here") creates a project from the
  sentence (title and description suggested from it, editable before creation). Dropping files onto
  Home starts New project with them attached.
- [x] Recent project cards (a grid of up to 6): icon tile, title, one-line description, "Edited 2 h ago",
  and one **Resume** action when there's resume state. No metrics. All projects is a separate list page
  (`/projects`) with search and sort.
- [x] Seed projects show a small "Sample" badge and keep their license line (the restricted badge
  carries over from `DatasetCard`).
- [x] Empty state (no projects yet): the drop surface plus three example prompts as chips ("Classify
  chest X-rays", "Outline the left ventricle in cardiac MRI", "Mark events in ECG recordings"). The
  chips fill the field; they don't run anything.

### 3.2 Create project (`/projects/new`, also a dialog from anywhere)
- [x] One screen: name (or a goal sentence), an optional description, and the drop area. **Create** works
  with no files at all.
- [x] If files were attached, open the **rights attestation** before anything uploads: "I'm allowed to use
  these files for research, and they're de-identified or synthetic." It's one checkbox plus a "What
  counts?" link to `docs/` copy. The answer is stored on the import session.
- [x] After creation, go to Overview with the import tray running. When inspection finishes:
  - A clean set (one image kind, optional matching table) shows a *proposal card* on Overview: "Looks
    like 118 chest X-rays with labels from `labels.csv`. **Create dataset & open Studio** · Review first".
  - A mixed set shows "**See what we found** → Explore" instead (ux.md §3 step 4, progressive disclosure).

### 3.3 Overview (`routes/ProjectOverviewPage.tsx`, components per ux.md §11)
- [x] `ProjectHeader`: breadcrumb, a subtle icon, an inline-editable title and description, a
  Private/Shared chip, and the `•••` menu (Settings, Rename, Archive). No analytics row.
- [x] `ResumeWorkCard` is shown only when resume state exists:
  - A thumbnail (the item's preview from `/source-nodes/:id/preview`, else the data-kind icon on
    `--canvas`), the task title, "Study 012 · 3D volume annotation" (item name plus data kind label), and
    progress as "13 of 20 annotated" (verifiable; "reviewed" waits for P1 review status).
  - **Open Studio →** restores task, item, placement and tool.
  - With no resume state, it shows an encouraging start: "Pick up where the data is: **Open Studio**" if a
    task exists, else nothing.
- [x] `SourceSummaryCards`: 2–4 cards from `overview.data`: confirmed collections first, else sources by
  detected kind ("MRI scans · 120 · 3D volumes", "Diagnoses · 247 rows · Table"). Each opens its source
  folder or dataset. There's a `+ Add data` card, and "View sources" in the section header.
- [x] `AttentionQueue` holds at most 5 rows, ordered by severity, from `overview.attention`:
  - privacy holds;
  - failed or partial imports;
  - unconfirmed proposals ("7 records need matching");
  - open version review requests.

  Each row deep-links to its resolution surface (an Explore tab with the proposal selected, Sources with
  the node selected, the version review). Empty: "You're all caught up." in muted text, no illustration.
- [x] Empty project (no sources): the ux.md §4 empty state. "Let's start with your data.", a big drop
  zone, **Browse files** and **Browse folder**, and "Or tell Inkling what you're trying to create…"
  (which opens the assistant drawer focused).
- [x] Skeletons match the real card geometry (as `DatasetCardSkeleton` does today).

**Exit:** `apps/web/e2e/overview_test.py` (seed mode) checks:
- the resume card restores item and tool after reload;
- data cards link to Sources;
- attention is empty for seeds;
- no element on Overview shows a number the API didn't return.


**Done (2026-10-30, branch `todo6-p2`, same commits as Phase 2).** Home (goal field, example chips that
only fill it, drop-anywhere, up to 6 cards with Sample badge, licence line and Resume), `/projects`
(search, sort), Create project (`components/projects/new-project.tsx`, a page and a dialog from the
project switcher; attestation before any upload) and Overview (`ProjectHeader`, `ResumeWorkCard`,
`SourceSummaryCards`, `AttentionQueue`, empty state, card-shaped skeletons).
`overview_test.py` (11 checks). Deviations: the product name in copy comes from
`NAMING.displayName`; the resume card restores through router state `{ resume: true }` (Phase 7).
---

## Phase 4. Sources: the file browser and the upload pipeline

The core of this plan. It looks like Drive, behaves like Finder, and stays as calm as the rest of the app.

### 4.1 Layout (`routes/SourcesPage.tsx`)
```text
┌ Sources ─────────────────────────────────────────────────────────────────────────────┐
│ hospital_research / MRI / patient_002          [Search in sources]  [≡ | ▦]  [+ Add data ▾] │
├──────────────────────┬──────────────────────────────────────────────┬────────────────┤
│ ▾ hospital_research  │ Name                Kind            Size  Status │ patient_002     │
│   ▾ MRI              │ ▸ series_01   MRI series · 120   48 MB   ✓     │ [preview]       │
│     ▸ patient_001    │ ▸ series_02   MRI series · 96    39 MB   ✓     │ Detected        │
│     ▾ patient_002    │   notes.txt   Document           2 KB    ✓     │  2 MRI series   │
│   ▸ echocardiograms  │                                              │ Used in         │
│   diagnoses.csv      │                                              │  — not yet      │
│ ── Imports ───────── │                                              │ Flags           │
│   Oct 30 · 1,204 ✓ 3 ⚠│                                              │  none           │
└──────────────────────┴──────────────────────────────────────────────┴────────────────┘
```
- [x] Three panes (resizable split, D6): the **tree** (260px), the **listing** of the selected folder, and the
  **inspector** of the selected item (320px, collapsible, remembered).
- [x] The tree's roots are the project's sources (one per import or seed). Below them, a quiet
  **Imports** section lists import sessions (date, counts, state icon); clicking one opens its session
  summary in the listing pane.
- [x] The path bar is a breadcrumb of folder names. Clicking a segment navigates; the last segment shows
  a `•••` with "Copy path" (a deliberate action, because paths may contain identifiers).

### 4.2 Tree (`packages/ui/src/ui/file-tree.tsx`, D5)
- [x] react-arborist, controlled:
  - `data` is built from pages of `/children`, loaded on expand with a 150ms skeleton row.
  - Ids are node ids.
  - `rowHeight` is 28.
  - Height comes from a `ResizeObserver`, as kiwifs's `KiwiTree.tsx` does.
- [x] Row: chevron, Folder/FolderOpen or kind icon, name (compact chains such as `MRI / patient_002`
  rendered as one row, from kiwifs `treeTransform.ts`), then right-aligned hint-color counts and **one**
  status icon (checking spinner, privacy, warning, error). A tooltip shows the full name and the status
  reason.
- [x] Sequences: a run like `scan001…scan120.dcm` (the same `sequence_key`) shows as one
  `FileSequenceIcon` row "scan001–scan120.dcm · 120 files" that expands to the files.
- [x] Sorting is folders first, then natural order (`Intl.Collator` with `numeric: true`), matching the
  server.
- [x] Keyboard follows Finder and Drive (declared as core commands, not hard-coded):
  - arrows move and expand or collapse; Enter opens a folder or the inspector; **Space** opens Quick Look
    (a large preview dialog);
  - ⌘↑ goes to the parent; type-ahead jumps to a name; ⌘F focuses search;
  - Shift- and ⌘-click select ranges and sets.
- [x] ARIA: `role="tree"`, `treeitem`, `aria-expanded`, `aria-level`, `aria-setsize`, `aria-posinset`.
  Check what arborist emits and add what's missing. Focus ring uses `--g-line-focus`.
- [x] Reveal: selecting something elsewhere (an Overview card, an attention row, an assistant link)
  scrolls to the node and plays kiwifs's one-second reveal flash (`kiwi-tree-reveal-flash`), retuned to
  `--g-selection-hover`.
- [x] The tree keeps no rename, move, delete or drag-to-reorder (design implication 2). Context menu:
  Open, Quick Look, Show in Explore, Copy path, and *for a source root* "Remove upload…" (disabled with a
  reason when a dataset uses it).

### 4.3 Listing and inspector
- [x] The list view (default) is virtualized (D6). Columns: Name, Kind (plain label with a count for
  folders and sequences), Size, Status, Added. Sortable; double-click opens.
- [x] The grid view is for folders that are mostly images: thumbnails from inspection (the first slice of a
  series with a default window). A view switch remembers per folder kind, not per path.
- [x] Search: a server-side name search within the project (`?q=`). Results show their folder path in hint
  text, and filter chips for Kind and Status ("Needs attention", "Can't read").
- [x] Inspector sections, each omitted when it has nothing to show:
  - **Preview**: an image, the table head (first 50 rows and column types), DICOM key facts (modality,
    series description, size, spacing, slice count; never patient name, ID or birth date), a video
    poster plus duration and codec, or a PDF's first page.
  - **Detected**: the facts list.
  - **Used in**: datasets and tasks.
  - **Flags**: privacy, duplicate (of which file) or unsupported, each with a next step.
  - **Provenance**: the import session, who added it and when, and the SHA-256 (shortened, copyable).
- [x] Quick Look (Space) shows the same preview large, with ←/→ to step through siblings.

### 4.4 Adding data (`apps/web/src/studio/lib/uploads/`)
- [x] Entry points: the `+ Add data` split button (Files… / Folder… via `<input webkitdirectory>`), drag
  and drop anywhere on Sources or Overview, the empty-state zone, and Home.
- [x] A recursive folder drop uses `DataTransferItem.webkitGetAsEntry()` to walk directories (kiwifs only
  reads `dataTransfer.files`, which flattens or drops folders). `rel_path` keeps the original structure.
- [x] The drop overlay covers the page: a dashed `--g-line-focus` border on a `--g-veil` backdrop reading
  "Drop to add to *patient_002*" (the hovered folder or the root). Dropping onto a *file* row targets its
  folder, as in kiwifs.
- [x] Before upload (client side, in a Web Worker):
  - walk the dropped tree, skip system junk, hash, and build the session request;
  - large batches show "Preparing 1,204 files…" with a cancel button.
- [x] The attestation dialog appears once per project for each person (D7, §3.2).
- [x] The upload tray sits bottom-right and is collapsible, like Drive:
  - one line per session: "Uploading 1,204 files · 38%", then "Checking files…", then "Ready · 3 need
    attention";
  - it expands to per-file rows, with failed files first;
  - **Retry failed**, **Cancel** and **Keep working** are always available;
  - `beforeunload` warns only while bytes are in flight.
- [x] Resume: re-dropping the same folder after a reload matches by hash. Uploaded files show
  "Already in this project" and are skipped.
- [x] Concurrency of 4 files, chunked above 64 MB, exponential backoff, and per-file errors with plain
  reasons ("The connection dropped. Retry", "Too large: limit is 2 GB per file").
- [x] Limits come from env (`STUDIO_API_UPLOAD_MAX_FILE_BYTES`, `…_MAX_SESSION_FILES`), read in
  `apps/api/src/studio_api/config.py`.

### 4.5 Server side of uploads
- [x] Files arrive in `quarantine/<session>/…` in the `BlobStore`, and the server verifies size and SHA-256.
  Accepted files become `Asset` rows and `source_nodes`. Duplicates by hash within a project link to the
  existing asset, with the flag `duplicate_of`.
- [x] Completion emits `source.uploaded` (outbox `PluginEvent`); the worker picks it up (Phase 5). Nothing
  is viewable in the Studio until inspection marks it `ready`.
- [x] ZIP archives are kept as files in P0; "Expand archive" is a P1 action (BACKLOG).

**Exit:**
- `tests/e2e/sources_test.py` (API + worker): drop a nested fixture folder of synthetic PNGs, a CSV, a
  PDF, an unknown binary and a `.DS_Store`. The tree mirrors the folders, junk is skipped, the unknown
  file shows "Can't read this file yet", a re-drop skips everything as already present, and killing the
  page mid-upload and re-dropping completes the session.
- `apps/web/e2e/sources_test.py` (seed mode): keyboard navigation, sequence collapse, Quick Look, search,
  and no patient-ish strings in the URL.


**Done (2026-10-30, branch `todo6-p4`).** `routes/SourcesPage.tsx` with `components/sources/
{source-tree,listing,inspector,quick-look}.tsx`, `stores/sources.ts`; the upload pipeline in
`lib/uploads/`, `stores/uploads.ts`, `components/uploads/`. Tests: `apps/api/tests/test_sources.py`
(6), `apps/web/e2e/sources_test.py` (39 checks, seed mode), `tests/e2e/sources_test.py` (API, SQLite,
local blobstore). Deviations:
- Run ids are opaque (`seq:<folder>:<sha256(key)[:12]>`): they carried file-name patterns into
  URLs. `GET /v1/source-nodes/:id` returns `runId`.
- Duplicates link to the stored asset (bytes kept once) with `duplicate_of`; a folder dropped onto
  a same-named folder merges into it, so a re-drop onto its own source skips everything.
- Quick Look steps with the core `prevItem`/`nextItem` commands (↑/↓ and ←/→). Separate ←/→
  commands broke image2d's freehand e2e (4 of 4 runs) even behind a `when`; not root-caused.
- `source.uploaded` payload: `{projectId, importId, sourceId, nodeIds}` (outbox, idempotency key
  `source.uploaded:<importId>`).
- A real `webkitGetAsEntry` drag isn't e2e-tested (Playwright can't build file-system entries);
  the Folder… picker runs the same walk. Below 1024px the tree and inspector are hidden.
- SQLite answers some concurrent upload chunks with "database is locked"; the client's backoff
  retries them. Postgres untested.
---

## Phase 5. Inspection worker and Explore

### 5.1 Inspection (`apps/worker/src/studio_worker/inspect/`)
- [x] A built-in subscriber like `deid.py` (`EventConsumption` acks), for `source.uploaded`. Per file:
  detect the kind from content, extract facts, make a thumbnail where it makes sense, and set flags.
  Libraries: `pydicom`, `nibabel`, Pillow, stdlib `csv`, `openpyxl`, and ffprobe if present. Check
  licences before adding; `pydicom` and `nibabel` are already named in `docs/product.md`.
- [x] DICOM: group by StudyInstanceUID and SeriesInstanceUID into *candidate* series. Check the slice
  count against InstanceNumber gaps and orientation consistency; a gap is a quality flag, not a silent fix
  (ux.md §7: file count ≠ volume).
- [x] Privacy: reuse and extend the `deid.py` checks to DICOM headers (PatientName, PatientID, BirthDate,
  …) and **path names** (name-like `Lastname_Firstname`, dates, MRN-shaped numbers). A hit sets a
  `privacy` flag and holds the node out of datasets until a person clears it with a reason. That's
  recorded in the audit; this is a development check, not de-identification, as `deid.py` says.
- [x] Tables: delimiter and encoding sniffing, header detection, a per-column type and fill profile, a
  candidate key (unique, mostly non-null), and values that look like folder or file names.
- [x] **Proposals** (status `proposed`, created_by `worker:inspect`), each with evidence:
  - *group*: "120 DICOM files form 1 MRI series (MR, 256×256, 120 slices)".
  - *relationship*: table column ↔ folder or file names, after normalizing IDs (`P001` = `p-001` = `1`
    only when the column is numeric-like, never across names). Evidence: matched, unmatched and ambiguous
    counts plus examples.
  - *dataset/task*: for clean sets, a proposed dataset definition plus a preset (`preset:image-2d` plus
    label classes from a categorical column).
- [x] Session state moves to `needs_review` when any proposal or flag needs a person, else `ready`.

### 5.2 Explore (`routes/ExplorePage.tsx`)
- [x] Tabs: **Summary · Relationships · Mappings · Quality**. The URL holds the tab and the selected proposal id.
- [x] **Summary** (`ShapeSummary`): the three levels from ux.md §7 as columns:

  | Level | Shows |
  |---|---|
  | Files | file counts per kind, all detected facts |
  | Records | series, studies, tables, documents; proposed groups marked dashed |
  | Tasks | existing tasks, plus proposed ones |

  A clean project shows one card: "Ready to annotate: **Create dataset & open Studio**" (ux.md §7, last line).
- [x] **Relationships** is a list first and a graph later (P1).
  - Each row reads "`diagnoses.csv` › `patient_id` ↔ `MRI/` folder names", followed by strength words,
    "118 matched · 2 not found · 0 ambiguous", and **Why?** (evidence and examples), **Confirm**, **Edit**,
    **Dismiss**.
  - Editing lets the user pick a different column, or say how IDs are written ("ignore leading zeros").
    The server recomputes the matches.
  - **Unmatched and ambiguous rows** list inline, with a fix for each (pick the folder, or skip the row).
    Nothing merges until confirmed, and never by filename alone for patient identity (ux.md §6).
- [x] **Mappings** (`MappingReview`): source field → dataset field, with three example values, a conflict
  badge and the same Confirm, Edit and Dismiss. P0 shows the label mapping (a categorical column → label
  classes) needed for the acceptance flow.
- [x] **Quality**: missing values, duplicates, mismatched IDs, unsupported files, series gaps and privacy
  holds, each linking to the exact node or row.
- [x] Confirming a *dataset/task* proposal:
  - shows an **action preview**: the dataset name, which files, how items group, the label classes, and
    "imports 118 labels as *imported* annotations" (D8);
  - **Create & open Studio** then creates the dataset and task, writes the environment, and navigates to
    `/projects/:p/studio/:task`.

**Exit:** ux.md §13 "Mixed data import", as `tests/e2e/mixed_import_test.py`:
1. Import a folder of synthetic PNGs, `labels.csv` and unrelated files.
2. Originals are preserved, and shapes are detected.
3. The CSV↔image relationship is *proposed* and not applied: the annotation count is 0 before
   confirmation.
4. Confirming it opens the 2D Studio with the CSV's classes as labels and the imported labels shown with
   the `imported` badge.
5. Reloading the page keeps everything.


**Done (2026-10-30, branch `todo6-p5`).** Worker: `apps/worker/src/studio_worker/inspect/{detect,dicom,
privacy,tables,media}.py` (new deps, all permissive: pydicom MIT, Pillow MIT-CMU, nibabel MIT,
openpyxl MIT, numpy BSD). Kernel: `kernel/{inspection,explore}.py`, `routes/{worker,explore}.py`.
UI: `routes/ExplorePage.tsx`. Tests: `apps/worker/tests/test_inspection.py`,
`apps/api/tests/test_explore.py`, `tests/e2e/mixed_import_test.py`. Deviations:
- The worker reports facts, flags and series groups; the **kernel** builds relationship, mapping
  and dataset proposals, so server-side recompute and first proposals share one matcher.
- ID rule: `P001` = `p-001` = `1` = `patient_001` = `pt001`; the numeric rule is refused for
  non-numeric-like columns and caps strength at "possible". A relationship needs ≥ 2 matches and
  ≥ 30% of rows (one coincidental `s1` ↔ `series1` isn't one).
- DICOM UIDs are stored as hashes; privacy flags name fields, never values.
- `SeedAsset` gained optional `name` and `nodeId`; image2d's `groupItems` shows `a.name`.
- New routes `GET /v1/projects/:id/explore`, `GET /v1/proposals/:id/preview`; audit
  `import.inspected`.
- Integration: the assistant's `propose_relationship`/`propose_schema` payloads are rebuilt by
  the kernel (`explore.from_agent`) into Explore's shape with computed evidence; Explore and
  Sources register their assistant context.
- Not done: ffprobe and NIfTI facts have no tests; confirming a `group` proposal only marks it;
  Explore in seed mode says it needs the full stack.
---

## Phase 6. The assistant everywhere (P0: read-only context)

- [x] Split `core/panels/ai.tsx` into a reusable `AssistantPanel` (thread, composer, cards, consent) and two
  hosts:
  - the Studio's right slot, as today: same testids, `agent-log` included;
  - a `PersistentAgentDrawer` in `ProjectShell` (340px, resizable, toggled by the same AI button and
    command).
- [x] An `AgentContextProvider` per section supplies `snapshot()` and `turnContext()`:
  - Overview: the project summary.
  - Sources: the selected node and its facts, never file contents.
  - Explore: the selected proposal.
  - Studio: today's `buildAgentContext`.

  `lib/agent/context.ts` becomes one of these providers.
- [x] Threads are already keyed by project id (`stores/agent.ts`), so the conversation survives section
  changes. A `ContextIndicator` chip above the composer says what the assistant can see ("Sources ›
  MRI/patient_002"), and the user can remove it.
- [x] New read-only tools in `apps/agent/src/tools/project.ts`:
  - `project_overview`, `list_sources`, `describe_source_node`, `list_proposals` and
    `list_import_issues`, all through kernel routes with the run's session token;
  - a client card tool `open_location`, which renders "Open Sources › MRI/patient_002" as a button; the
    agent never navigates by itself.
- [x] P1 hooks, built now behind the existing approval cards:
  - `propose_schema` and `propose_relationship` create `proposals` rows (`created_by: agent:<run>`). They're
    safe because proposals change nothing.
  - Confirming stays a human click in Explore, and the card links there.
- [x] `restricted` projects and privacy-held nodes are never sent to a third-party model. The existing
  `Consent` gate extends to "this project contains held files; the assistant won't see them".

**Exit:** `tests/e2e/agent_test.py` gains a scripted run: ask "What did I import?" on Sources, get an
answer from `list_sources`, switch to Overview, and the thread and context chip update. The agent's
attempt to confirm a proposal is refused by the API (403) and reported as such.


**Done (2026-10-30, branch `todo6-p6`).** `components/ai/{assistant-panel,agent-drawer}.tsx`,
`lib/agent/{providers,session}.ts`, `apps/agent/src/tools/project.ts`, `packages/agent-protocol`
(card kind `location`, `ApprovalDetail`). `tests/e2e/agent_test.py` 26/26 against the real kernel,
including the real 403 on confirm. Deviations:
- One conversation and agent session per project, shared by the drawer and the Studio slot;
  outside the Studio, environment tools answer "Needs the Studio".
- `agent:<run>` comes from an `X-Agent-Run` header, honoured only for `agent:` session tokens (the
  browser mints the token before the run exists).
- Restricted projects share structure only (kinds, counts, statuses), not nothing; held files are
  counted, never named.
---

## Phase 7. Studio integration

- [x] Route `/projects/:p/studio/:task`. `DatasetStudioPage` loads `GET /v1/tasks/:id/document` (seeds:
  the manifest project, same shape), so nothing below the page changes.
- [x] Files tab (`core/panels/files.tsx`) stays task-scoped. For volume and series data kinds it lists
  series or studies (it already groups by `item.group`). Add the data-kind icon and the `imported` or
  annotated state per item. No source tree here (ux.md §8).
- [x] Resume writes (D9): debounced `PUT /resume` on item, placement or tool change, and on `pagehide`.
- [x] Status bar rule from ux.md §8: millimeters only when the item has calibrated spacing. Audit
  `CanvasStatusBar` and each renderer's `viewerStatus` for "px shown as mm".
- [x] Project rail (Phase 2) plus the dockview panels: hiding both side panels leaves a full-width canvas;
  every tool keeps working with the assistant closed (`apps/web/e2e` already covers the tools).

**Exit:** the full `apps/web/e2e` suite passes on the new routes (harness updated, redirect test kept), and
resume returns to the same item, slice and tool after a reload and from Overview.


**Done (2026-10-30, branch `todo6-p7`).** `DatasetStudioPage` loads `GET /v1/tasks/:id/document`;
`lib/resume.ts`; Files tab kind icons and Annotated / Imported / AI-suggestions states; a
left-panel toggle (`toggleSidePanel`, shift+mod+B); `harness.py` opens `/projects/{id}/studio/{id}`
(the redirect is tested in `navigation_test.py`). New e2e `resume_test.py` (15) and
`studio_layout_test.py` (9). Deviations:
- Placement is `{plane, slice}` (volume), `{frame, slice}` (cine), `{frame}` (video), applied
  through a new SDK hook `useRequestedPlacement` and `MprEngine.goToSlice`.
- Resume restores on router state `{ resume: true }`, `?resume`, or a reload of the Studio; a
  plain link doesn't. Writes wait for the restore to settle.
- mm audit: the volume showed "… mm" always (and "undefined mm" before load), cine treated a
  missing NIfTI pixdim as 1 mm. Both now say "No voxel/pixel spacing". NIfTI unit code 0 is still
  read as mm (as most tools do).
- Not done: the task title in the status bar (ux.md §8, not in this exit).
---

## Phase 8. Datasets, Review and Activity sections

- [x] **Datasets** (`routes/DatasetsPage.tsx`): a list of datasets with their tasks, each task with
  **Open Studio**. Dataset detail has tabs **Tasks · Versions** (the existing `VersionsPage`) ·
  **Publish & export** (the existing `ExportPage`). **New dataset** without a proposal is a simple form
  (pick folders, pick a preset); the guided path stays Explore.
- [x] **Review** (`routes/ProjectReviewPage.tsx`): one filterable queue (filters by type, severity and
  dataset) over:
  - import issues;
  - privacy holds;
  - unconfirmed proposals;
  - version review requests (versioning);
  - annotation review: today's `/datasets/:id/review` content per task.

  Each row opens its exact surface. The Overview attention queue is the top 5 of this list, from the same
  endpoint.
- [x] **Activity** (`routes/ActivityPage.tsx`): a chronological feed from `PluginAudit` (rename in docs
  only: "the audit log"), import sessions, proposal decisions, dataset and task creation, version commits
  and merges, and environment revisions. It's grouped by day. Each entry names who (person, or assistant
  on behalf of a person, from `SessionDelegation`), what, and links to the artifact. Write every new action
  in Phases 1–7 to the audit log with these action names: `project.created`, `import.completed`,
  `proposal.confirmed`, `privacy.cleared`, `dataset.created`, `task.created`.
- [x] Settings › Plugins hosts today's `PluginsPage`; Settings › General has the title, description,
  visibility and archive.

**Exit:** every attention item type has a test that clicks through to the right place, and Activity shows
the mixed-import flow's events in order with the right actors.


**Done (2026-10-30, branch `todo6-p8`).** `routes/{DatasetsPage,ProjectReviewPage,ActivityPage,
ProjectSettingsPage}.tsx`; `GET /v1/projects/:id/review?type=&severity=&dataset=`; Overview's
attention is the queue's top 5. Tests: `apps/api/tests/test_review_activity.py`,
`apps/web/src/studio/lib/routes.test.ts`, `apps/web/e2e/sections_test.py` (22),
`tests/e2e/review_activity_test.py` (21). Deviations:
- Version review rows come from the kernel's `versioning.review.open` audit entries minus those a
  `versioning.merge` closed (no call to apps/versioning); a review closed another way stays listed.
- `proposal.created` is audited in `create_proposal`; activity actors are person, assistant (on
  behalf of, from `SessionDelegation`) or system.
- The per-task annotation list lives at `/projects/:p/review/:taskId`.
- `review_activity_test.py` writes a privacy flag, an unknown kind and a version-review audit row
  straight to the kernel DB, so it must share the API's `STUDIO_API_DATABASE_URL`.
- Not done: Settings › Members (backlog); seed-mode activity has only the sample-load entry.
---

## Phase 9. Verification and usability

- [x] All `AGENTS.md` checks, `uv run pytest`, `go test ./...`, both e2e suites twice in a row.
- [ ] Accessibility pass on the new pages:
  - tree and list keyboard-only (navigate, open, Quick Look, search);
  - focus order and visible focus;
  - every status has text, not only color;
  - 200% zoom without clipped controls (`docs/ui.md` §7).
- [ ] Performance budget:
  - a folder of 10,000 files lists in under 500ms after the first page;
  - expanding a 2,000-child folder doesn't drop frames (virtualized);
  - preparing a 1,000-file drop shows progress within 300ms.
- [ ] Five moderated sessions with target users (radiology and cardiology researchers, a research
  coordinator), using the synthetic hospital-style fixture. Tasks:
  1. Start a project with this folder.
  2. Find patient 2's second MRI series.
  3. Link the diagnoses to the scans.
  4. Start labeling, close the tab, and come back.

  Measure time to the first Studio from the drop (product.md §13), unaided completion, and every moment
  of hesitation. Record findings in `docs/ux.md` §15 (new "What we learned").
- [x] Update the docs:
  - glossary rows for Organization, Project, Source, Import session, Dataset, Collection, Task, Proposal
    and Version (D1);
  - `docs/ui.md` §2 and §6 point to `docs/ux.md` for the IA, and keep the Studio rules;
  - `docs/product.md` §6 entities;
  - `docs/running.md`, for which flows need the API (D4).


**Status (2026-10-30, branch `todo6-int`).**
- Checks, all on the merged branch: root `pnpm typecheck` (10/10) and `pnpm test` (7/7), web unit
  tests 294, API pytest 120 (7 skipped), worker pytest 20, agent 110 (15 skipped), `go test ./...`,
  ruff, `check:boundaries`, `check:names`, `check:icons`, `check:python-imports`, `emit:schemas
  --check`, OpenAPI `--check`. `pnpm lint` passes except `apps/versioning` (no `golangci-lint`
  here; BACKLOG). The merge's pyright run caught 18 type errors in the new worker and kernel code
  that the phase branches hadn't run; fixed.
- `apps/web/e2e`, twice in a row on one frozen server: every suite passed both rounds except the
  drawing checks of `image2d_test` (eraser / SEG pixel count) and `volume3d_test` (island count),
  which each failed in one round and passed in the other. They're flaky on unmodified `main` too
  (`image2d_test` 1 of 3 runs failed there) under this machine's load. `navigation_test` 30/30 three
  times after the switcher fix.
- `tests/e2e` against API + worker + agent (SQLite, local blobstore, no Docker), twice:
  `sources_test` 18/18 (the "can't read" check now runs, with the real worker),
  `mixed_import_test` 30/30, `agent_test` 26/26, `review_activity_test` 21/21. Merging broke two
  tests (testids the Sources page replaced) and the assistant's folder↔folder proposal; fixed.
- Not done: the accessibility pass (keyboard-only, focus order, 200% zoom) and the performance
  budget were not measured (only the e2e keyboard checks in `sources_test.py` ran); the five
  moderated sessions need people.
- Docs: glossary, `docs/ui.md` §2/§6, `docs/product.md` §6, `docs/running.md` (seed mode vs the
  API and worker, running them without Docker, the upload limits), `docs/ux.md` §6/§11 (routes,
  import states). `ui.md` §5A, §10 and its last line still describe the dataset-first flow.
---

## Phase 10. Leave the rest on the backlog

Move these to `todo/BACKLOG.md` (one line each, linking here):
- cross-project Datasets index;
- expanding archives;
- connectors (S3 bucket, PACS/DICOMweb via Orthanc);
- a relationships graph view;
- schema mapping for many-field tables;
- assistant write tools beyond proposals (create collection or task with approval);
- review status ("13 of 20 reviewed");
- members and roles UI;
- version comparison in Activity;
- mobile parity.

---

## Order and size

| Phase | Depends on | Size | Risk |
|---|---|---|---|
| 0 Decisions D1–D10 | — | an hour with the user | none |
| 1 Model and API | D1–D4, D7–D9 | 3–4 days | medium: migration `0004` moves environments and annotations to task keys (D3); the seed backfill must be idempotent |
| 2 Shell and routes | 1 (types), D10 | 1–2 days | medium: the e2e URL contract (redirects keep it) |
| 3 Home and Overview | 1, 2 | 2 days | low |
| 4 Sources | 1, 2, D5–D7 | 4–5 days | high: uploads, resume, large trees; most new UI |
| 5 Inspection and Explore | 4 | 4–5 days | high: matching heuristics must not over-claim; privacy holds |
| 6 Assistant everywhere | 2; 5 for proposal tools | 2 days | medium: keep the Studio's agent testids |
| 7 Studio integration | 1, 2 | 1 day | low |
| 8 Datasets, Review, Activity | 1, 5 | 2–3 days | low |
| 9 Verification | all | 2 days plus sessions | — |

Phases 3, 6 and 7 can run in parallel worktrees once 2 lands. Phase 4's tree and listing (4.1–4.3) can start
against the seed-server stand-in before the upload backend (4.4–4.5) is done.

## Reference files to copy from

| What | Where | Take | Leave |
|---|---|---|---|
| Tree on our stack | `~/kiwifs/ui/src/components/KiwiTree.tsx`, `tree/TreeRow.tsx`, `lib/treeTransform.ts`, `lib/treeRefresh.ts` | arborist setup, compact chains, natural sort, `ResizeObserver` height, reveal flash, live refresh that waits for optimistic updates, skeleton rows | whole-tree fetch, rename and move, the chartreuse theme |
| Live updates | `~/kiwifs/ui/src/App.tsx` (EventSource → refresh key) | SSE → React Query invalidation | — |
| File icon component | `~/patch/apps/web/src/components/ui/file-icon.tsx` | lookup order: full name, then extension, then fallback; one component | brand-colored simple-icons |
| Compact rows, filter | `~/patch/apps/web/src/components/interface/ops/codebase-tab/codebase-tab.tsx` | the `searchTree` subtree filter, child counts, skeleton rows | fixed width, no keyboard or ARIA |
| Drill-down for non-technical users | `~/patch/apps/web/src/components/interface/secret-managers/add-secret-dialog.tsx` | the breadcrumb plus flat folder list, for small pickers ("choose folder" in New dataset) | — |
| Progress strip | `~/patch/.../codebase-tab/codebase-indexing-sign.tsx` | a thin progress bar under a tinted banner, for "Checking files…" | — |
| Navigation rail | Gravity UI AsideHeader (compact mode) | collapse behavior, tooltip labels, active marker | the `@gravity-ui/navigation` package itself |
