# Files: make Sources a real file system

**Goal.** Sources looks right but behaves like a read-only viewer. Researchers expect what Drive, Finder and
kiwifs give them: make a folder, rename, drag to move, cut and paste, delete to a Trash, undo, select many
and act on them all, download, replace a file with a newer version. This plan turns the project's files into
a **file system**, built on the kiwifs tree we already copied. Two things that make Inkling trustworthy stay
intact:

- the **bytes** of every upload are immutable;
- nothing a dataset or a version depends on changes silently.

**The rule that reconciles the two:** *bytes are immutable; the namespace is yours.* Names and folders can
change freely. Every change is journaled, undoable and restorable, and the name and path a file arrived with
are kept as provenance. This replaces todo6's "design implication 2: originals are read-only in the UI".

**Audit date:** 2026-10-30, against `main` 06da688 (todo6 merged).

## Status (2026-10-30)

Not started. This file is the plan; nothing in the code has changed yet.

---

## 0. Where we are, next to kiwifs

What todo6 built (`apps/web/src/studio/app/routes/SourcesPage.tsx`,
`components/sources/*`, `packages/ui/src/ui/file-tree.tsx`, `apps/api/.../kernel/tree.py`):
- a three-pane layout (tree, listing, inspector);
- lazy pages of children (500 at a time);
- compact single-child chains and collapsed numbered runs;
- natural sort and a reveal flash;
- Quick Look, search with kind and status chips;
- a list or grid view remembered per folder kind;
- recursive OS folder drop, an upload tray, and an Imports history;
- privacy flags, and a context menu with Open, Quick Look, Show in Explore, Copy path and Remove upload.

The tree passes `disableDrag`, `disableDrop` and `disableEdit`.

| Capability | kiwifs (`~/kiwifs/ui/src`) | Inkling today | This plan |
|---|---|---|---|
| New folder | "New page in …", a hover `+` on folder rows (`KiwiTree.tsx` ~1153) | — | Phase 2 |
| Inline rename | arborist edit mode plus `RenameInput` (Enter / Esc), `/rename`, `/rename-dir` | — | Phase 2 |
| Move by drag and drop | arborist `onMove`, optimistic `applyOptimisticTreeMove` with rollback (`lib/treeReorder.ts`), no folder into itself | — | Phase 3 |
| Move to… dialog | a prompt for a path ("Move folder") | — | Phase 3 (a folder picker, not a typed path) |
| Cut, copy, paste | ⌘C / ⌘X / ⌘V (`lib/treeClipboard.ts`, `KiwiTree.tsx` ~730) | — | Phase 3 |
| Duplicate | `KiwiTreeDialogs.tsx` | — | Phase 3 |
| Delete | delete with a confirmation; contents snapshotted for undo | only "Remove upload" for a whole import | Phase 4 (Trash) |
| Undo | `stores/fileOpsStore.ts` (zundo, 50 ops: delete, move, upload) | — | Phase 4 (server journal) |
| Multi-select | arborist selection, ⌘A | one row at a time | Phase 2 |
| Upload into a folder | context menu "Upload files to …", drop on a row | drop on a row (works) | menu items in Phase 2 |
| Sort modes | name or type (`treeSortMode`), stored | name only in the tree; column sort in the list | Phase 5 |
| Tree filter | sidebar filter → arborist `searchTerm` | project-wide search only | Phase 5 |
| Collapse all, expand recursively | "Collapse all folders"; Alt-click opens recursively (`openFolderRecursive`) | — | Phase 5 |
| Starred, pinned, recent | `AppSidebar.tsx` sections | — | Phase 5 |
| History of a file | `KiwiHistory`, `KiwiDiff`, `/versions`, `/blame` (git) | provenance only | Phase 6 (versions) |
| Live updates | SSE → refresh, guarded against optimistic races (`lib/treeRefresh.ts`) | SSE for imports only | Phase 1 |
| Breadcrumb | `KiwiBreadcrumb.tsx` | a path bar with Copy path | Phase 5 (drop targets, sibling menus) |
| Download | — | — | Phase 6 |

### Three things that would break today if we just turned editing on

1. **Node ids come from paths.** `tree.node_id(source_id, rel_path)` hashes the path. A rename that
   recomputed ids would orphan every reference. A new upload to an old path after a move would collide
   with the moved node's id.
2. **Datasets follow folders live.** `definition.nodeIds` can name folders, and `tree.files_under()` walks
   them at read time (`kernel/projects.py` ~590). Moving a file out of a folder would silently remove it
   from a dataset; moving one in would silently add it. ux.md forbids exactly that.
3. **`rel_path` is stored on every node.** Moving a folder of 100k slices would rewrite 100k rows.

What's already safe: a Studio item's id is the **asset's storage path** (`Asset.path`; image2d's
`groupItems` uses `id: a.path`), not the node's name. Annotations survive renames *as long as `Asset.path`
never changes*. That becomes an invariant (D3).

