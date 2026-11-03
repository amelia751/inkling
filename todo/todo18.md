# Edge cases: what breaks when real people use it

**Goal.** Every flow a tester hits with real files survives the odd cases: the wrong format, two
tabs, a dropped connection, a slow worker, a viewer clicking Delete, an assistant run that outlives
its token. Nothing loses data, nothing spins forever, every failure says what happened and what to
do next.

**Status (2026-11-02, `main` b4d08fb).** Plan only, from five code audits of `main` after todo16
and todo17 Milestones 0–1 landed (first run and uploads; Sources, Trash and datasets; Studio and
viewers; the assistant; backend robustness). About 230 findings, merged and deduplicated here into
the ones worth fixing; each claim was traced to code, and the P0s were re-checked by hand.

**Naming.** The product name appears only in `packages/contracts/src/naming.ts`. Env vars are
written without their prefix.

---

## Start here (agents)

1. Read `AGENTS.md`, this file, then the area you take. Each item names the file to start from.
2. One worktree per workstream (§3): `git worktree add .worktrees/todo18-<ws> -b todo18-<ws> main`.
3. Every fix gets a test that fails before it (unit, api, or e2e). Edge cases come back otherwise.
4. Test with the tester's files (`~/Downloads/spurby-sample-data`: chest X-ray JPEGs, BraTS NIfTI,
   PTB-XL `.hea`+`.mat`, Kvasir `.avi`, ACDC 4D NIfTI + `Info.cfg`, TCGA `.svs`) and the scripted
   model. Keep `data-testid`s.

---

## 0. Fix first (P0: data loss, broken for a whole modality, or a safety net that isn't there)

| # | What breaks | Evidence | Fix |
|---|---|---|---|
| P0-1 | **Emptying Trash under Sources destroys datasets, collections and Studios too.** The Sources trash view lists only files, but calls `POST …/trash/empty`, which purges every kind | `kernel/trash.py` 414–433 `empty()`; `lib/files/api.ts` 132; `trash-view.tsx` | Sources › Trash calls a files-only empty (`?kind=sources`); the project Trash page keeps "everything", and its confirm dialog lists counts per kind |
| P0-2 | **Uploaded `.avi` videos can't be opened.** The video Studio matches only `.mp4/.webm/.zip`; the worker reads facts but never transcodes (seeds are transcoded by `tools/fetch-seeds.py`) | `plugins/video/ui/manifest.ts` 29; `apps/worker/src/studio_worker/inspect/__init__.py` | Worker derivative job: ffmpeg → H.264 MP4 (`derived/<sha>.mp4`), item points at the derivative; until it's ready the item shows "Converting video"; codecs ffmpeg can't read fail with the codec name (§1 D4) |
| P0-3 | **Uploaded `.svs` slides show "tile pyramid could not be opened".** The WSI viewer opens DZI; uploads aren't tiled (seeds are) | `plugins/wsi/ui/manifest.ts` 49; `wsi/.../controller.ts` 84–136 | Worker derivative job: OpenSlide → DZI pyramid + thumbnail + `mpp` from the header; "Preparing slide (n %)" until ready (§1 D4) |
| P0-4 | **Annotation saves are last-write-wins.** `put_document` ignores the client's revision, so two tabs or two people silently overwrite each other (versioning-off projects, which is the default) | `kernel/annotations.py` 145–157 | Compare `revision`; 409 with the server document; the Studio merges per annotation id (non-conflicting changes merge, same-annotation conflicts show a "Theirs / Mine" notice) |
| P0-5 | **The todo17 write pipeline protects nothing yet.** `admit()`, dry run and `Idempotency-Key` exist but no route uses them: 164 write routes are on the `check:writes` allow-list | `tools/check-writes/allowlist.txt`; `kernel/admission/http.py`; no `write_params` in `routes/` | Move routes onto `admit` in order of risk (§3 W5); the allow-list may only shrink (test) |
| P0-6 | **The local database drifts from the code.** Dev runs `create_all()` and never Alembic, so every new column breaks a tester's existing `apps/api/.data/api.db` ("no such column"; happened 2026-11-02) | `app.py` 95–96, `db.py` 89–93, `config.py` 441 | Dev startup runs `alembic upgrade head`; a database created by `create_all` without a version row is stamped from its tables or moved aside with a message saying where |

