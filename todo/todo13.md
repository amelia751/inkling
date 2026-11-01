# Drop anything: from an empty screen to a working Studio and dataset

**Goal.** A person opens the product with nothing in it. They either say what they're making ("chest
X-ray classification, five labels"), or drop whatever they have into the chat: twelve PNGs, a ZIP of
DICOMs, a CSV, a PDF protocol, a voice memo. Within a minute they're working in a Studio on real
items. The dataset behind it appears in **Datasets** with its structure drafted. Every dropped
thing is a **File** they can find again, like the files shared in a Messenger conversation. Later
they drop something completely different, and that's handled just as calmly.

Everything is already half there: uploads, inspection, the boot route, live items, versioning and
the pipeline design. This plan joins them into one experience.

**Status (2026-11-01).** Plan written; nothing started. todo12 is in flight: `todo12-deploy` is
merged; `todo12-engine`, `-kernel`, `-pipeline` and `-web` are in worktrees. Design inputs:
`docs/pipeline.md`, `docs/datasets.md` (Datasets UI spec), `docs/ux.md`.

**Naming.** As in todo12: the product name appears only in `packages/contracts/src/naming.ts`.
UI copy that needs it uses `NAMING.displayName`; env vars are written here without their prefix.

---

## Start here (agents)

This file plus `AGENTS.md` is the whole brief.

1. **Read, in order:**
   1. `AGENTS.md`;
   2. this file: §0 (audit), §1 principles, §2 decisions, §3 the journey, your milestone in §4,
      §5 (workstreams, contracts, rules), §6 budgets;
   3. `docs/datasets.md`, `docs/pipeline.md` (P§ below), `docs/agent.md`, `docs/files-api.md`,
      `docs/deployment-gcp.md` ("What the agent sees");
   4. `todo/todo11.md` Milestones 2–3 (boot, `item.*`) and `todo/todo12.md` §5 (what todo12 owns);
   5. the files in your workstream's row in §5.
2. **Set up:** `git worktree add .worktrees/todo13-<name> -b todo13-<name> main`. Work only there;
   never merge, never edit this file (report instead).
3. **The data boundary holds** (`todo/todo10.md`, "Start here", point 3), and it matters more here
   than anywhere: a file dropped into chat is customer data. **Its bytes go to Files in
   `spurby-phi` through the person's browser, never to the agent, the model or a sandbox.** The agent
   gets file IDs, screened names and typed technical facts (§2, D3). The agent's transcript lives in
   `spurby-ai`, so nothing stored there may contain an original file name that failed screening, a
   thumbnail, a URL to bytes or a content-derived value.
4. **Don't touch todo12's files** (todo12 §5): `apps/pipeline/**`, `packages/contracts/src/pipeline/**`,
   `kernel/{queue,jobs}.py`, `routes/pipelines.py`, `apps/web/src/studio/core/pipelines/**`. Where
   this plan needs the pipeline, it uses todo12's contracts and falls back to today's import flow
   until todo12 Milestone 1 merges (D9).
5. **Hand back:**
   - done per item against its exit tests;
   - commits, migrations, routes, events, agent tools and scope entries added;
   - the checks run (`AGENTS.md` list plus your e2e) and the journey timings you touched (§6);
   - screenshots of every empty state and card you changed;
   - what's left.

**Prompt for each agent:**

> Read `todo/todo13.md` in the repo from "Start here (agents)" and follow it. You are workstream
> `todo13-<name>`. Do every item §5 assigns to you, to its exit tests.

---

## 0. Where we are (audit, 2026-11-01, `main` 200a0e5)

### Entry points and empty states