---

## 1. Decisions (decide before Phase 1)

- [ ] **D1. One drive per project.** Today every import and every seed is its own tree root (`sources`).
  **Recommended:**
  - The project has **one root** ("Files"). An import lands in a folder you choose (default: a new folder
    named after the dropped folder, or the folder you dropped on).
  - `sources` stay as import *provenance* (who brought what, when, from where), shown in the inspector and
    the Imports list, not as roots.
  - Migration: each existing source root becomes a top-level folder with the source's title.
- [ ] **D2. Sample data is locked.** Seed folders are read-only (a `LockIcon` on the row, "Sample data
  can't be changed. Copy it to make your own"). Copy-out is allowed, and costs nothing (D5).
- [ ] **D3. Identity and storage invariants.**
  - **Node ids are opaque and permanent.** New nodes get `nod-<uuid>`, and existing hashed ids are kept
    as they are. Upload idempotency moves to `upload_files.node_id` (a re-sent file in the same session
    finds its node), not to a path hash.
  - **`Asset.path` (the storage key) never changes** after upload, whatever happens to the name.
  - **Bytes are never mutated.** "Replace" makes a new asset and a new node version (D6).
- [ ] **D4. Paths are computed, not stored.** Drop the stored current path. Keep `original_path` (the path
  as uploaded, read-only, from today's `rel_path`).
  - The current path comes from the parent chain (`tree.ancestors`, or a recursive CTE for lists). Search
    results and breadcrumbs need at most a few hundred of them.
  - A move is then one row update plus count updates up two ancestor chains, whatever the folder size.
- [ ] **D5. Copy is free.** Copy and duplicate create new nodes pointing at the **same asset**; no bytes are
  copied. Deleting a copy never affects the original.
- [ ] **D6. Versions of a file.** Uploading a file with the same name into the same folder asks **Keep
  both / Replace / Skip**. "Replace" adds a version: the node points at the new asset, and `node_versions`
  keeps the old one. You can restore any version.
  - **Datasets pin asset versions**, so a replaced file shows "Newer version available" in its dataset and
    changes only when someone updates it there, with a warning that annotations stay on the version they
    were drawn on.
- [ ] **D7. Datasets resolve to files when created.** **Recommended:**
  - Creating a dataset turns folder references into a frozen list of file node ids and their asset
    versions (`definition.files`).
  - The folders are kept only as `definition.followedFolders`, for a banner: "4 new files in *MRI* since
    this dataset was made. **Add them**".
  - Migration `0005` resolves existing definitions once.
  - *Alternative:* datasets follow folders live. That's simpler, but a drag in Files would silently change
    a dataset. Rejected.
- [ ] **D8. Delete means Trash.** Delete moves to Trash (soft delete with `trashed_at`, `trashed_by` and
  `trash_batch_id`).
  - Restore puts things back where they were (or in the root if that folder is gone, saying so).
  - Items stay 30 days, then a worker job purges them. "Delete forever" is manual.
  - Bytes are deleted only when no node (including in Trash), dataset, version or annotation references
    the asset. Otherwise purging removes the name and keeps the bytes, and the dialog says why ("Kept:
    the *LV v2* version uses it").
- [ ] **D9. Undo lives on the server.** Every operation writes an `fs_ops` journal row with its inverse.
  ⌘Z undoes the last batch *this person* did in this project, if nothing has touched those nodes since.
  Otherwise: "Can't undo: *patient_002* changed after that". kiwifs's client-side zundo stack can't survive
  a reload or another tab; ours must.
- [ ] **D10. Name rules.**
  - Names are unique per folder, **case-insensitively** for new operations, so exports to macOS and
    Windows don't collide. Existing case-only duplicates are allowed and marked.
  - Names can't contain `/` or control characters, and are at most 255 bytes. Trailing spaces and dots
    are trimmed. Windows reserved names (`CON`, `NUL`, …) get a warning, not a block.
  - Changing an extension asks for confirmation ("The file's content won't change").
- [ ] **D11. The visible name of the section.** The data is now a file system, and "Files" is the word
  researchers use. **Recommended:** the nav label and page title become **Files**, and the route becomes
  `/projects/:p/files/:nodeId?`. `/sources/*` redirects, and every `data-testid` (`sources-page`,
  `sources-tree`, …) stays as it is (regression contract). "Source" stays the word for an import's
  provenance. ux.md §2 and the glossary are updated.
- [ ] **D12. Namespace operations need the API.** The seed server's stand-in stays read-only (writes return
  501, and the UI disables the edit actions with "Needs the full stack"). UI tests for editing live in
  `tests/e2e/`, against a scratch project.

---

## 2. Interaction spec (applies to every phase)

### Where actions live

| Surface | What's there |
|---|---|
| **Tree header** (new, 32px, above the tree; kiwifs `AppSidebar` "Pages" header) | "Files" label, then icon buttons: New folder, Upload, Collapse all, Sort ▾, and a filter field that narrows the tree as you type |
| **Folder row hover** | `+` (new folder inside) and `⋯` (the row's menu), shown on hover or focus only (kiwifs ~1153) |
| **Toolbar**, nothing selected | path bar · search · view · details · **New ▾** (Folder, Upload files, Upload folder) |
| **Toolbar**, ≥1 selected | a **selection bar** replaces it (Drive): "3 selected" · Move to… · Copy · Download · Star · Move to Trash · ✕ clear |
| **Context menu** | right-click or `⋯` on any row in the tree, list or grid, and on breadcrumb segments; contents per type below |
| **Inspector** | adds Versions and Activity sections, and a **Rename** pencil next to the title |
| **Tree footer** | Starred · Recent · Imports · **Trash** (count) |

### Context menus

Use Radix `ContextMenu` (a new shadcn `packages/ui/src/ui/context-menu.tsx`) with keyboard hints from the
command registry.

| Row type | Items |
|---|---|
| Folder | Open · New folder inside · Upload files here · Upload folder here — Rename · Move to… · Duplicate · Cut · Copy · Paste *(n items)* — Star · Download as ZIP · Copy path · Show in Explore — Move to Trash |
| File | Open / Quick Look · Open in Studio *(when a task uses it)* — Rename · Move to… · Duplicate · Cut · Copy — Star · Download · Replace with new version… · Version history · Copy path — Move to Trash |
| Numbered run | Open · Select all *n* files — Move to… · Cut · Copy · Download as ZIP — Move to Trash |
| Sample (locked) | Open · Copy to… · Download · Copy path *(edit items shown disabled, with the reason)* |
| Trash item | Restore · Delete forever |
| Several selected | the selection bar's actions, plus Paste when the clipboard has something |

### Keyboard

Declared as core commands with `when: section == files`. Never hard-coded: `AGENTS.md`, and the
`shell-commands.test.ts` pattern.

| Action | macOS | Windows / Linux | Note |
|---|---|---|---|
| New folder | ⇧⌘N | Ctrl+Shift+N | Finder, Explorer |
| Rename | F2 / Enter-on-focused-name in the inspector | F2 | Enter stays "open" in tree and list (todo6) |
| Cut / Copy / Paste | ⌘X / ⌘C / ⌘V | Ctrl+X / C / V | kiwifs `treeClipboard`; paste goes into the focused folder or the listed one |
| Duplicate | ⌘D | Ctrl+D | |
| Move to Trash | ⌘⌫ | Delete | |
| Undo / Redo | ⌘Z / ⇧⌘Z | Ctrl+Z / Ctrl+Y | server journal (D9) |
| Select all / Clear | ⌘A / Esc | Ctrl+A / Esc | |
| Extend selection | ⇧↑ ⇧↓, ⇧-click, ⌘-click | same with Ctrl | |
| Expand all below | ⌥-click, or ⌥→ | Alt-click, Alt+→ | kiwifs `openFolderRecursive` |
| Info (toggle inspector) | ⌘I | Ctrl+I | |
| Already there | Space Quick Look · ⌘↑ parent · ⌘F search · ← → in Quick Look | | todo6 |

### Drag and drop

- **Sources:** rows in the tree, list or grid (one or a selection). **Targets:** a folder row in the tree,
  a folder row or tile in the listing, a breadcrumb segment, or Starred folders.
- The drag ghost is a chip: "3 items" with the first item's icon. The target row gets the
  `--g-selection-hover` fill and a 1px `--g-line-focus` ring. This is the same visual as the OS-file drop
  that exists today, so there's one visual language for "this goes here".
- **Spring-loaded folders:** hovering a closed folder for 700ms opens it. The tree and listing autoscroll
  near their edges.
- **⌥ (Alt) while dropping copies** instead of moving (Finder); the ghost shows a `+`.
- **No reordering inside a folder.** Order is always the sort order. Arborist's drop is limited to "into a
  folder" (`disableDrop` as a function, so between-row targets aren't allowed).
- **Invalid targets** show a not-allowed cursor and a tooltip reason: into itself or a descendant, into a
  sample folder, into Trash (use Delete), or a name conflict that needs a decision (opens the conflict
  dialog on drop).
- **Esc cancels.** Every drag has a keyboard twin: Cut and Paste, or Move to…, for accessibility.
- OS files dragged in keep today's behavior (`fromDataTransfer` → `addData`), now landing in the target
  folder of the one-root drive (D1).

### Feedback

- **Optimistic, with rollback** (kiwifs `applyOptimisticTreeMove`). The React Query child pages update
  immediately; on error they're restored, and a toast says why.
- **Toasts (sonner, bottom-left so the upload tray keeps bottom-right):** "Moved 3 items to *MRI* ·
  **Undo**", "Moved *scan001.dcm* to Trash · **Undo**", "Renamed to *patient_002*". They last 6 seconds,
  pause on hover, and collapse into one when operations are rapid.
- **Screen readers:** the same text goes to an `aria-live="polite"` region.
- **Live sync:** an `fs.changed { parentIds, batchId, actor }` SSE event invalidates only those folders'
  children queries. Loads that started before this tab's last local change are ignored (kiwifs
  `shouldApplyTreeLoad`). Changes by others show briefly with their name: "Lam moved 2 items here".

### Conflict dialog (move, copy, paste, upload)

"*An item named "scan001.dcm" already exists in MRI.*"
- Files: **Keep both** (becomes `scan001 (2).dcm`), **Replace** (adds a version, D6) or **Skip**.
- Folders: **Merge** (contents go in, recursing the same question) or **Keep both**.
- The checkbox "Do this for the other *36* conflicts" sits next to the buttons.
- Same-hash files skip silently, with a summary line ("12 identical files skipped"), as uploads do today.

### Rename

- Inline in the tree (arborist edit mode, as kiwifs's `RenameInput`), in the list's Name cell, and in the
  inspector title.
- **The name without its extension is selected on focus** (Finder). Enter saves, Esc cancels, and blur
  saves.
- Validation runs live (D10), with the error under the field ("A file named *x* is already here").
- Renaming something that a privacy flag was raised on re-runs the path-name check (Phase 7). This is the
  everyday way to remove a patient name from a file name.

### Visuals (existing tokens only)

- Cut items render at 50% opacity until pasted or the clipboard clears (Finder).
- The Trash view is a normal listing with a banner: "Items in Trash are deleted after 30 days. **Empty
  Trash**". Its columns are Name, Original location, Deleted by, Deleted.
- Starred rows show a small `StarIcon` (Gravity `Star`) after the name.
- New icon exports in `packages/ui/src/icons/index.ts`, named by job:

  | Export | Gravity glyph |
  |---|---|
  | `NewFolderIcon` | `FolderPlus` |
  | `RenameIcon` | `PencilToLine` |
  | `MoveIcon` | `FolderArrowRight` |
  | `CutIcon` | `Scissors` |
  | `PasteIcon` | `CopyArrowRight` (Gravity has no clipboard glyph) |
  | `TrashIcon` | `TrashBin` (already `DeleteIcon`; reuse it) |
  | `RestoreIcon` | `ArrowUturnCcwLeft` |
  | `StarIcon` / `StarFillIcon` | `Star` / `StarFill` |
  | `DownloadIcon` | `ArrowDownToLine` (reuse `ExportIcon`'s glyph) |
  | `VersionsIcon` | `ClockArrowRotateLeft` (reuse `HistoryIcon`'s glyph) |
  | `CollapseAllIcon` | `ChevronsCollapseVertical` |

  Every glyph above was checked against `@gravity-ui/icons` 2.23.0.

---

## Phase 1. Backend: a namespace that can change safely

### 1.1 Schema (migration `0005_files_namespace`)
- [ ] `source_nodes` changes:
  - rename `rel_path` → `original_path` (immutable);
  - add `project_root` (all nodes of a project share one root, D1);
  - add `trashed_at`, `trashed_by`, `trash_batch_id`, `starred_by` (a JSON set of principals; or a
    `node_stars` table if it grows), `version` (int) and `total_bytes` (folders);
  - unique index on (parent_id, lower(name)) where `trashed_at` is null, created after flagging existing
    case-only duplicates (D10).
- [ ] Re-parent existing source roots under one project root per project, one folder per source (D1).
  Seed folders get `locked = true`.
- [ ] `node_versions` (node_id, version, asset_id, sha256, size, created_by, created_at), backfilled with
  version 1 for every file.
- [ ] `fs_ops` (id, project_id, batch_id, actor, kind
  `mkdir|rename|move|copy|trash|restore|purge|replace|restore_version`, node_id, `before` JSON, `after`
  JSON, at, `undone_by_batch`). Index on (project_id, actor, at).
- [ ] `upload_files.node_id`: idempotent upload completion (D3). New node ids are `nod-<uuid>`; stop calling
  `node_id(source, path)` for new rows.
- [ ] Dataset definitions: resolve `nodeIds` into `files: [{nodeId, assetId, version}]` plus
  `followedFolders` (D7). `tree.files_under` is then used only for previews and for the "new files"
  banner.

### 1.2 Kernel (`kernel/fs.py`, new; `tree.py` loses path writes)
- [ ] `path_of(node)` and `paths_of(nodes)` (one recursive CTE) replace every `rel_path` read:
  `projects.py` `folderPath`, search results, Explore's evidence, exports. Use
  `rg -n "rel_path" apps/api apps/worker` to find them all; inspection keeps reading `original_path`.
- [ ] `apply(db, ctx, project, ops: list[Op], *, expect: dict[parent_id, revision] | None) -> Batch`:
  - one transaction, all-or-nothing;
  - validates names (D10), lock state (D2), cycles (no folder into itself or below), membership and
    conflicts (returns `409 { conflicts: [...] }` unless every conflict carries a resolution);
  - writes `fs_ops` with inverses;
  - updates `child_count`, `descendant_count` and `total_bytes` along the old and new ancestor chains;
  - records one audit entry per batch (`files.moved`, `files.renamed`, `files.trashed`, …, with counts and
    the batch id), and emits `fs.changed`.
- [ ] `undo(db, ctx, project, batch_id)` and `redo`. Refuse when any touched node has a later op by anyone
  (D9). An undone batch is itself journaled.
- [ ] `trash`, `restore`, `purge`, and an `empty_trash` worker job. It runs daily, purges items over 30
  days old, and keeps bytes still referenced (D8).
- [ ] `replace(node, upload)`: a new asset, `version += 1`, a `node_versions` row, and inspection re-runs on
  the new bytes. `restore_version(node, v)` is a journaled op.
- [ ] Proposals that reference nodes whose names changed are marked `stale` (status unchanged, and an
  evidence flag). Explore shows "Names changed since this was suggested. **Re-check**", which re-runs the
  matcher for that proposal. Confirmed relationships hold node ids and stay valid.

### 1.3 Routes (`routes/files.py`; `/sources/*` reads stay as aliases)
- [ ] `POST /v1/projects/:id/fs/ops` with a body of `{ ops: [...], resolutions?: {...}, expect?: {...} }`
  → `{ batchId, nodes, conflicts? }`. Op shapes:
  - `{ kind: "mkdir", parentId, name }`
  - `{ kind: "rename", nodeId, name }`
  - `{ kind: "move", nodeIds, parentId }`
  - `{ kind: "copy", nodeIds, parentId }`
  - `{ kind: "trash", nodeIds }`
  - `{ kind: "restore", nodeIds }`
  - `{ kind: "purge", nodeIds }`
- [ ] `POST /v1/projects/:id/fs/undo` and `…/redo` (`{ batchId? }`, defaulting to the caller's last).
- [ ] `GET /v1/projects/:id/trash?cursor=` and `GET /v1/projects/:id/starred`.
  `POST /v1/source-nodes/:id/star` / `DELETE` for unstar.
  `GET /v1/projects/:id/recent` (from `fs_ops`, `project_resume` and inspector opens, per principal).
- [ ] `GET /v1/source-nodes/:id/versions`, `POST /v1/source-nodes/:id/versions` (an upload session in
  replace mode), and `POST /v1/source-nodes/:id/versions/:v/restore`.
- [ ] `GET /v1/source-nodes/:id/download` (a signed redirect) and `POST /v1/projects/:id/fs/zip`
  (`{ nodeIds }` → a streamed ZIP built from the `BlobStore`, never buffered whole, and audited as
  `files.downloaded`). Privacy-held files are left out, with a `_held_files.txt` listing what was left
  out and why.
- [ ] `GET /v1/source-nodes/:id/activity`: `fs_ops` for the node and its ancestors' moves.
- [ ] Children responses gain `starred`, `locked`, `version`, `totalBytes` and `trashed`, and the node
  detail gains `path` (computed) and `originalPath`. `originalPath` is **left out of agent context and
  exports**, because it may still hold the identifier someone renamed away (Phase 7).
- [ ] Regenerate the OpenAPI spec and `packages/api-client`, and update the `packages/contracts` types.

**Exit:** `uv run pytest`:
- 10k-file folder moves touch O(depth) rows;
- cycles are refused;
- case-insensitive conflicts return 409 with the conflicting names;
- undo is refused after someone else's change;
- trash restores to the original folder, or the root when it's gone;
- purge keeps bytes a dataset uses;
- dataset contents don't change when files move (D7);
- annotations stay on their items after rename and move (`Asset.path` unchanged);
- replace bumps the version and a dataset stays on its pinned version;
- the agent token can't call `fs/ops` (Phase 8 goes through approvals).

---

## Phase 2. Create, rename, select

- [ ] `packages/ui/src/ui/file-tree.tsx`:
  - allow `editable`, `onRename`, `onCreate` and multi-selection (arborist already supports these;
    kiwifs passes `onRename` to `<Tree>`);
  - expose `edit(id)` on the handle;
  - add a `RenameInput` (select-without-extension, validation slot, Enter / Esc / blur), from kiwifs
    `KiwiTree.tsx` ~1770;
  - add the hover `+` and `⋯` row actions as props (`rowActions`).
- [ ] New folder (⇧⌘N, the tree header, the New menu, a row `+`, the context menu) creates "Untitled
  folder" (then "Untitled folder 2"…) optimistically, opens it in rename mode, and commits on Enter. Esc
  on an untouched new folder removes it.
- [ ] Rename from the tree, the list's Name cell (`listing.tsx` gets an editing row state), the inspector
  title and F2. Extension changes confirm first (D10).
- [ ] Multi-select in the tree and listing:
  - ⇧ and ⌘ click, ⇧↑↓, ⌘A, Esc;
  - in the grid, **rubber-band selection** (pointer drag on empty space) with autoscroll;
  - the selection is shared between tree and listing for the listed folder.
- [ ] The selection bar (§2) replaces the toolbar when anything is selected; the inspector shows a summary
  for several items ("12 items · 1.4 GB · 3 kinds").
- [ ] A Radix context menu on every row and on breadcrumb segments, replacing today's positioned
  `DropdownMenu` hack in `SourcesPage.tsx`.
- [ ] Context items "Upload files here" and "Upload folder here" (kiwifs "Upload files to …").

**Exit:** `tests/e2e/files_edit_test.py`, keyboard only:
- make a folder, name it, rename a file (only the stem selected), and get refused on a duplicate name with
  the message shown;
- select three files with ⇧↓, and the selection bar says "3 selected".

---

## Phase 3. Move, copy, paste

- [ ] Arborist drag and drop on (`disableDrag` / `disableDrop` become functions: locked samples and
  placeholders can't be dragged, and only folders accept drops). `onMove` follows kiwifs `handleMove`:
  refuse a folder into itself, apply optimistically, call `fs/ops`, and roll back with a toast on failure.
- [ ] Drag from the listing (list and grid) to tree folders, listing folders and breadcrumb segments, with
  one shared drag controller (`apps/web/src/studio/lib/files/dnd.ts`). Includes spring-loading at 700ms,
  autoscroll, the "3 items" ghost, and ⌥ to copy (§2).
- [ ] **Move to…** dialog (`components/files/move-dialog.tsx`):
  - a folder picker with a breadcrumb and a flat folder list (Patch `add-secret-dialog.tsx`), recent
    destinations at the top, and "New folder" inside the dialog;
  - **Move here** is disabled with a reason for invalid targets;
  - it's also used for "Copy to…" from sample data.
- [ ] Clipboard (`lib/files/clipboard.ts`, kiwifs `treeClipboard` but node ids and per-tab):
  - ⌘X marks items as cut (50% opacity), ⌘C copies, and ⌘V pastes into the focused folder or the listed
    one;
  - it survives navigation within the project and clears on project change;
  - copy is free (D5).
- [ ] Duplicate (⌘D): "name (copy).ext" next to the original, then rename mode.
- [ ] The conflict dialog (§2) for move, copy and paste, driven by the 409 `conflicts` list; resolutions
  go back in one retry.
- [ ] Moving across a locked folder, or out of one, offers copy instead ("Sample data can't be moved.
  **Copy instead**").

**Exit:** `tests/e2e/files_move_test.py`:
- drag three files from the grid onto a tree folder, and the toast's Undo restores them;
- ⌥-drag copies;
- moving a folder into its own child is refused with the reason;
- paste with a name conflict, "Keep both" for all, gives `(2)` names;
- a dataset built from the moved files still lists the same items, and their annotations are intact;
- the Move to… dialog works with keyboard only.

---

## Phase 4. Trash and undo

- [ ] Move to Trash (⌘⌫, the menu, the selection bar). No confirmation, because it's reversible; a toast
  with Undo instead. Items a dataset uses get a softer warning in the toast ("*LV segmentation* still uses
  2 of these").
- [ ] A Trash view (`/projects/:p/files/trash`, in the tree footer with a count):
  - columns Name, Original location, Deleted by, Deleted;
  - Restore, Delete forever and **Empty Trash** (with a confirmation that names any bytes that will be
    kept, D8);
  - items in Trash can't be opened in the Studio; Quick Look still works.
- [ ] Undo and redo (⌘Z / ⇧⌘Z) through `fs/undo` and `fs/redo`, with an "Undo *move of 3 items*" label in
  the Edit hint of the context menu. A refused undo explains itself (D9). The client keeps only the batch
  ids of this tab's operations, for labels; the truth is on the server.
- [ ] "Remove upload…" from todo6 becomes "Move import to Trash", reachable from the Imports list.

**Exit:** trash a folder of 500 files, reload, restore it, and it's back with its counts. Undo works after a
reload. An undo after a colleague renamed one of the files is refused with the name. Empty Trash keeps
bytes a version uses.

---

## Phase 5. Finding your way: sort, filter, star, recent, breadcrumbs

- [ ] Tree header (§2) with:
  - **Collapse all** (`api.closeAll()`) and ⌥-click to expand recursively (kiwifs `openFolderRecursive`);
    expansion is capped at 2,000 rows, with "Expand stopped at 2,000. Open folders one by one";
  - a **Sort** menu: Name (default) · Kind · Size · Date added, with folders first always, remembered per
    person (localStorage, like kiwifs `kiwifs-tree-sort`), and applied server-side in `children` so
    paging stays correct.
- [ ] **Tree filter** (kiwifs's sidebar filter): it narrows the *loaded* tree by name as you type (arborist
  `searchTerm`, with kiwifs `treeSearchMatch` covering compact chains). The project-wide search box in the
  toolbar stays separate, for files not loaded yet. The two placeholders say which is which ("Filter
  folders shown" / "Search all files").
- [ ] **Starred** and **Recent** sections in the tree footer (kiwifs `AppSidebar` sections). Collapsible,
  remembered, at most 8 rows each; clicking reveals the item in the tree.
- [ ] Breadcrumb upgrades (Finder path bar / Drive):
  - every segment is a **drop target**;
  - the chevron between segments opens a menu of that folder's subfolders;
  - long paths collapse the middle into `…` with a menu;
  - the last segment's `⋯` gets the full folder context menu.
- [ ] **Auto-reveal**: opening a file from anywhere (Overview, Explore, the assistant, Studio "Show in
  Files") reveals it in the tree, as todo6 does, now also when the tree is filtered (the filter clears with
  a note).
- [ ] Folder sizes: the listing's Size column shows `totalBytes` for folders, and the inspector shows
  "1,204 files · 2.3 GB".

**Exit:** `apps/web/e2e/files_nav_test.py` (seed mode, read-only features): sort by size keeps folders first
across pages, the tree filter narrows and clears, a starred folder appears in the footer and survives a
reload, and dropping on a breadcrumb segment is wired up (the API part is in `tests/e2e`).

---

## Phase 6. Versions, download and activity per file

- [ ] Inspector **Versions** section (files with more than one version): version number, who, when, size,
  "Current" chip, **Restore** and **Download**. "Replace with new version…" opens a file picker, then an
  upload session in replace mode (D6).
- [ ] Datasets show "Newer version available for 3 files". Updating opens a preview listing the affected
  items and how many annotations stay on the old version, then **Update** (a journaled dataset change, in
  Activity).
- [ ] Download: a single file is a signed URL; a folder or a selection is a streamed ZIP (Phase 1.3) with a
  progress toast. Downloads are audited, and held files are left out with an explanation inside the ZIP
  and in the toast.
- [ ] Inspector **Activity** section: "Renamed from *Smith_J_MRI* by Lam · 2 h ago" (old names shown only to
  members, never sent to the assistant), moves, versions, restores. The project Activity page groups the
  same events by batch ("Lam moved 120 files to *MRI/patient_002*").
- [ ] Inspector **Provenance** gains "Uploaded as *original_path*" behind a "Show original name" button
  (Phase 7 explains why it's hidden).

**Exit:** replacing a file shows two versions; restoring version 1 brings back its thumbnail and facts; a
dataset pinned to v1 shows the update banner; a ZIP of a folder with one held file contains the others plus
the note.

---

## Phase 7. Privacy and the namespace

- [ ] Renaming or moving a node re-runs the **path-name privacy check** (the worker's `deid.py` patterns,
  run in-process for names, since it's cheap) on the new path. A flag raised only by the name clears
  automatically when the new name is clean, with an audit entry `privacy.cleared` and reason "renamed".
  The flag's "next step" in the inspector becomes **Rename to remove it**.
- [ ] `originalPath` and old names in `fs_ops` are sensitive:
  - left out of agent context, exports, ZIP file names and URLs;
  - shown only to project members, behind "Show original name";
  - the e2e test asserts the agent snapshot never contains them.
- [ ] New folder names are checked the same way as you type ("This looks like a person's name. Use a
  study code instead?"). It warns and never blocks.

**Exit:** a file uploaded as `Smith_John_MRI.dcm` is held; renaming it to `case_014.dcm` clears the hold
with an audit entry; the assistant's context for that node shows only `case_014.dcm`.

---

## Phase 8. The assistant can organize (with approval)

- [ ] Read tools: `list_folder` (names, kinds, counts; never contents or original names) and
  `find_files` (name or kind search).
- [ ] `propose_reorganization` produces a plan: a list of `mkdir`, `move` and `rename` ops with a one-line
  reason each. For example, "Group by patient: 47 folders → *patient_001…047*". It renders as an approval
  card with a **before / after tree diff**: moved rows dashed, new folders marked, counts per folder.
  - **Apply** sends one `fs/ops` batch as the *user*, after approval: the agent token can't write the
    namespace (Phase 1 exit). One ⌘Z undoes the whole plan.
  - **Edit** opens the plan in Files with every op as a checkbox.
- [ ] Prompt examples in the empty assistant state on Files: "Group these scans by patient", "Rename files
  to remove dates", "Put all spreadsheets in one folder".

**Exit:** `tests/e2e/agent_test.py` gains a scripted run: the agent proposes grouping six files into two
folders; the card shows the diff; Apply makes one batch; Undo restores it; the agent's direct `fs/ops`
call gets a 403.

---

## Phase 9. Verification and docs

- [ ] All `AGENTS.md` checks, `uv run pytest`, `go test ./...`, and both e2e suites twice in a row.
- [ ] Performance:
  - moving a folder of 100k files commits in under 200ms (D4);
  - renaming shows in other tabs within 1s (SSE);
  - drag over a 5,000-row virtualized listing stays at 60fps;
  - a ZIP of 2 GB streams in constant memory.
- [ ] Accessibility:
  - every drag has a keyboard path (Cut/Paste, Move to…);
  - rename fields are labelled;
  - live-region announcements for every operation;
  - context menus fully keyboard operable (Shift+F10 / the Menu key opens them).
- [ ] Usability: rerun todo6's sessions with three new tasks:
  1. Put patient 2's scans in their own folder.
  2. You renamed the wrong folder; fix it.
  3. Get rid of the duplicate spreadsheet, then change your mind.
- [ ] Docs:
  - `docs/ux.md` principle 3 becomes "Bytes are immutable; names and folders are yours, and every change
    can be undone", and §6 Sources becomes "Files";
  - the glossary gets Files (the project's drive) vs Source (an import's provenance), and Trash;
  - `docs/ui.md` gets the keyboard table;
  - `todo6.md` design implication 2 gets a note pointing here.
- [ ] Move to `BACKLOG.md`:
  - shared links to a file or folder;
  - a column view (Finder);
  - drag out to the desktop (Chrome `DownloadURL`);
  - folder colors;
  - file comments;
  - connectors that sync a remote folder.

---

## Order and size

| Phase | Depends on | Size | Risk |
|---|---|---|---|
| 1 Backend namespace | D1–D10 | 3–4 days | high: re-parenting roots, dropping stored paths, freezing dataset definitions; every `rel_path` reader changes |
| 2 Create, rename, select | 1 | 2 days | low |
| 3 Move, copy, paste | 1, 2 | 3 days | medium: one drag controller across tree, list, grid and breadcrumb; optimistic rollback |
| 4 Trash and undo | 1 | 2 days | medium: undo refusal rules; purge keeping referenced bytes |
| 5 Sort, filter, star, recent, breadcrumbs | 2 | 2 days | low |
| 6 Versions, download, activity | 1, 4 | 2–3 days | medium: dataset version pinning; streaming ZIP |
| 7 Privacy and names | 1, 2 | 1 day | low |
| 8 Assistant organizes | 1, 3 | 1–2 days | medium: the diff card |
| 9 Verification and docs | all | 1–2 days | — |

Phases 2, 4 and 7 can run in parallel worktrees once Phase 1 lands; 5 can start on the seed stand-in
straight away (its read-only parts).

## Reference files to copy from (kiwifs main, `~/kiwifs/ui/src`)

| What | Where | Take | Change |
|---|---|---|---|
| Rename, move and delete handlers | `components/KiwiTree.tsx` `handleRename`, `handleMove`, `handleDelete` (~440–545) | the folder-into-itself guard, optimistic apply plus rollback, the error alert | node ids instead of paths; one `fs/ops` batch instead of per-file calls; Trash instead of snapshots |
| Optimistic move | `lib/treeReorder.ts` `applyOptimisticTreeMove` | the tree-patching logic | patch React Query child pages, not a whole-tree state |
| Refresh guard | `lib/treeRefresh.ts` `shouldApplyTreeLoad` | ignore loads that started before the last local change | keyed per folder query |
| Clipboard | `lib/treeClipboard.ts`, `KiwiTree.tsx` ~730 | ⌘C / ⌘X / ⌘V semantics | node ids; free copies (D5); commands, not a raw keydown handler |
| Undo stack | `stores/fileOpsStore.ts` | the user-facing undo of the last op | server journal (D9); the client keeps labels only |
| Rename input | `KiwiTree.tsx` `RenameInput` (~1770) | Enter / Esc handling | select the stem, live validation, extension confirmation |
| Dialogs | `components/tree/KiwiTreeDialogs.tsx`, `stores/kiwiTreeUiStore.ts` | one zustand store for transient dialog and drag state | our AlertDialog and the conflict dialog |
| Row chrome | `components/tree/TreeRow.tsx` | drop highlight and reveal flash states | Gravity tokens (already done in todo6) |
| Sidebar sections | `components/AppSidebar.tsx` (Starred, Pinned, Recent, the tree header buttons) | collapsible sections with remembered state; Collapse all; Sort toggle | footer placement under the tree |
| Recursive expand | `lib/treeTransform.ts` `openFolderRecursive` | ⌥-click | capped at 2,000 rows (lazy children) |
| Folder picker | `~/patch/apps/web/src/components/interface/secret-managers/add-secret-dialog.tsx` | breadcrumb plus flat folder list | the Move to… dialog |
