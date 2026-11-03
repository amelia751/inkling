# The whole project, drivable by the assistant: Sources, delete, Trash, recover

**Goal.** Treat a project like a repository: everything in it (sources, datasets, collections,
Studios, labels, settings) can be created, renamed, moved, deleted and recovered, by a person in
the UI *and* by the assistant in chat, with the same rules. "Delete the pneumonia folder", "drop
the old dataset", "bring back what I deleted yesterday" all work from chat, land in a Trash anyone
can see, and come back with one click for 30 days.

**Status (2026-11-02, `main` 2d44b65).** Plan only. Starts after todo15 Milestone 1 merges (both
touch `apps/agent/src/tools/policy.ts` and the assistant panel); Milestone 0 below can start now.

**Naming.** The product name appears only in `packages/contracts/src/naming.ts`. Env vars are
written here without their prefix.

---

## Start here (agents)

1. Read `AGENTS.md`, this file, `docs/README.md` (glossary), `docs/ux.md` (Files section and
   Trash), `docs/files-api.md`, `todo/todo7.md` Phase 4 (how file Trash was built).
2. One worktree per workstream: `git worktree add .worktrees/todo16-<name> -b todo16-<name> main`.
3. Test yourself (browser, kernel API, MCP), the assistant only with the scripted model; real-model
   runs only in Milestone 3's last step, counted and reported.
4. `data-testid`s and store fields used by e2e are a contract: rename labels, not test ids.

---

## 0. Where we are (audit 2026-11-02)

| Resource | Delete today | Recover today | Assistant today |
|---|---|---|---|
| **Files and folders** (`source_nodes`) | Soft: Trash (`fs/ops` `trash`), hard: `purge`, Empty trash | Restore from Trash, undo/redo (`fs_batches`), file versions | Read only (`list_folder`, `find_files`, `list_sources`); writes refused (403 on `fs/ops`), only a "reorganize" card a person applies |
| **Trash retention** | 30 days, `files.empty_trash` job run daily by the worker (`kernel/fs.py` 55, `routes/worker.py` 250) | Trash view (`trash-view.tsx`), reached from a small "Trash" link at the bottom of the file tree | None |
| **Imports** (`sources` table: upload provenance) | `DELETE …/sources/{id}` trashes the folder, keeps the row | Restore the folder | `list_import_issues` |
| **Datasets** | **No delete, no rename** (only removed by undoing a drop plan) | — | Read via overview; `propose_structure` |
| **Collections** | Only via drop-plan undo | — | Via `propose_structure` |
| **Studios** (`tasks` + `workspace_environments`) | **No delete** | Environment rollback (history) | `boot_studio`, `patch_studio`, `get_studio_state` |
| **Annotations** | Whole-document replace; dataset commits versioned (Go service, revert) | Revert a dataset commit | Read; commit on task profile |
| **Projects** | **No delete**, archive only | Unarchive | None |
| **Members, API keys, secrets** | Hard delete / revoke | Re-add | None (stays person-only, §2 D7) |

So: files already have the right model (soft delete → Trash → 30-day purge, with undo); nothing
else does, and the assistant can't write to any of it. The Trash is hard to find, and the section
is called "Files" while its URL, test ids and half the copy already say "sources".

## 1. What's missing

1. **Rename.** Nav, breadcrumbs, drive root and copy say "Files"; the URL (`/sources`), test ids
   (`sources-page`, `sources-tree`) and API (`/sources`) say sources. The glossary uses "Source"
   for upload provenance, which collides.
2. **Delete and recover for everything else.** Datasets, collections, Studios and projects can't be
   deleted or recovered; nothing but files can be renamed after creation.
3. **One Trash.** A project-wide Trash (all kinds, who deleted what, days left), a real place in the
   sidebar, empty states, and "Deleted projects" for whole projects.
4. **The assistant can operate the project.** One operation catalogue the API, the assistant and
   the MCP server share; writes allowed with the person's rights; deletes go to Trash with Undo;
   permanent deletion only after the person confirms.