| Surface | Today | Problem |
|---|---|---|
| Home `/` | Goal field ("drop files here"), page-wide drop → `/projects/new`; "No projects yet. Drop a folder anywhere…" | No agent: you can't ask anything before a project exists |
| Projects `/projects` | `EmptyState` "No projects yet", Create project | Second, different empty state for the same situation |
| New project | `DropZone` "Drop files or folders here" | A form between the person and their data |
| Overview (empty project) | `EmptyProject`: drop zone + "Or tell {product} what you're trying to create" (`tell-assistant`) | The best empty state; the others don't match it |
| Data (Files) | "Add the files you have"; empty folder "This folder is empty" | Fine; sidebar label "Data" while everything else says Files |
| Explore | "No files yet. Add data" | Off the sidebar |
| Datasets | Card linking to New dataset / Explore (`no-datasets`) | **Off the sidebar**; reached by URL or a redirect hint |
| Studio entry, 0 tasks | Redirects to Datasets with `?hint=no-task` | Sends people to a page they can't find in the nav |
| Studio, no item | "Nothing to annotate" | Dead end; no drop target on the canvas |
| Review, Activity, Versions | Tidy empty states | Fine |
| Agent drawer | Section-specific prompts; **text-only composer, no drop, paste or attach** | The core gap |

Sidebar: Overview, Data, Studio, Review, Activity, Settings (`app-layout.tsx` 60–67). Explore and
Datasets are deliberately off it. Drops are handled per component (Home, Overview, Files, the Studio
Files panel); there's no drop on the composer and none on the Studio canvas.

### Agent

- Composer: textarea only (`components/ai/assistant-panel.tsx` 268–331). `SendMessageRequest` is
  `{text, context?, snapshot?, kernelToken?}` (`packages/agent-protocol/src/index.ts` 177–185);
  the model gets a string (`apps/agent/src/runtime/sessions.ts` 544, 608). No attachment exists, so
  no boundary violation today.
- Available only inside a project (`app-layout.tsx` 180; sessions require `projectId`). The Studio
  uses the same thread in its AI panel.
- Can read Files (`list_folder`, `find_files`, `describe_source_node`, `list_assets`), fingerprints,
  proposals; can boot (`boot_studio` → `POST …/boots` with `files`/`folders`); can't upload, create
  projects, create tasks or publish (`kernel/agent_scope.py`).
- `resolveIntent(text, table, {fileKinds})` accepts file kinds (`packages/studio-tools`), but
  nothing supplies them from a drop.
- Real-model "request to usable Studio" has **never been measured**; the scripted boot is ~1.3 s.

### Data

- **Every upload already becomes a File**: import session → quarantine → SHA-256 → content-addressed
  asset → `SourceNode` in the drive, with a `Source` row recording provenance
  (`kernel/imports.py`). Duplicates are linked, not re-stored.
- **Inspection** sets `detected_kind`, facts and flags (`kernel/inspection.py`, worker `detect.py`):
  image, DICOM, video, waveform, table, document, archive, unknown. Unknown and unsupported files
  stay in Files with a flag.
- **Datasets** in the kernel are a frozen pin of file versions (`DatasetRow.definition.files`) plus
  followed folders; versions live in `apps/versioning` (manifest `schema_version: "1"`, no field IDs).
- **Proposals** (`group`, `relationship`, `mapping`, `dataset`, `task`) suggest structure; a person
  confirms.
- **Studio items** come from the task's pinned dataset files plus live `task_items` (todo11);
  `VIEWABLE` kinds only. **Collections (todo11 D7) were never built**: one Studio shows one kind.
- **Nothing links a file to the conversation it was shared in.**

---

## 1. Principles

1. **One way in, everywhere.** The same composer, with the same drop, paste and attach behavior, on
   Home, in every project page's drawer and in the Studio panel.
2. **Every dropped thing is a File first.** Whether it also becomes dataset data is a separate,
   visible decision. Nothing is thrown away, and nothing is silently promoted.
3. **Fast path first, model second.** If the drop's kinds and the request map to a preset
   deterministically, boot immediately; the agent refines afterwards. A slow model never holds the
   first minute hostage.
4. **Usable before complete.** The Studio is usable when the first items are ready, not when the
   last byte lands (todo11 §7).
5. **The agent organizes; the person decides.** The agent drafts plans and structure. It applies
   them on its own only to the person's drafts. Publishing, moving `main` and deleting stay with
   the person.