## 1. Decisions

| # | Decision |
|---|---|
| D1 | **One way to learn that data changed.** The project event stream (`use-project-events.ts`) invalidates every affected query for every event type (`fs.changed`, trash, restore, turn undo, dataset, task, environment), in one map, app-wide, not per page. Mutations call the same invalidation helper. No page relies on its own live hook. |
| D2 | **One error decoder in the web.** `api.ts` parses problem JSON (todo17 D6) and the old `{errors: […]}` / `detail` shapes into `ApiProblem {status, code, violations, retryable, retryAfter}`. UI states come from it: 401 → session, 403 → "You can view this project but not …", 404/410 → gone (with Trash link if trashed), 409 → conflict UI, 422 → the violations with fixes, 429 → countdown, 5xx/offline → retry. No more generic "Not saved · Retry". |
| D3 | **Actions follow the role, in one hook.** `useCan(action)` from the project role (and org role); every destructive or write control (Trash restore/forever/empty, delete, rename, upload, drop) hides or disables with a reason. The api stays the authority. |
| D4 | **Derived files are a worker step with a visible state.** For formats the browser can't show (AVI/MOV/MKV → MP4; SVS/NDPI/MRXS/TIFF slides → DZI), the worker writes derivatives keyed by content hash, linked to the source node, purged with it. Item ingest state gains `processing` with progress; Studio shows "Converting video" / "Preparing slide". |
| D5 | **Sidecars and pairs are understood at import.** `.hea` + `.mat`/`.dat`, `.hdr` + `.img`, ACDC `Info.cfg` (ED/ES frames, height, weight → item meta), BraTS `_seg` / `*_gt` (role `reference` / sequence `seg`). Lone halves are flagged "needs its pair" in the import, not left as unknown files. |
| D6 | **Nothing waits forever.** Every long state has a deadline and a way out: import inspecting (server sweeper marks failed after `API_IMPORT_STALL_MINUTES`), derivative jobs (dead-letter after 3 attempts), scheduled runs (stale `running` reclaimed), idempotency `in_progress` (swept), assistant client tools (fail immediately when the panel closes or the run stops). |
| D7 | **Leaving stops work you own.** Sign-out, org switch and a 401 abort in-flight uploads (cancel on the kernel), stop following assistant runs, and say so; uploads can resume after sign-in from the same files (server `_resumable`). |
| D8 | **Purge deletes everything it made.** Destroying files, datasets or projects also removes derived blobs (thumbnails, transcodes, tiles), versioning repos (call the service, then GC), annotation payloads; after-commit blob deletes that fail go to a retry table, swept daily. |

## 2. Findings to fix, by area

Severity: **P1** wrong or stuck state, **P2** polish. File paths are under `apps/web/src/studio/`
(web), `apps/api/src/studio_api/` (api), `apps/agent/src/` (agent) unless written in full.

### A. Sign-in, Home, uploads, imports