5. **Add data from chat.** Today data only arrives by dropping files; the assistant can't start an
   upload, import from a link or copy samples.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | **"Sources" is the section and the drive.** Nav label, breadcrumbs, drive root folder name and copy become "Sources" (`kernel/tree.py` `ROOT_NAME`, with a migration renaming existing roots). URL and test ids already say sources and stay. The glossary changes: *Sources* = everything added to a project (files and folders); one upload or import is an *import* (the `sources` table keeps its name internally). `docs/README.md` stops saying "Data". |
| D2 | **Delete means "move to Trash", everywhere.** Every resource a project owns gets `trashed_at`, `trashed_by`, `trash_batch_id` (as `source_nodes` already has): datasets, collections, Studios (tasks), projects. Trashed things disappear from lists, search, the assistant's reads and Studio items; nothing is lost until purge. |
| D3 | **One deletion, one batch, restored together.** Deleting something moves its dependents with it in one batch: a dataset takes its collections, its Studios and their annotations; a Studio takes its environment and annotations; a folder takes its files. Restoring the batch brings all of it back. Files used by a dataset are *not* deleted with the dataset (they belong to Sources). |
| D4 | **Deleting files that datasets use is allowed, with a warning.** "Used by 2 datasets (340 items)." The items show as "In Trash" in those datasets and Studios (not silently missing); restoring the files brings them back; purging them removes them from the dataset in a new dataset version (versioning service commit), so history still has them. |
| D5 | **30 days, then gone, for real.** `API_TRASH_DAYS` (default 30) for every kind. The daily job `trash.purge` (today's `files.empty_trash`, kept as an alias) purges in dependency order: annotations, Studios, collections, datasets (versioning repo marked for GC), files (blobs deleted unless still referenced, as today). "Delete forever" and "Empty trash" do the same immediately. Cloud SQL backups keep deleted rows up to 7 days; `docs/deployment-gcp.md` says so. |
| D6 | **Projects go to "Deleted projects".** Delete project (owner or org admin) moves it there for 30 days: hidden from Home and search, members lose access, restore puts everything back. Archive stays as "hide but keep". |
| D7 | **One operation catalogue.** `packages/contracts/src/operations.ts`: every project operation with its id (`dataset.delete`, `source.move`, `trash.restore`…), zod input, the API route it maps to, and a **risk tier**: *read*, *write* (reversible: create, rename, move, add to dataset, patch Studio), *trash* (recoverable delete), *destroy* (purge, empty trash, delete project forever). The api checks the same ids; the assistant's project tools and the MCP kernel tools are generated from it, so nothing is "UI only" by accident. Org admin (members, API keys, secrets, billing, security) is **not** in the catalogue: people only. |
| D8 | **The assistant acts with the person's rights, never more.** It calls the API with the delegated token of the person who sent the message (`session_delegations`); the api applies that person's project role (a viewer's assistant can't delete). Policy by tier: *read* and *write* run; *trash* runs and the chat shows what went to Trash with **Undo** and **Open Trash**; a trash of more than 100 files, a dataset, a Studio or a project asks first (inline card listing what goes, approve/cancel, `ApprovalBroker`); *destroy* always asks, and the card says it can't be undone. |
| D9 | **Every assistant turn is undoable as one step.** All writes in one assistant turn share one batch (the `fs_batches` journal generalised with a `resource` column); the chat message gets "Undo these changes" while the batch is the latest on those resources. Activity (`ActivityPage`) shows each batch as "<person>'s assistant: renamed 3 files, deleted dataset X". |
| D10 | **The assistant adds data without seeing it.** Three ways, none puts bytes in the model's context: an **upload card** (the assistant asks; the person picks or drops files into the card, normal import path); **import from a link** (public HTTPS, `gs://` the project can read; the kernel fetches, the worker inspects; the assistant sees only file facts, as for drops); **copy** from a sample or another project the person can read. |

## 3. Milestones

### Milestone 0. Sources (about 1 day, can start now)

- [ ] Nav label, breadcrumbs, page title, drive root name "Sources" (`app-layout.tsx` 64,
  `tree-header.tsx`, `path-bar.tsx`, `drive-tree.tsx`, `inspector.tsx`, `move-dialog.tsx`,
  `FilesPage.tsx`, `kernel/tree.py` 37 + migration renaming existing roots,
  `apps/agent/src/tools/project.ts` 382, agent context labels `providers.ts` "Sources › …").
- [ ] Copy: "project's Files" → "Sources" where it means the section (assistant panel, notice,
  Home composer, shared-in-chat, add-data); file nouns stay "files".
- [ ] Glossary and docs (D1): `docs/README.md`, `docs/ux.md`, `docs/datasets.md`, `docs/files-api.md`.
- [ ] Tests follow the label (not ids): `entry.test.ts`, `providers.test.ts`, e2e `entry_test.py`,
  `navigation_test.py`, `pipeline_runs_test.py`, `tests/e2e/agent_test.py`, api `test_files.py`.
- [ ] Trash moves from the tree footer to a sidebar item at the bottom of the project nav (with
  count), so it's findable; the footer link stays.

**Exit:** no "Files" as a section name anywhere in the UI or docs; all checks green.

### Milestone 1. Delete and recover everything (api, about 4 days)

- [ ] Migration: `trashed_at`, `trashed_by`, `trash_batch_id` on `datasets`, `dataset_collections`,
  `tasks`, `projects`; indexes; every list/read query filters trashed rows (one helper).
- [ ] Routes: `PATCH` (rename, describe) and `DELETE` (to Trash) for datasets, collections and
  Studios; `DELETE /projects/{id}` (to Deleted projects) and `POST …/restore`.
- [ ] One Trash API per project: `GET /projects/{id}/trash?kind=` (all kinds, batch, by whom, when,
  days left, original location, dependents), `POST …/trash/{batch}/restore`,
  `DELETE …/trash/{batch}` (destroy), `POST …/trash/empty`; files' existing ops keep working.
- [ ] Impact preview for every delete (`dryRun=true`): what goes with it, which datasets lose items
  (D4); used by the UI dialogs and the assistant's approval card.
- [ ] Dataset items whose file is in Trash return `state: "trashed"`; Studios show them greyed.
- [ ] `trash.purge` job (D5) in dependency order; versioning: purge marks the repo deleted and lets
  `apps/versioning` GC collect it; purging files used by datasets commits the removal (D4).
- [ ] Org: `GET /api/v1/org/deleted-projects`, restore, delete forever (org admin).
- [ ] Audit: `*.trashed`, `*.restored`, `*.purged` with actor and on-behalf-of.
- [ ] Tests: each kind trash → list → restore → purge; dependents; permissions (viewer can't,
  editor can, purge needs owner/admin); purge leaves no blobs (fake BlobStore) unless referenced.

### Milestone 2. UI: delete, Trash, empty states (about 3 days)

- [ ] Delete in menus for datasets, collections, Studios (card menus, detail headers), project
  (Settings › Danger zone: Archive, Delete project). Dialog shows the impact preview; for a
  project, type its name.
- [ ] Toast after every delete: "Moved to Trash" with **Undo** and **Open Trash**.
- [ ] Trash page (project section): filter chips All / Sources / Datasets / Studios; rows show
  name, kind, original location, deleted by (person, or "<person>'s assistant"), when, days left;
  Restore, Delete forever, Empty trash (confirm). Restoring into a location that no longer exists
  restores to the Sources root and says so.
- [ ] Rename in place for datasets, collections, Studios.
- [ ] "Deleted projects" on Home (link under the project list) and in org Settings.
- [ ] Empty states (`docs/ux.md` gets each one): Trash empty ("Nothing in Trash. Deleted things
  stay here for 30 days, then they're gone."); Deleted projects empty; a dataset whose files are
  all in Trash ("This dataset's files are in Trash" + Restore); a Studio whose dataset is in Trash;
  Sources empty after deleting everything (same as first run); search with trashed matches ("2
  matches in Trash").
- [ ] e2e `trash_test.py`: delete a folder, dataset, Studio; restore each; delete forever; empty
  states screenshots.

### Milestone 3. The assistant operates the project (about 5 days)

- [ ] `operations.ts` catalogue (D7) with every Milestone 1 operation plus the existing ones:
  sources (create folder, rename, move, copy, trash, restore, versions restore, star), imports
  (list, cancel, retry), datasets (create from sources, rename, add/remove files, delete,
  restore), collections, structure (propose, accept stays person), Studios (boot, rename, patch,
  publish, delete, restore), labels, exports, project (rename, describe, archive, delete), Trash
  (list, restore, empty, destroy). `pnpm emit:schemas` emits it with the catalogue.
- [ ] api: agent delegated tokens accepted on the catalogue's *write* and *trash* routes (today
  `fs/ops` returns 403); *destroy* routes need an approval id the broker issued for this person
  and operation.
- [ ] Agent: project tools generated from the catalogue (replacing hand-written `project.ts` writes;
  reads stay metadata-only, trashed hidden unless asked); policy by tier (D8); per-turn batch and
  Undo (D9); chat cards: "Moved to Trash: 3 files · Undo · Open Trash", approval card with the
  impact preview.
- [ ] MCP: kernel tools from the same catalogue with a person token (today it only edits
  environments on the web dev server).
- [ ] Prompt: deletes go to Trash and say so; "delete forever" asks; never guesses which of two
  same-named things to delete (asks).
- [ ] Scripted-model tests: "delete the pneumonia folder" → Trash + Undo works; "delete dataset X"
  → approval card → approved → in Trash → "bring it back" → restored; "empty the trash" → approval
  → destroyed; viewer's assistant gets refused with a reason.
- [ ] Real model: one conversation covering rename, delete, restore, delete forever; at most 3 runs;
  cost reported.

### Milestone 4. Add data from chat (about 3 days)

- [ ] Upload card (D10): `request_upload` client tool renders a drop zone in the chat bound to the
  current project (and folder); files go through the normal import path; the assistant gets the
  drop facts as today.
- [ ] Import from a link: `POST /projects/{id}/imports/url` (HTTPS allow-list rules, size cap
  `API_URL_IMPORT_MAX_BYTES`, `gs://` with the project's service identity); kernel fetches, the
  worker inspects; assistant tool `import_from_url`.
- [ ] Copy from a sample or another readable project: `POST /projects/{id}/imports/copy`;
  assistant tool `copy_into_project`.
- [ ] e2e: "add the chest X-rays from this link" → files land in Sources, assistant summarises
  facts only.

## 4. Acceptance walk-through

On `pnpm dev`, with the folders from `~/Downloads/spurby-sample-data`:

| # | You | You see |
|---|---|---|
| 1 | Drop the X-ray folder, then say "delete the pneumonia folder" | Chat: "Moved to Trash: pneumonia (6 files) · Undo · Open Trash"; Sources without it; Trash shows it with 30 days left, deleted by your assistant |
| 2 | Click Undo | The folder is back where it was |
| 3 | Say "delete the chest X-ray dataset" | An approval card listing the dataset, its Studio and labels; approve → all in Trash as one row |
| 4 | Say "bring back what I deleted" | Dataset, Studio and annotations restored; Studio opens as before |
| 5 | In Trash, Delete forever on a folder | Confirm dialog; gone from Trash; its blobs deleted |
| 6 | Say "empty the trash" | Approval card ("can't be undone"); after approve, "Nothing in Trash…" empty state |
| 7 | Settings › Delete project | Type the name; project in Home › Deleted projects; restore brings everything back |
| 8 | Switch to a viewer and ask the assistant to delete something | Refused: "You can view this project but not delete from it" |
| 9 | Say "add the ECG files from <link>" | Files arrive in Sources; the assistant summarises lead count and duration, not values |

## 5. Out of scope

Org administration through the assistant (members, invitations, API keys, secrets, billing,
security) stays person-only; per-annotation trash (annotations are versioned with the dataset and
come back with dataset reverts); a configurable retention per org; legal hold; Trash for plugins
(disable and rollback already cover it); connectors beyond HTTPS links and `gs://`.

## 6. Config added

| Key | Service | Default | Meaning |
|---|---|---|---|
| `API_TRASH_DAYS` | api | `30` | Days in Trash before `trash.purge` deletes for good (D5) |
| `API_AGENT_TRASH_ASK_OVER` | api, agent | `100` | Files in one assistant delete above which it asks first (D8) |
| `API_URL_IMPORT_MAX_BYTES` | api | `5368709120` | Largest import from a link (D10) |