6. **Bytes stay in `spurby-phi`.** Thumbnails are rendered in the browser from the api; the agent
   and its transcript hold IDs and screened names only.
7. **Datasets explains, Files stores, Studio works.** No screen does another's job (`docs/datasets.md`
   §1).

---

## 2. Decisions

| # | Decision |
|---|---|
| D1 | **Agent on Home.** Home shows the composer. The first send or drop creates a project on the person's behalf (browser, person API, named from the goal or the first files, renamable), then opens the conversation in it. The agent still can't create projects itself. |
| D2 | **Chat drops are uploads.** Drop, paste (including screenshots) and an attach button on the composer. The browser uploads through the normal import route with `origin: chat`. The files land in a system folder **Shared in chat** (one subfolder per conversation, named after it), and each upload records which conversation and message it came with. The message carries a **drop** reference, not bytes. |
| D3 | **What the agent sees of a drop:** a `DropSummary` (counts by kind, groups, sizes, states) and, per file, its node ID, a **screened name**, its kind and technical facts (dimensions, frame count, duration, modality, column names and types, page count). Names are screened for identifiers (Sensitive Data Protection in `spurby-phi`, a regex screen in dev); a flagged name becomes `image-0007.png` for the agent and in the transcript. Never pixels, text content, cell values or raw DICOM headers. |
| D4 | **Messenger-style Files.** Each conversation has a **Shared files** view (the drops in it, newest first, with thumbnails for the person). Removing a file from the chat removes the reference only; the File stays in Files until the person deletes it there. Files shows provenance: "Shared in chat · <conversation> · <date>". |
| D5 | **Every drop gets a plan.** After inspection, a drop is classified into groups, and each group gets one action: **add to an existing collection**, **new collection in an existing dataset**, **new dataset**, **unpack** (archives), **keep in Files as reference** (PDF, DOCX, notes) or **keep in Files, can't use yet** (unknown and unsupported kinds). The plan is a `DropPlan`, shown as a card in chat. |
| D6 | **Who applies a plan.** Deterministic rules decide most groups (§3.3). The agent can change the plan before it's applied. Actions that only touch the person's drafts (new draft dataset, new collection in a draft, add to a draft) apply automatically, with an Undo on the card. Actions touching a published dataset, or anything ambiguous, wait for the person's click. |
| D7 | **Collections, finally (todo11 D7).** A dataset has collections (one logical kind each: "Chest X-rays", "CT series", "Labels table"). A Studio works on one collection and has a collection switcher when the dataset has several. A mixed drop becomes several collections in one dataset when they belong together, or several datasets when they don't. |
| D8 | **Dataset structure is a typed draft from day one.** `DatasetStructure v1` (§5): collections, fields with stable IDs, formats, relationships and annotation definitions with stable label IDs. The agent drafts it from inspection facts and the request; every inferred part is tagged `suggested` until the person confirms. It's stored in the dataset's versioning tree as `structure.json` on the working draft, so todo12's schema engine (Milestone 2) builds on the same file instead of inventing another. |
| D9 | **Pipeline integration.** A drop's import is the implicit ingest pipeline's trigger (P§6). Until todo12 Milestone 1 merges, the same steps run as today (import, inspect, derivatives) and the plan is applied by the kernel; after it merges, applying a plan starts a pipeline run whose candidate commit is the dataset's working draft. The UI reads both through the same `drop.*` events. |
| D10 | **Navigation.** Sidebar: Overview, **Files** (renamed from Data; Sources live inside it as provenance), **Datasets**, Studio, Review, Activity. Explore stays reachable from Datasets ("Needs attention"). Pipeline runs stay where todo12-web puts them (under Files). |
| D11 | **Studio canvas accepts drops**, and so does the Studio's chat. Both create a drop in the current conversation; same-kind files join the current collection live (todo11 `item.*`); a different kind gets a plan card ("These are CT series. Add a collection?"). |
| D12 | **The one-minute budget** is measured from the first drop or send to the first item interactive in a Studio, with a real model (§6), and gated in e2e with the scripted model. |

