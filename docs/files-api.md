# Files API (todo7): the contract between the kernel and the web app

The plan is `todo/todo7.md`. This page fixes the wire shapes so the backend and the web app can be
built in parallel. Types are in `packages/contracts/src/types/index.ts` (section "Files: the
project's drive"). All routes are under `/api/v1` and the UI calls them through
`apps/web/src/studio/lib/files/api.ts`.

## Model (decisions D1–D10)

- **One drive per project (D1).** Each project has one root folder node (`DriveInfo.rootNodeId`,
  name "Sources", todo16 D1; migration 0017 renamed older "Files" roots). Every existing source root becomes a top-level folder under it, named after the
  source's title. `sources` rows stay as import provenance (`SourceNode.sourceId`).
- **Ids are opaque and permanent (D3).** New nodes are `nod-<uuid hex>`; existing hashed ids are kept.
  `Asset.path` never changes. Copies point at the same asset (D5).
- **Paths are computed (D4).** `source_nodes.rel_path` becomes `original_path` (immutable,
  sensitive). The current path comes from the parent chain.
- **Locked (D2).** Seed folders and everything below them answer `locked: true`; any write that would
  change a locked node, or put something into a locked folder, is refused (`423`, message "Sample
  data can't be changed. Copy it to make your own"). Copying *out* of a locked folder is allowed.
- **Names (D10).** Unique per folder case-insensitively among non-trashed siblings. No `/`, no
  control characters, ≤255 UTF-8 bytes, trailing spaces/dots trimmed, not empty, not `.`/`..`.
  Windows reserved names are allowed (the client warns). Errors are `422 { detail: "<sentence>" }`.
- **Trash (D8).** `trashed_at/by`, `trash_batch_id`; trashing a folder marks only the folder (its
  descendants are hidden with it). 30 days, then the worker's `files.empty_trash` job purges.
  Purge deletes bytes only when nothing else references the asset.
- **Journal (D9).** Every write is an `fs_ops` row with `before`/`after`; undo is refused (409) when any
  touched node has a later op by anyone.

## Routes

| Method & path | Body → response | Notes |
|---|---|---|
| `GET /projects/:id/fs` | → `DriveInfo` | Creates the root lazily. Seed stand-in: `writable: false`. |
| `GET /projects/:id/fs/children?node=&cursor=&limit=&sort=name\|kind\|size\|added&dir=asc\|desc` | → `ChildrenPage` | Same rows as `/sources/:id/children` (runs, compact chains), folders always first, sorted server-side so paging is correct. `node` defaults to the root; `seq:` ids work. Trashed nodes are excluded. |
| `POST /projects/:id/fs/ops` | `FsOpsRequest` → `FsOpsResult` | All-or-nothing. `409 { detail: FsConflictError }` when a name conflict has no resolution; `422` invalid name or cycle ("Can't move a folder into itself"); `423` locked; `403` for agent tokens (`ctx.scopes` set). Emits `fs.changed { projectId, parentIds, batchId, actor, summary }`. |
| `POST /projects/:id/fs/undo` / `fs/redo` | `{ batchId? }` → `FsUndoResult` | Default: the caller's last undoable (or last undone) batch. Refused with 409 `"Can't undo: patient_002 changed after that"`. |
| `GET /projects/:id/fs/history?limit=` | → `{ undo: {batchId,label}\|null, redo: {batchId,label}\|null }` | For the "Undo move of 3 items" hint after a reload. |
| `GET /projects/:id/trash?cursor=` | → `TrashPage` | Top-level trashed items (a trashed folder, not its contents). |
| `POST /projects/:id/trash/empty` | → `{ purged, keptBytes: [{name, reason}] }` | Confirmation in the UI names kept bytes. `GET …/trash/empty/preview` returns the same without doing it. |
| `GET /projects/:id/starred` / `GET /projects/:id/recent` | → `{ items: FsShortcut[] }` | Per principal, at most 50. |
| `POST /source-nodes/:id/star` / `DELETE /source-nodes/:id/star` | → `{ starred }` | |
| `GET /source-nodes/:id/versions` | → `{ versions: NodeVersion[] }` | |
| `POST /source-nodes/:id/versions` | same body as `POST /projects/:id/imports` with one file, plus `mode: "replace"` → `ImportSession` | Upload then `complete` adds a version (asset is new; old stays in `node_versions`). |
| `POST /source-nodes/:id/versions/:v/restore` | → `FsOpsResult` | Journaled `restore_version`. |
| `GET /source-nodes/:id/download` | → 302 to a signed blob URL (or streams the bytes) | Audited `files.downloaded`. Privacy-held files: 423. |
| `POST /projects/:id/fs/zip` | `{ nodeIds }` → streamed `application/zip` | Constant memory (`zipstream`-style, stored entries). Held files left out and listed in `_held_files.txt`. Entry names use current paths, never original paths. |
| `GET /source-nodes/:id/activity` | → `{ items: FsActivityEntry[] }` | The node's ops and its ancestors' moves. |
| `GET /source-nodes/:id` | → `SourceNodeDetail` | Adds `pathText`, `originalPath` (members only), `trash`, `starred`, `locked`, `version`. |
| `POST /projects/:id/datasets/:ds/update-versions` | `{ nodeIds? }` → `DatasetSummary` | Moves pinned files to their current version; `GET …/update-versions/preview` → `{ files: [{nodeId, name, from, to, annotations}] }`. |
| `POST /projects/:id/datasets/:ds/add-followed` | → `DatasetSummary` | Adds the new files from followed folders. |

Existing `/sources/*` reads stay working as aliases. Children rows gain `starred`, `locked`,
`version`, `totalBytes`, `trashed`.

## Events

`fs.changed` on the project event stream (`use-project-events.ts`):
`{ projectId, parentIds: string[], batchId, actor, summary }`. The web invalidates
`filesKeys.children(projectId, parentId)` for each parent and `["source-nodes", id]` for touched
nodes, ignoring loads that started before this tab's last local op on that folder.

## Seed stand-in (D12)

`apps/web/dev/seed-server` answers `GET /projects/:id/fs` with `writable: false` and a synthetic root
whose children are the source roots, `GET …/fs/children` like `/sources/:id/children`, empty
`starred`/`recent`/`trash`, `history` with nulls, and `501` for every write. The UI disables edit
actions with "Needs the full stack" when `writable` is false. Starring in the stand-in falls back to
localStorage so the nav e2e (Phase 5) can run in seed mode.

## Privacy (Phase 7)

`originalPath`, old names in `fs_ops` and activity texts are left out of agent context, exports, ZIP
entry names and URLs. Renaming or moving re-runs the path-name check from the worker's patterns
(copied in-process for names); a flag raised only by the name clears with audit `privacy.cleared`
reason "renamed".

## Drops and chat files (todo13-drops)

A **drop** is one gesture of files dropped, pasted or attached (chat, Home, Sources, a Studio
canvas): table `drops` (`origin`, `conversation_id`, `message_id`, `task_id`, `state`), and every
import session of the gesture carries `import_sessions.drop_id`. `kernel/drops.py`,
`routes/drops.py`; contract `packages/contracts/src/drops.ts`. Behind `API_FEATURE_CHAT_DROPS`
(404 when off).

- `POST /v1/projects/:id/drops` `{origin, id?, conversationId?, conversationTitle?, messageId?,
  taskId?, files?, bytes?}`: people only (viewers and agents 403); `API_DROP_MAX_FILES` /
  `API_DROP_MAX_BYTES` per drop (413, pointing to Sources' folder upload); 20 drops a minute per
  person (`API_DROP_RATE_PER_MINUTE`, 429 with `Retry-After`). A client `id` (`drp-…`) makes a
  retry return the same drop.
- `POST /v1/projects/:id/imports` takes `origin: {kind, conversationId?, messageId?, dropId?}`
  (or `dropId`). A chat drop, and a Home drop (D1 delivers it into the new project's
  conversation), lands in **Shared in chat/<conversation>** (made on first use, one subfolder per
  conversation) with `Source.kind = chat`; the drop's totals stay within the limits.
- The worker's listing of an import that holds a table (`GET /v1/worker/inspect/imports/:id`)
  carries `knownNames`: the file names of the drop's dataset, so a labels CSV dropped later is
  recognized as keyed by them (§3.3). Worker-only, inside the perimeter; the plan and the agent
  get the count of matching columns, never the names.
- `GET /v1/drops/:id`: a person gets the drop with one entry per file (`state`: uploading,
  checking, ready, kept, failed, duplicate "Already in Sources", removed, deleted; `looksLike` when
  the extension and the detected kind disagree, "Looks like a ZIP"); an agent gets the
  `DropSummary` (screened names, technical facts, 50 files a page with `?offset=`).
- `GET /v1/projects/:id/drops?conversationId=`: a conversation's Shared files, newest first.
- `DELETE /v1/drops/:id/files/:nodeId`: takes a file out of the chat; the File stays (D4).
- `POST /v1/projects/:id/conversations/:cid/deleted`: the chat is gone; its folder stays in Sources,
  renamed "<conversation> (deleted chat)" (a journaled rename). Moving a File to Trash shows
  "Deleted file" on its chips.
- Events on the project stream: `drop.received {dropId, origin, count}`, `drop.file {dropId,
  nodeId, state}`, `drop.failed {dropId, step, errorClass}`; `drop.classified|planned|applied`
  come from the classifier. Each transition logs one JSON line (`msg`/`event` `drop.<state>`:
  received, session, uploaded, inspected, classified, planned, applied, undone, failed with
  `step` and `errorClass`; `dropId`, `elapsed_ms` since `drop.received`, `origin`, counts by
  kind; no names), and a drop still `inspecting` 10 minutes after its last change logs
  `drop.stuck` about once a minute. The log-based metrics and alerts read them
  (`infra/terraform/phi/monitoring.tf`, `docs/deployment-gcp.md` "Drops: config, monitoring and
  rollout").
- Feature flags: drops and their routes need `API_FEATURE_CHAT_DROPS`; the plan routes too;
  structure, collections and `POST /v1/telemetry/timeline` answer while any todo13 flag is on.
  With every flag off none of them answers (404) and imports work as before.
- `GET /v1/source-nodes/:id` `provenance.drop`: "Shared in chat · <conversation> · <date>".

**Screened names (D13).** Each node has `agent_name` / `name_flagged`: what an agent sees for its
name (`docs/deployment-gcp.md`, "What the agent sees"). Set on import completion and after
namespace edits, reset by a rename, backfilled by the worker's `files.screen_names` (about once a
minute, resumable) or `python -m studio_api.kernel.name_screen backfill [--project P]`. Keys:
`API_NAME_SCREEN_MODE` (`dlp` in production, `regex` in dev and tests), `API_NAME_SCREEN_BATCH`,
`API_NAME_SCREEN_QPS`, `API_NAME_SCREEN_PROJECT`, `API_NAME_SCREEN_LOCATION`.

## As implemented (backend notes)

`apps/api/src/studio_api/routes/files.py` and `kernel/fs.py`. Small additions to the shapes above:

- `sourceId` is `null` for the drive root and for folders made in Sources (they came from no import).
  Copies keep the original's `sourceId` (the bytes' provenance).
- Folder rows carry `revision` (bumped when their children change), for `FsOpsRequest.expect`; a stale
  revision answers `409 { detail: "<folder> changed since you loaded it. Reload and try again" }`.
  Folder `size` is `null`; their bytes are `totalBytes`.
- `fs.changed` also carries `nodeIds` (the touched nodes, at most 500), so the web can invalidate
  `["source-nodes", id]` without guessing.
- Conflicts: `restore` uses the same 409 + `resolutions` as move and copy. Copying a node into its own
  folder (Duplicate) never conflicts: it is named `name (copy).ext`. Copy skips identical files (same
  sha256) without a resolution and counts them in `skipped.identical`; move reports them as conflicts
  with `identical: true`. `replace` on a move makes the moved file's bytes a new version of the existing
  file and moves the mover to Trash; `merge` on a move empties the moved folder into the existing one and
  moves the empty folder to Trash.
- `FsActivityEntry.kind` is `undo` / `redo` for entries of an undo or redo batch.
- `GET /source-nodes/:id/download` streams the bytes (`Content-Disposition` with the current name,
  ranges supported) rather than redirecting.
- `POST /source-nodes/:id/versions` takes `{ files: [one file], attested: true, mode: "replace" }`;
  `relPath` may be omitted. After `complete`, `totals.version` is the new version and the session goes
  through inspection like any import (the node is "Checking…" until then).
- `DELETE /sources/:id` (todo6 "Remove upload") moves the import's folder to the Trash (undoable).
- The daily purge: the worker calls `POST /api/v1/worker/scheduled/files.empty_trash` (worker token)
  at most hourly; the kernel runs it at most once a day (`scheduled_runs`). `{ "force": true, "days": 0 }`
  runs it now, e.g. from a shell.