- [ ] P1 **401 mid-upload hides the tray but uploads keep going** (`session-gate.tsx` 15, `stores/uploads.ts`). D7.
- [ ] P1 **Sign-out and org switch don't cancel uploads** (`user-menu.tsx` 36–43, `switchers.tsx` 69–80). D7.
- [ ] P1 **401 on a chunk PUT retries 4× then marks the file failed** instead of stopping the session (`uploads.ts` 157–160). D7.
- [ ] P1 **Two uploads at once share one rights dialog**; the second overwrites the first and orphans its promise (`uploads.ts` 131–135, 224–226). Queue attestations or merge into one dialog with both counts.
- [ ] P1 **Resume matches files by path + size only**; a different file of the same size fails at the end as "damaged" (`start.ts` 189). Match by SHA when the server has it.
- [ ] P1 **URL import state `fetching` isn't in the contract or the UI** (blank label) (`packages/contracts/src/types/index.ts` 522, `imports.tsx` 16–24). Add it with progress (bytes fetched / total).
- [ ] P1 **Import sessions can sit in `inspecting` forever** server-side (drops have a stuck sweeper, imports don't) (`drops.py` 66–77, worker `inspect/__init__.py` 54–56). D6.
- [ ] P1 **A file that keeps crashing inspection is redelivered forever** (unacked event). Dead-letter after N, mark that file unsupported with the reason.
- [ ] P1 **Fast path opens the Studio before the first item exists** (`boots.ts` 110–126): empty canvas flash. Navigate on the first `item.ready`, show "Preparing your first item" until then.
- [ ] P2 Home: the projects-list error is hidden when there are no recent projects (`HomePage.tsx` 24–41).
- [ ] P2 "Try a sample" has no loading state (`sample-picker.tsx` 19–21).
- [ ] P2 No warning on tab close while "Checking files" (`uploads.ts` 119).
- [ ] P2 Drop 429 shows a raw error; parse `Retry-After` into a countdown (`start.ts` 149–151).
- [ ] P2 Undo-blocked plan (annotations exist / published) shows a generic error; show the kernel's reason (`PlanCard.tsx` 96–101).
- [ ] P2 A second plan card after more files arrive needs one line of copy explaining it (`drops_plan.py` 227–240).
- [ ] P2 Junk files: add `.git/`, `Thumbs.db`, `desktop.ini` to the client and kernel junk lists (`walk.ts` 19–25).
- [ ] P2 URL import is assistant-only; add "Import from a link" to the Sources upload menu (same attestation).
- [ ] P2 Pairs and sidecars (D5): `.hdr` without `.img`, `.dat` without `.hea` → "needs its pair".

### B. Sources, Trash, datasets, routing

- [ ] P0-1 (above).
- [ ] P1 **Project Trash shows one row per trashed file with the same batch key** (React key collision, duplicate actions) (`kernel/trash.py` 498–508, `TrashPage.tsx` 80). One row per batch ("pneumonia and 5 more"), expandable.
- [ ] P1 **Viewers see Restore / Delete forever / Empty trash** (`TrashPage.tsx` 152–157). D3.
- [ ] P1 **Restore into a name that's taken just toasts an error** (`trash-api.tsx` 167). Reuse the Sources conflict dialog (keep both / replace / skip).
- [ ] P1 **Project Trash isn't paginated** (`kernel/trash.py` 529–534, `trash-api.tsx` 122). Cursor + virtual list.
- [ ] P1 **One pending action disables every Trash row** (`TrashPage.tsx` 81). Pending per batch; lock the batch server-side too (C below).
- [ ] P1 **Delete proceeds without the "used by datasets" warning when the impact preview fails** (`trash-api.tsx` 242–248, `FilesPage.tsx` 517) and the delete dialog enables Confirm on preview error (`delete-dialog.tsx` 63). Block with Retry.
- [ ] P1 **Copy/move over 1,000 operations fails with 413** (`fs.py` 774). Server-side subtree copy/move op, or client chunks with progress.
- [ ] P1 **Assistant turn undo from Activity refreshes only Activity** (`ActivityPage.tsx` 85). D1.
- [ ] P1 **`fs.changed` isn't in the app-wide event invalidation**; only the Sources page listens (`use-project-events.ts` 101–108). D1.
- [ ] P1 **After trash/restore, Overview, dataset detail and open Studios are stale** (`trash-api.tsx` 148–153). D1.
- [ ] P1 **"Restore all" on a dataset fires parallel restores** (`DatasetOverview.tsx` 54). One request restoring all batches.
- [ ] P1 **Rename in place saves on blur even when invalid**; names like `.`, `..`, spaces pass; 256 chars vs 255 bytes for files (`delete-dialog.tsx` 109–132, `routes/trash.py` 88–90). One name validator shared by api and web.
- [ ] P1 **Two Trash entry points** (Sources › Trash files-only, sidebar Trash everything) with different counts. Keep the sidebar Trash as the one place; Sources › Trash becomes a filter of it ("Sources" chip pre-selected).
- [ ] P2 "Search all files" placeholder → "Search Sources" (`FilesPage.tsx` 1073); sweep other "Files" leftovers.
- [ ] P2 Undo refused because someone changed things later shows a generic toast; show who and what (`fs.py` 994–1002).
- [ ] P2 Overview and Activity errors are plain text; use `ErrorView` (`ProjectOverviewPage.tsx` 63, `ActivityPage.tsx` 35).
- [ ] P2 "Task not found" doesn't say when the Studio is in Trash (`DatasetStudioPage.tsx` 200); 410 with a Trash link (D2).
- [ ] P2 Search: trashed matches link only to file Trash, and stop counting at 5,000 (`kernel/trash.py` 217).

### C. Studio and viewers

- [ ] P0-2, P0-3, P0-4 (above).
- [ ] P1 **422 on save (label not in the label set) shows "Not saved · Retry"** (`WorkStateChip.tsx` 29–34, `api.ts` 8–9). D2: say which label, link to Labels, offer "Add label" / "Change to …".
- [ ] P1 **Assistant or person removes a label while you annotate**: `activeLabel` points at nothing, next save 422 (`ViewportHost.tsx`, `studio.ts`). On environment change, clear or remap the active label and list annotations whose label is gone ("3 annotations use a removed label: Restore label / Relabel").
- [ ] P1 **Saves fail offline with no retry** (`DatasetStudioPage.tsx` 588–634). Back-off retry, an "Offline, changes kept" chip, and stash to sessionStorage (as on session expiry).
- [ ] P1 **In-app navigation with unsaved annotations** has no prompt (`beforeunload` only). Router blocker when dirty and not yet saved.
- [ ] P1 **BraTS segmentation opens as a fifth grey sequence** when not tagged `seg` (`volume/dataKind.ts` 39–41). D5 at import; the viewer also treats integer label volumes with ≤ 16 values as masks.
- [ ] P1 **NIfTI orientation ignored** (qform/sform not applied; `nifti.ts` 48–57): flipped or rotated volumes. Apply the affine; status-bar warning when qform and sform disagree (lint `nifti.orientation-mismatch` already exists).
- [ ] P1 **Whole NIfTI loaded into memory as Float32** (`nifti.ts` 32–46): 4D cine plus references can exhaust a tab. Keep native type, load per frame for 4D, a worker-made preview for > 512 MB.
- [ ] P1 **ACDC `Info.cfg` isn't read on upload**, so ED/ES phases are unknown (`cine/model.ts` 197–205). D5.
- [ ] P1 **Reference volumes that fail to load fail silently** (`cine/Host.tsx` 89–93). Notice in the status bar.
- [ ] P1 **ECG `.hea` + `.mat` upload pairing** relies on `asset.raw`, unverified for uploads (`wfdb.ts` 167–195). e2e with the PTB-XL files; "Signal file missing" if the pair is broken.
- [ ] P1 **A plugin disabled mid-session only warns in the console** (`DatasetStudioPage.tsx` 537–554). Banner: "Setup changed and can't be applied: reload".
- [ ] P1 **Dataset or Studio trashed while open** isn't noticed until reload. Event → the same blocked state with Restore.
- [ ] P1 **Single `.dcm` in the 2D preset** loads as a series of one; flag `dicom.series-incomplete` and offer the volume Studio.
- [ ] P2 Image load errors don't say 404 vs can't decode (`CornerstoneStackEngine.ts` 165–169).
- [ ] P2 Undo spans items (one global stack, `studio.ts` 173–181): scope undo per item, or show which item an undo changes.
- [ ] P2 "Setup updated by <who>" toast when the environment revision jumps under you (`live-environment.ts`).
- [ ] P2 WSI: tile 404s become one error, not holes (`wand.ts` 16–21); µm/px from the header (D4).
- [ ] P2 Video: show the codec in playback errors; module-load failures name the module (`DatasetStudioPage.tsx` 110).

### D. The assistant

- [ ] P1 **Closing the panel mid-run leaves the stream attached with no host**: browser tools then wait for their timeout (`assistant-panel.tsx` 217–220, `agent.ts` 225–226). Keep one background follower per run in the store (not the panel); browser tools fail at once with "the Studio isn't open".
- [ ] P1 **Stop doesn't stop browser-side tool work** (`agent.ts` 366–373). Abort locally and post the failure immediately.
- [ ] P1 **Sending in project B while project A's run is active silently does nothing** (`agent.ts` 326–327). Allow one run per project, or say "Waiting for the assistant in A · Stop it".
- [ ] P1 **Approval cards flip to approved before the server agrees**; a second tab or an expired approval then shows the wrong state (`agent.ts` 399–403). Pending until the POST succeeds; countdown from `expiresAt`; disable when expired; reconcile from `approval-resolved`.
- [ ] P1 **Approved, then the tool failed** (target gone): the card still says approved (`operations.ts` 111–113). Patch the card with the failure.
- [ ] P1 **Two items with the same name: `findItem` picks by substring** (`lib/agent/card-tools.ts` 123–163). Exact id or exact name only; several matches → ask.
- [ ] P1 **Second tab doesn't follow a run the first tab follows** (`agent.ts` 361–364). `BroadcastChannel` mirror, or "Following in another tab · Take over".
- [ ] P1 **Long runs outlive the delegated kernel token** (1 h, `context.py` 191–195; refreshed only on send, `sessions.ts` 618). Refresh on 401 inside the run, or mint per run with the run's max duration.
- [ ] P1 **Provider errors are raw** (bad key, 429, context length) (`sessions.ts` 742). Map to plain messages with the action (check key, wait n s, start a new chat).
- [ ] P1 **Budget stops look like failures** (`sessions.ts` 856). Say which budget, how to raise it.
- [ ] P1 **Reconnecting is invisible** until it fails (`client.ts` 70–108); a 404 stream says nothing useful. "Reconnecting…" line; "This reply ended on the server; your chat is still here".
- [ ] P1 **Upload card during an active reply** silently defers (`assistant-panel.tsx` 254). "Will send when the current reply finishes".
- [ ] P1 **Two undo buttons with different scopes** (trash card vs turn undo) (`thread.tsx` 217–257, `operations.ts` 124–141). One "Undo this turn" per assistant message; the trash card links to it.
- [ ] P2 Home's pending ask is lost when the assistant isn't ready at mount (`pending-ask.ts` 73–81): retry on ready.
- [ ] P2 Reorg-card undo id lives in sessionStorage only (`reorg-plans.ts`): store it on the message part.
- [ ] P2 URL import progress in chat (poll the import, update the card).
- [ ] P2 Snapshot truncation (3,000 annotations) not shown; show it in the context chip.
- [ ] P2 Dev badge "Scripted model" when the provider is scripted.
- [ ] P2 AI notice says file contents never go to the model; add that names and file facts do (`ai-notice.tsx`).

### E. Backend

- [ ] P0-5, P0-6 (above).
- [ ] P1 **Restore and destroy of the same Trash batch can run at once** (`kernel/trash.py` 294–411). Lock the batch row (`FOR UPDATE`), state `restoring` / `destroying`, 409 to the loser.
- [ ] P1 **A crashed daily `files.empty_trash` wedges until tomorrow** (`routes/worker.py` 268–283). Reclaim `running` older than 30 min.
- [ ] P1 **One destroy approval used twice in parallel → 500** (get-then-insert, `kernel/approvals.py` 98–101). `INSERT … ON CONFLICT DO NOTHING RETURNING`; 403 "already used".
- [ ] P1 **Purging files updates the dataset definition even when the versioning commit fails** (`kernel/trash.py` 244–254). Fail the transaction when versioning is configured and the commit fails.
- [ ] P1 **Project destroy leaves versioning repos and derived blobs** (`kernel/trash.py` 356–391, derived keys from `ingest.py` 266, `inspection.py` 124). D8.
- [ ] P1 **SQLite dev: two workers can process the same task item** (no `SKIP LOCKED`, `kernel/ingest.py` 217–228). Conditional lease update like plugin jobs.
- [ ] P1 **`rules.scan` is configured but not implemented** (`config.py` 64; no worker route). Implement (todo17 Milestone 3) or remove the setting until then.
- [ ] P2 Unhandled errors return `{"detail": "internal error: …"}`; return problem JSON with the request id and no user strings (`app.py` 143–145).
- [ ] P2 Errors echo file names and item ids (possible PHI) (`fs.py` 790, `annotations.py`); codes + paths in agent-facing errors, names only to people.
- [ ] P2 Unbounded lists: projects (`projects.py` 349), environment history (`environments.py` 208), trash (above). Cursor pagination with caps.
- [ ] P2 Case-only name collisions (macOS vs Linux): enforce case-folded uniqueness per folder (`tree.py` 100–110).
- [ ] P2 Archive limits checked at unpack, not at upload: record entry count and ratio at import, refuse bombs early (`unpack.py`).
- [ ] P2 `fs/ops` without `expect` overwrites silently (`fs.py` 785–790); require it once on `admit`.
- [ ] P2 After-commit blob deletes fail silently (`aftercommit.py` 28–31, `kernel/trash.py` 385–391). D8 retry table + metric.
- [ ] P2 `/readyz` ignores the versioning service when it's configured (`routes/ops.py` 36–61).
- [ ] P2 URL import pins only the first A record (`url_imports.py` 129); document it.

## 3. Workstreams and order

| WS | Scope | Size | Order |
|---|---|---|---|
| W1 `todo18-trash` | P0-1, all of B, backend trash locks and approvals | 3 days | Now |
| W2 `todo18-media` | P0-2, P0-3, D4, D5, C viewers (orientation, memory, seg, cine, ECG, DICOM) | 5 days | Now |
| W3 `todo18-save` | P0-4, D2 (web error decoder), C saving and labels, D1 invalidation map | 4 days | Now |
| W4 `todo18-session` | D7, A uploads/session/imports, D6 sweepers | 3 days | After W3's D2 |
| W5 `todo18-admit` | P0-5: move write routes onto `admit` (trash and destroys, fs/ops, datasets, annotations, environments, rules, then the rest), idempotency on, problem JSON everywhere, allow-list shrinks to zero | 5 days | Now, in slices |
| W6 `todo18-devdb` | P0-6, SQLite parity items | 1 day | Now (first) |
| W7 `todo18-assistant` | All of D | 4 days | After W3's D2 |
| W8 `todo18-purge` | D8, versioning repo delete + GC, derived blobs, retry table | 2 days | After W2 |

## 4. Edge-case test suite (added by this plan)

- `apps/web/e2e/edge_media_test.py`: upload each file type from the tester set; each opens in its
  Studio (AVI after conversion, SVS after tiling, ECG pair, cine with ED/ES, BraTS with seg as mask).
- `edge_trash_test.py`: Sources-trash empty leaves datasets in project Trash; viewer sees no
  destructive buttons; restore conflict dialog; batch row with "and 5 more".
- `edge_concurrency_test.py`: two tabs annotate the same item (merge and conflict notice); two tabs
  restore and destroy the same batch (one 409).
- `edge_session_test.py`: sign out mid-upload (uploads cancelled, message); org switch mid-upload;
  401 mid-run for the assistant.
- `edge_stuck_test.py`: worker stopped → import fails at the deadline with a reason; poison file
  dead-lettered; daily job reclaimed after a crash.
- api: approval double-use, versioning-down purge rollback, dev DB auto-migrate from a
  `create_all` database, `check:writes` allow-list never grows.
- agent (scripted): panel closed mid-run, stop during a browser tool, ambiguous names, expired
  approval, token refresh during a long run.

## 5. Checked and not a bug

- Destroy approval tokens live 5 minutes while the approval card waits 10: the token is signed when
  the tool runs, after approval (`apps/agent/src/tools/operations.ts` 101–106), so it can't expire
  while the card waits.
- Moving a folder into its own descendant is refused on both sides (`fs.py` 360–364, `dnd.ts` 91).
- Zero-byte files, folder drops, `.DS_Store`, duplicate bytes, extensionless DICOM, SSRF on URL
  imports, model-output XSS (links are `http(s)` only), IME Enter: handled.

## 6. Config added

| Key | Service | Default | Meaning |
|---|---|---|---|
| `API_IMPORT_STALL_MINUTES` | api | `15` | Import inspecting longer than this fails with a reason (D6) |
| `WORKER_DERIVE_MAX_ATTEMPTS` | worker | `3` | Derivative jobs (transcode, tiling) before dead-letter (D4, D6) |
| `WORKER_TRANSCODE_MAX_BYTES` | worker | `10737418240` | Largest video the worker converts (D4) |
| `API_SCHEDULED_RECLAIM_MINUTES` | api | `30` | A scheduled run stuck in `running` this long is reclaimed (D6) |