---

## 3. The journey

### 3.1 Empty start

**Home, no projects.** One centered composer:

> **What are you working on?**
> Drop files here, or describe it: "Label 200 chest X-rays as normal or pneumonia."
> [ attach ]                                                   [ Send ]
> Examples: Segment liver CT · Classify skin lesions · Annotate ultrasound video

Dropping anywhere on the page is the same as dropping on the composer. **Projects** (the list) uses
the same composer when there are none. `/projects/new` stays for people who want the form.

**Empty project (Overview).** Same composer inline, plus recent projects nowhere (it's empty).
**Files, Datasets, Studio entry, Review** in an empty project: each says what will appear there and
offers the composer's two actions ("Drop files", "Ask the assistant"), not a link to another page.

| Surface | Empty copy (proposed) | Actions | `data-testid` |
|---|---|---|---|
| Home | "What are you working on?" | composer, drop anywhere | `home-composer` |
| Overview | "Start by dropping files, or describe what you want to make." | composer | `empty-project` (keep), `tell-assistant` (keep) |
| Files | "Everything you add or share in chat lives here." | Add files, Ask the assistant | `files-empty` |
| Datasets | "Your datasets will appear here once you add data. Drop files, or describe what you need." | Drop files, Ask the assistant, Create dataset | `datasets-empty` (replaces `no-datasets`) |
| Studio entry | "No Studio yet. Drop files or describe your task, and one will open here." | composer | `studio-empty` |
| Studio canvas, no item | "Drop files here to start, or ask the assistant." | canvas drop, open chat | `studio-canvas-empty` |
| Chat, new conversation | "Drop files, paste a screenshot, or tell me what you're making." | attach, drop, examples | `agent-empty` |
| Shared files | "Files you share in this chat appear here." | attach | `chat-files-empty` |

### 3.2 First drop

1. **Drop** (any surface). The browser hashes and uploads (existing import route, `origin: chat`,
   conversation and message IDs). The message shows a **drop card**: file chips with live states
   (uploading, checking, ready, kept, failed) and thumbnails as they arrive.
2. **First file inspected** (≈1–2 s): `drop.classified` with the first groups.
3. **Fast path:** if the groups and the request (or, with no request, the kinds alone) resolve to one
   preset through the intent table, the kernel applies the plan and boots immediately (`boot.*`,
   todo11). The person lands in the Studio on the first ready item while the rest stream in.
4. **Agent pass**, in parallel: the agent gets the `DropSummary`, drafts `DatasetStructure`
   (collections, fields from facts, labels from the request), and patches the environment (todo11
   tools). It explains what it did in one short message.
5. **Datasets** shows the new dataset (draft) with its collection, structure (suggested parts
   tagged), and "N files processing".

No request and an ambiguous drop (say, 3 images and a CSV): the fast path still boots on the images;
the plan card asks one question about the CSV ("Is this a labels table for these images?").

### 3.3 Classification rules (deterministic; the agent may override before apply)

| Group | Default action |
|---|---|
| Same kind and shape as a collection in the current dataset | Add to that collection |
| Viewable kind, no matching collection, current dataset is a draft | New collection in the current dataset |
| Viewable kind, no current dataset, or the current one is published | New draft dataset |
| DICOM files | Grouped into studies and series first (existing `group` proposal), then as above |
| Table (CSV, XLSX, Parquet) whose key column matches file names or IDs in a collection (by name pattern, not content values) | "Labels or metadata for <collection>?" (asks) |
| Table with no match | New tabular collection (asks if the dataset has other kinds) |
| Archive (ZIP, TAR) | Unpack (bounded, safe extraction, P§6 step 3), then classify the contents as a new drop |
| Document (PDF, DOCX, TXT, MD) | Keep in Files as reference; offer "Attach to dataset as documentation" |
| Audio, unknown, unsupported, or failed inspection | Keep in Files, can't use yet; offer "Find a plugin" (catalog search) |
| Already in Files (same SHA-256) | Link to the existing File, no re-upload; the chip says "Already in Files" |
| Flagged by the privacy screen (burned-in text, identifiers) | Normal action, plus a quarantine notice on the card; not usable in a dataset release until reviewed (existing flags) |

### 3.4 A different drop later

The person, in a chest X-ray Studio, drops a folder of CT series and a PDF.

- The CT group doesn't match the current collection: the card offers **"Add a CT collection to this
  dataset"** (default when the dataset is a draft) or **"Start a separate dataset"**. Applied to a
  draft, it's automatic with Undo.
- A new collection gets its own Studio (task) with a CT preset; the Studio header's collection switcher
  shows both. The current Studio doesn't reload or change.
- The PDF is kept as reference. Nothing else changes.

Other later drops: more X-rays join live (todo11); a duplicate links; a 5,000-file folder streams
with the first items usable in seconds; a drop on Home while a project exists asks "Add to
<last project> or start a new one?".

### 3.5 Asking without files

"Classification of chest X-rays into five labels." The fast path boots an empty Studio on a new draft
dataset with an empty collection and the five labels in the structure. The canvas says "Drop files
here to start". The first drop fills it.

---

## 4. Milestones

### Milestone 1: one composer, real chat files (`todo13-entry`, `todo13-drops`)

**`todo13-entry`:**

1. Home composer (D1), drop anywhere on Home, project creation on first send or drop
   (person API), then navigate to the project with the conversation open and the drop or message
   delivered.
2. Agent drawer on every project page; Studio AI panel unchanged; one thread per conversation as
   today.
3. Sidebar per D10; rename "Data" to **Files** in labels only (keep routes and `data-testid`s, add
   new ones beside).
4. The empty states in §3.1, all using one `ComposerEmptyState` component from `@studio/ui`.
5. Studio canvas drop target and `studio-canvas-empty` (D11), creating a drop in the current
   conversation.

**`todo13-drops`:**

1. **Composer attachments**: drop, paste, attach button, folder drop; chips with progress; cancel
   before send; send with text, or drop alone (a drop alone is a message).
2. **Import origin**: `POST /api/v1/projects/{id}/imports` accepts
   `origin: {kind: "chat", conversationId, messageId}`; kernel table `drops` (§5) groups the
   sessions of one gesture; nodes land in **Shared in chat/<conversation>**; `Source.kind = chat`.
3. **Name screening** (D3): on import complete, each name is checked; the result is stored on the
   node (`agent_name`, `name_flagged`). Sensitive Data Protection through the api in `spurby-phi`
   (todo10 broker pattern); a regex screen (dates, MRNs, emails, phone numbers, two capitalized
   words) in dev and tests.
4. **Protocol**: `SendMessageRequest.drop?: {dropId}`; user message part
   `{type: "drop", dropId, files: [{nodeId, agentName, kind?, state}]}`; agent context gets
   `DropSummary` (§5). The agent's store records the message part as is: IDs and screened names.
   `ag-ui-map.ts` gains the mapping (todo11 D4; a `custom` event).
5. **Agent tools**: `get_drop(dropId)` returns the `DropSummary`, refreshed as inspection proceeds;
   `describe_source_node` returns the screened name. Add `GET /api/v1/drops/{id}` to
   `AGENT_ROUTES` and to `docs/deployment-gcp.md`'s agent route list.
6. **Shared files** view per conversation (D4), and "Shared in chat" provenance in the Files
   inspector. Removing a file from a chat removes the reference.

**Exit tests (Milestone 1):**

- e2e `apps/web/e2e/chat_drop_test.py`: drop 12 PNGs on Home with no projects → a project exists,
  Files has them under Shared in chat, the chat shows the drop card with live states;
- paste a screenshot into the Studio chat → a File, a chip, a `drop.*` event;
- a file named `Smith_John_1962-04-03.dcm` reaches the agent as `dicom-0001.dcm`; the agent
  store's rows for that conversation contain no `Smith` (assert in `tests/e2e/agent_test.py`);
- the model's prompt for a run with a drop contains no base64, data URL or signed URL (assert on
  the recorded prompt in the agent's test harness);
- removing a file from chat leaves it in Files.

### Milestone 2: plans, collections, structure, fast boot (`todo13-organize`)

1. **Classifier** (kernel, after inspection): groups and default actions per §3.3; emits
   `drop.classified` and `drop.planned`. Pure functions with table tests for every row of §3.3.
2. **Plan card** in chat: the groups, the action for each, Apply / Change / Undo; auto-applied per
   D6 with Undo for 30 s.
3. **Apply**: creates or updates the draft dataset and its collections, then boots or extends
   Studios (todo11 boot route gains `collectionId`). Before todo12 M1: kernel applies directly.
   After: `POST …/pipeline-runs` with the implicit ingest definition, the plan as parameters
   (D9); `drop.applied` either way.
4. **Collections (D7)**: `collections` in the dataset definition (kernel) and in `structure.json`
   (versioning); a task targets one collection; `task_document` filters by it; the Studio header
   switcher (`collection-switcher`); `VIEWABLE` filtering per collection, not per task.
5. **`DatasetStructure v1`** (D8) in `packages/contracts/src/dataset-structure.ts` (zod) and its
   emitted schema; read/write through `GET/PUT /api/v1/datasets/{id}/structure` (draft only; a
   published dataset gets a proposal). Agent tool `propose_structure` writes the draft on its own
   `work/agent-*` branch and returns the diff; the person (or D6's auto-apply on drafts) accepts it.
6. **Fast path**: `resolveIntent` gets `fileKinds` from the first `drop.classified`; on an
   unambiguous match the kernel boots without waiting for the agent. Labels from the request map
   to the annotation definitions in the structure and to the environment's label config with the
   same stable label IDs.
7. **Archives**: unpack as a worker job (size and count limits, no symlinks, no path traversal,
   encrypted archives kept as unknown); contents become a child drop.

**Exit tests (Milestone 2):**

- journeys J1–J8 (§6) pass with the scripted model;
- J1's real-model run is measured and reported (target in §6);
- a second, different drop never reloads or changes the open Studio;
- every §3.3 row has a classifier test and one e2e case.

### Milestone 3: Datasets tab, Phase 1 of `docs/datasets.md` (`todo13-datasets`)

Build `docs/datasets.md` §14 Phase 1 under `apps/web/src/studio/core/datasets/`:

1. **Landing** (§2.1): "Continue working", "Needs attention" (malformed files, unconfirmed
   suggestions, plan cards waiting, pipeline issues), dataset cards with modalities, collections and
   counts at a stated level; filters; the empty state from §3.1.
2. **Dataset Overview** (§4): collections with previews, needs attention, recently changed, latest
   release.
3. **Structure** (list view only, §5): collections, relationships, `suggested` tags, Confirm.
4. **Fields & Formats** (read-only, §6): per collection, from inspection facts and the structure.
5. **Quality** (basic, §8): grouped issues from inspection flags, plan leftovers and, once merged,
   todo12's pipeline validation.
6. **History** (basic, §9): human-readable entries from versioning, the snapshot picker (working
   draft, `main`, releases).
7. **Add data** in the dataset header opens the composer scoped to the dataset (a drop there skips
   the "which dataset" question).
8. Permission-aware: viewers see read-only views; drafts are never shown as published.

**Exit tests (Milestone 3):** `docs/datasets.md` §15 criteria 1, 2, 4, 5, 6, 11, 17, 18 as e2e or
component tests; every view has loading, empty, error and permission-denied states (§12.1).

### Milestone 4: polish and the minute (`todo13-entry`, integrator)

1. Timeline instrumentation from drop to first interactive item (§6), in the browser
   (`boot-timing.ts`) and on the server (`drop.*` timestamps); a debug overlay with
   `?timeline=1`.
2. Tune the slowest step found (expected: upload of the first file, inspection queue wait, first
   frame); prioritize the first files of a drop in the upload and the kernel queue (todo12's
   resource classes; a `priority` hint per job).
3. Copy pass on every card and empty state; screenshots in `docs/screenshots/`.
4. `docs/ux.md` updated with the journey; `docs/datasets.md` §1 nav table updated to D10.

---

## 5. Workstreams, contracts, rules

| Branch | Milestone | Owns | Must not touch |
|---|---|---|---|
| `todo13-entry` | 1, 4 | Home and Projects pages, `app-layout.tsx` nav and drawer placement, `ComposerEmptyState`, empty states, Studio canvas drop, timeline overlay | agent runtime, kernel, Datasets pages |
| `todo13-drops` | 1 | composer attachments, `drops` table and import origin, name screening, Shared in chat folder, protocol `drop` part, `get_drop`, Shared files view, Files provenance | classifier, Datasets, todo12's files |
| `todo13-organize` | 2 | classifier, plan card, apply, collections (kernel, task document, switcher), `DatasetStructure v1`, structure routes, `propose_structure`, fast path, archive unpack job | Home/nav, Datasets pages, todo12's files |
| `todo13-datasets` | 3 | `apps/web/src/studio/core/datasets/**`, its read endpoints (landing summaries, attention) | composer, classifier, pipeline internals |

**Order.** `todo13-entry` and `todo13-drops` in parallel; `todo13-organize` after Milestone 1's
contracts land (can start the classifier and contract immediately); `todo13-datasets` can start with
Milestone 1 against the contracts and fills in as Milestone 2 merges. Coordinate with todo12:
`todo13-organize`'s pipeline call waits for todo12 Milestone 1 (D9).

**Contracts** (names fixed; change only through the integrator):

- **Drop**: kernel table `drops {id, project_id, origin: "chat"|"files"|"studio"|"home",
  conversation_id?, message_id?, task_id?, dataset_id?, created_by, created_at, state:
  "uploading"|"inspecting"|"classified"|"planned"|"applied"|"failed"}`; `import_sessions.drop_id`.
- **Events** (project SSE, kernel outbox envelope): `drop.received {dropId, origin, count}`,
  `drop.file {dropId, nodeId, state}`, `drop.classified {dropId, groups}`,
  `drop.planned {dropId, plan, auto}`, `drop.applied {dropId, datasetId?, taskIds[], undoUntil}`,
  `drop.failed {dropId, step, errorClass}`.
- **`DropSummary`** (agent-facing): `{dropId, total, byKind: {[kind]: n}, bytes, states:
  {[state]: n}, groups: [{groupId, kind, count, shape?, suggestedAction}], files: [{nodeId,
  agentName, kind?, facts?}] (first 50; `get_drop` pages the rest)}`. `facts` are technical only
  (dimensions, frames, duration, modality, column names and types, pages).
- **`DropPlan`**: `{dropId, actions: [{groupId, type: "add_to_collection"|"new_collection"|
  "new_dataset"|"unpack"|"keep_reference"|"keep_unsupported"|"link_existing", datasetId?,
  collectionId?, name?, preset?, nodeIds[]}], needsPerson: boolean}`.
- **`DatasetStructure v1`**: `{schemaVersion: 1, collections: [{id, name, kind, formats[],
  fields: [{id, name, type, unit?, required, suggested?}], suggested?}], relationships: [{id, from,
  to, cardinality, keys, suggested?}], annotations: [{id, collectionId, geometry, labels: [{id,
  name, color?}], suggested?}]}`. IDs are stable strings, never positions. todo12 Milestone 2 adds
  field-level compatibility on this file.
- **Protocol**: `SendMessageRequest.drop?: {dropId}`; message part `{type: "drop", dropId, files}`;
  AG-UI `custom` mapping.
- **Routes**: `GET /api/v1/drops/{id}` (agent and person), `POST /api/v1/drops/{id}/apply`,
  `POST /api/v1/drops/{id}/undo` (person; agent may apply only D6-safe plans), `GET/PUT
  /api/v1/datasets/{id}/structure`, `POST …/boots` gains `collectionId`.

**Rules** (as todo11 §6):

- branch slug in Alembic filenames;
- never merge, never edit this file;
- no product name outside `naming.ts`;
- synthetic fixtures only (`e2e/fixtures/`; add mixed-drop fixtures: PNGs, a DICOM series, a CSV
  keyed by file name, a PDF, a ZIP, an MP3, a duplicate, a file with an identifier-like name);
- keep every existing `data-testid` working; new ones listed in your hand-back;
- the `AGENTS.md` checks plus your exit tests before handing back.

**Merge order:** `todo13-drops` → `todo13-entry` → `todo13-organize` → `todo13-datasets`, then
Milestone 4. After each merge, run the journey suite (§6).

---

## 6. Journeys and budgets

**Journeys** (`tests/e2e/journey_test.py`, scripted model; synthetic fixtures):

| # | Journey | Pass when |
|---|---|---|
| J1 | Empty Home, drop 30 PNGs, no text | Project created; Studio open on the first ready image; dataset draft with one collection in Datasets |
| J2 | Empty Home, type "Chest X-ray classification with five labels" | Empty Studio with the five labels; empty collection; canvas asks for files |
| J3 | In J2's Studio, drop 30 PNGs on the canvas | Items appear live; no reload |
| J4 | In J1's Studio, drop a CT series folder | Plan card offers a CT collection; applied with Undo; switcher shows two collections; the X-ray Studio unchanged |
| J5 | Drop a PDF, a ZIP of PNGs, an MP3 and a CSV keyed by file name | PDF kept as reference; ZIP unpacked and added; MP3 kept, "Find a plugin"; CSV asked as labels table |
| J6 | Drop the same 30 PNGs again | "Already in Files"; no new uploads; no duplicate items |
| J7 | Drop a file with an identifier-like name | Agent and transcript see the screened name only |
| J8 | Drop 2,000 small images | First item interactive within the budget; the rest stream |
| J9 | Remove a file from the chat | Still in Files; Shared files updated |

**Budgets:**

| Moment | Target | Gate |
|---|---|---|
| Drop to drop card visible | < 300 ms | e2e |
| Drop to first file inspected (small image) | < 3 s | e2e |
| Drop to first item interactive in a Studio, fast path (J1) | < 15 s | e2e |
| Request or drop to Studio configured by the agent, real model (J1, J2) | < 60 s | measured and reported; gated once stable |
| Second drop to plan card (J4) | < 5 s after first group classified | e2e |
| Background ingest (bytes/s, time to all ready) | tracked | not gated (todo11 §7) |

---

## 7. Not now

- External connectors as a drop source (todo12 Milestone 3).
- The Structure graph view and editing beyond Confirm (Datasets Phase 2).
- Reading document contents to suggest labels (would need a boundary-safe extraction design).
- Audio as a viewable kind (needs a plugin; "Find a plugin" covers it for now).
- Mobile drop flows beyond what the browser gives for free.

---

## 8. References

- `docs/datasets.md`, `docs/pipeline.md`, `docs/ux.md`, `docs/agent.md`, `docs/files-api.md`,
  `docs/deployment-gcp.md`.
- `todo/todo10.md` (boundary), `todo/todo11.md` (boot, `item.*`, D7 collections), `todo/todo12.md`
  (pipeline, deployment).
- Code: `apps/web/src/studio/app/AppShell.tsx`, `components/layout/app-layout.tsx`,
  `components/ai/assistant-panel.tsx`, `app/HomePage.tsx`, `app/DatasetsPage.tsx`,
  `app/FilesPage.tsx`, `apps/api/src/studio_api/kernel/{imports,inspection,explore,ingest,boots}.py`,
  `kernel/agent_scope.py`, `packages/agent-protocol/src/index.ts`, `packages/studio-tools`,
  `apps/agent/src/runtime/sessions.ts`.
