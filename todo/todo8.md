# Studio: calmer, one home per job

**Goal.** The Studio can do a lot, and it shows all of it at once. A radiologist who opens a chest
X-ray to say "normal or pneumonia" sees a header with up to 17 controls, 16 drawing tools, three
panel tabs (two of which list the same items), a settings dialog full of module ids, and a
shortcuts sheet with about 40 rows. This plan keeps every capability and changes **where** each
one lives, so that at any moment the screen shows what this task needs and nothing that belongs to
another job.

Nothing is removed for power users: every tool, key and setting stays reachable. What changes is
the default surface.

**Audit date:** 2026-10-30, against `main` 1dc77c1 (todo6 merged; "Sources" is labelled "Data" in
the UI). todo7 (Files as a real file system) is in progress in parallel; section 7 lists where the
two touch.

## Status (2026-10-30)

Phases 1–5 are implemented and merged into `todo8-studio`; Phase 6 (verification and docs) is on
`todo8-verify`. All ten decisions are in; what differs from the text below:

- [x] Phase 1: header in three zones (`WorkStateChip`, `TaskSwitcher`, ⋯ menu), Request review, D10
  header guard (`studio_layout_test.py`: 6 controls at 1440px).
- [x] Phase 2: Items | Labels, "On this image", overlay opacity in the viewport bar, `review` panel
  re-titled "All annotations" and dropped from every preset.
- [x] Phase 3: Folders and Queue views following Data, `StudioItem.folder` from the kernel,
  disambiguated names, hover card, Show in Data and Data's "In tasks", status-bar path, `N`, blind
  by default through `env.spec.studio` (`studioDefaults` in `lib/task-setup.ts`).
- [x] Phase 4: Rule 1 (`env.unusableTools` with reasons), folded tool groups (`stores/tool-prefs.ts`),
  `DecisionBar`, the 2D seed's duplicate `Labels` group dropped in `tools/fetch-seeds.py`.
- [x] Phase 5: shortcuts sheet (Essentials, keycaps by group, While drawing, search, footer, `?
  Shortcuts` hint) and the Task setup page; `ModuleConfigDialog` is gone from the Studio.
- [x] Phase 6: all `apps/web/e2e` green on the merged branch (see the report on `todo8-verify`),
  screenshots before/after in `docs/screenshots/todo8/`, `docs/ux.md` §2/§8/§10 and
  `docs/modules.md` (Rule 1, folding, `studio`), agent prompts say Task setup.

Deviations and leftovers:

- **D4 View menu.** The image2d viewport bar has a View ▾ menu with the Zoom tool (`Z`), reset,
  flip and rotate. Window/level presets, invert and overlay opacity stay inline beside it: they're
  used often, and `image2d_test.py` / `volume3d_test.py` / `shell_test.py` drive them by role and
  test id. The volume renderer's `plugins/volume/ui/renderer/ViewBar.tsx` has no View menu yet (Zoom stays on `Z` there).
- **§7 shared tree header.** Not extracted: Files has `components/files/tree-header.tsx`, the Items
  panel its own header (view toggle, filter icon). Worth merging into one `packages/ui` component.
- **D8** the ECG renderer still prints its own "Source Dx" line for event-marking tasks (a renderer
  feature, not the status bar); D8 only hides source labels for classification.
- §8's "Not now" items are in `todo/BACKLOG.md` (Studio, todo8).
- `pnpm typecheck` fails only in `@studio/api` (pyright, 11 errors in todo7's `kernel/fs.py`,
  `kernel/overview.py`, `routes/worker.py`); none is in todo8 code.

---

## 0. What the Studio shows today

Measured from the code at 1440px, with the `image-2d` preset (the 2D X-ray sample).

### Header (`components/studio/StudioTopBar.tsx`)

```text
[≡] [◎] [Personal ▾] / [Chest X-ray · Pneumonia ▾] / Chest X-ray · Pneumonia  [Draft] 2D image ✓ Saved
                                          … [Review dataset] [Export dataset] | [AI] [⚙] [🔧] [⌨] [☀ ◐ ☾]
```

With versioning on, add `[⎇ anh/work ▾]`, `[Submit for review]` and, after a conflict, the stale
banner. That is **15–17 controls in one 48px bar**, and:

| Control | Problem |
|---|---|
| Brand mark | The project rail beside it already has the way home. |
| `Personal ▾` | A workspace switcher with one workspace in it. Pure noise in the Studio. |
| Project title, then task title | When the task has the project's name (every sample), the same text appears twice. |
| `Draft` badge, `2D image` | `Draft` is the versioning state without versioning; `2D image` is the preset's title, a developer word. |
| `Review dataset` | Goes to the project's Review page, which the rail already links to. |
| `Export dataset` | The primary button, though exporting is the last step, and rare. |
| ⚙ Environment settings | Owner-level task configuration, offered to everyone mid-annotation (see below). |
| 🔧 Plugins | Workspace administration. |
| ⌨ Shortcuts | Also on `?`. |
| Theme switch | A personal preference that's set once. |
| `anh/work ▾` (versioning) | A git branch name in monospace. ux.md §10 says users see "Save draft", "Request review", never git words. |

### Toolbar (`components/studio/CanvasToolbar.tsx`)

The `image-2d` preset declares 16 tools: Select, Pan, Zoom, Window/level, Box, Ellipse, Polygon,
Freehand, Keypoint, Length, Angle, Cobb angle, Bidirectional, Probe, Arrow, Brush, Eraser and
Fill. Past 7 tools the bar drops to icons only (`COMPACT_AFTER`), so the result is 16 bare icons, 3
separators, undo and redo, the View panel and "Drawing [label]".

**The 2D X-ray sample is a *classification* task** (`seed-data/manifest.json`: `"task":
"classification"`, a `Choices` group). The person's job is to press 1 or 2. Every drawing tool is
noise for that job, and the seed also has a second `Labels` group that repeats the same two classes
as region labels.

### Left panel: Files | Labels | Review (`core/panels/*.tsx`)

- **Files** lists the task's items grouped by `item.group`. For `image2d`, `groupItems` sets
  `group` to the **source label**, so the list reads `NORMAL 8/10`, `PNEUMONIA 7/10`. The status
  bar also prints `Source label: pneumonia`. **For a classification task, that is the answer**,
  shown to the person who is supposed to decide it. It anchors them (bias), and it makes the
  resulting labels worthless as an independent read.
- **Review** has two filters. "Unlabeled" is the Files list with a "not annotated" filter.
  "Annotations" lists every annotation on every item as bordered cards, newest first. So Files and
  Review overlap, as you noticed, and the word "Review" also names a project section, the header's
  `Review dataset` button and the versioning `Submit for review` button: **four meanings**.
- **Labels** stacks up to five things: the image-level class picker, region classes (pick, hide,
  lock, count, key), overlay opacity (a view setting), the selection inspector, and the
  multi-selection panel.
- Each tab has its own always-visible filter field or chips.

### Environment settings (`components/studio/ModuleConfigForm.tsx`)

A dialog that renders a generated (RJSF) form for **every** contribution with a `configSchema`:
viewers, the data kind, every panel, every exporter. Each section has a title taken from the
contribution's *description*, the module id in monospace (`inkling.image2d.renderers.cornerstone-stack`),
an "Apply" button of its own, and a paragraph explaining that edits are validated and can be
undone. It is the right engine (the same JSON-Patch path the assistant uses) with the wrong
audience and the wrong place.

### Keyboard shortcuts (`components/studio/ShortcutsDialog.tsx`)

Every tool hotkey in the environment, then every command grouped by Edit, Navigate, Labels,
Drawing, View, Playback, Data and Help. That is about 40 rows with equal weight, including
contextual keys that only work mid-gesture.

### Rail and status bar

- **Rail** (48px): back to all projects, then Overview, Data, Studio, Review, Activity and Settings.
- **Status bar**: previous / next, `3 / 20`, the item name, the source label, and the viewer
  status.

---

## 1. Answers to the questions

**Do we need all these settings and shortcuts?** We need the *capabilities*, not the *surfaces*:

- **Tool hotkeys stay.** Radiologists and pathologists live on them, and an unused binding costs
  nothing visually. What goes is showing 16 tools and 40 shortcut rows with equal weight. Tools a
  task can't use disappear. Related tools fold into one button. The sheet leads with eight
  essentials and is searchable.
- **Environment settings become Task setup.** It's owner work, done before annotating, in plain
  words, with module ids behind "Technical details". It leaves the Studio header. Per-person view
  preferences (overlay opacity, W/L presets, theme) were never task setup and stay where they act.

**Files and Review: aren't they the same?** Mostly, yes. Review's "Unlabeled" filter *is* Files
with a status filter. Its "Annotations" list is a project-wide feed that belongs on the Review
*page*. The left panel becomes two tabs:

- **Items**, named by the data kind's noun: Images, Studies, Slides, Recordings or Videos. It
  answers "what do I work on next?", with status filters.
- **Labels**: the classes, plus "On this image" (the current item's annotations, like Figma's
  layers) and the selection.

The Studio's Review tab goes. "Review" then means exactly one thing: the project section.

**Should the Items list follow the file system?** Yes, by default. The same folders, names and
icons as Data, so the person recognises their material. It stays task-scoped (studies, not 300
slices), with a flat **Queue** view for working through the list in order. "Which one is which" is
answered by:

- disambiguating duplicate names;
- a hover card with the full path;
- a clickable path in the status bar;
- "Show in Data" both ways.

See D3.

**The header is cluttered.** It goes from 15–17 controls to 6–7 in three zones: where am I, what
state is my work in, and the one next step. Everything else moves to the place it belongs: the rail,
Settings, a ⋯ menu, or the user menu.

---

## 2. Principles (used to settle every case below)

1. **One home per job.** Each control lives in exactly one place. If the rail links to Review, the
   header doesn't.
2. **The task decides the surface.** The task kind and its label groups decide which tools, panels
   and columns appear. A classification task looks like a classification task.
3. **Teach in place, reference on demand.** Tooltips and menus show keys where the action is; the
   sheet is a searchable reference, not a wall.
4. **Annotators by default, owners one step away.** Configuration is behind "Task setup", with the
   assistant as the plain-language way to change it.
5. **Calm status, loud problems.** "Saved" is a quiet tick; "Not saved · Retry" and "Someone else
   saved" stay prominent.
6. **One word, one meaning** (AGENTS.md's glossary rule, applied to UI copy).

---

## 3. Decisions (decide before Phase 1)

- [x] **D1. Header: three zones, at most 7 controls at 1440px.**

  ```text
  [▤] Chest X-ray · Pneumonia ▸ Pneumonia triage ▾   ·  Draft · Saved ✓ ▾        [Request review]  [✦]  [⋯]
   │        project (link)      task switcher           work state (popover)        one primary     AI   more
  ```

  - **Left, where am I.** The panel toggle; the project title as a link to its Overview, not a
    switcher (switching projects mid-annotation is rare; the rail's back arrow and ⌘K cover it);
    then a **task switcher** (`▾` lists this project's tasks with their progress, plus "Task
    setup…"). When the task title equals the project title, show it once. The brand mark and the
    workspace switcher leave the Studio header (the rail stays the way out).
  - **Middle, the state of my work.** One chip merges the save indicator with the versioning state.
    - Versioning off, it reads `Saved ✓`, `Saving…`, or `Not saved · Retry`.
    - Versioning on, it reads `Your draft · Saved ✓`, or `Published (read-only)` on a protected
      branch.
    - Clicking it opens a popover: history ("Compare versions"), switch to the published copy or
      back to your draft, and the branch name in small print for those who want it.
    - The stale-head notice stays a separate, loud chip.
  - **Right, the one next step.** One primary button that follows the stage: **Request review** when
    versioning is on and the draft has changes; otherwise **Export** (outline, not primary; it's
    rare). Then the AI toggle, and **⋯**, which holds:
    - Export… (when Request review holds the primary slot);
    - Task setup…;
    - Keyboard shortcuts `?`;
    - Plugins;
    - Theme ▸;
    - Open project Review.
  - Testids `branch-switcher`, `submit-review`, `stale-save` and `toggle-left-panel` stay on the
    new elements. `branch-switcher` moves to the popover's switch control.

- [x] **D2. Left panel: Items | Labels. The Studio Review tab goes.**
  - **Items** (`inkling.core.panels.files`, id unchanged). The tab title is the data kind's plural
    `itemNoun`: Images, Studies, Slides. A count follows only when it's under 1,000.
  - **Labels** (`inkling.core.panels.labels`) gets three sections, top to bottom:
    - **Classes**: today's list. The ⋯ on a row holds hide, lock and change color; the key and count
      stay visible.
    - **On this image**: the current item's annotations as compact rows (color dot, label, geometry
      summary, provenance badge only if not human), Figma-style. Clicking selects and pans to it,
      and Shift/⌘-click multi-selects, so today's Review-list behaviors carry over. The rows have no
      card borders.
    - **Selection**: the inspector, or the multi-selection panel, pinned to the bottom of the panel.
  - **Overlay opacity** moves to the viewport bar's View menu (it's a view setting, next to W/L
    presets and invert).
  - **The project-wide annotation feed** moves to the Review page's per-task annotation section,
    which exists already.
  - `inkling.core.panels.review` stays **registered** (stored environments reference it, and the
    resolver rejects unknown ids). It is re-titled "All annotations" and dropped from every preset.
    Owners can add it back in Task setup. `pnpm emit:schemas` regenerates the catalogue.
  - **Recommended over the alternative**: Items on the left and a Figma-style inspector (Labels, On
    this image, Selection) on the right, sharing the right column with the assistant. It's closer
    to CVAT, V7 and Figma, but it fights ux.md §8's three-column spec, and the assistant would then
    cover the inspector. Revisit if people keep the assistant closed most of the time.

- [x] **D3. Items follow the file system, with a Queue view.**
  - **Folders view (default when the task's items span more than one folder).**
    - The same tree component as Data (`packages/ui/src/ui/file-tree.tsx`), the same icons, the same
      compaction of single-child chains and numbered runs.
    - The root is the task's **common folder**, stripped (so `cardiac/2024/mri/` isn't three levels
      of nothing).
    - Leaves are **items** (a study, series or slide), never raw slices. A bundle shows its count
      (`182 slices`).
    - Folder rows show progress (`8/10`). Each item row shows a state icon (todo, AI, imported,
      done), the name, and the kind icon **only when the task mixes kinds**.
  - **Queue view.** A flat list in work order, with status chips `All · To do · Needs review
    (AI + imported) · Done` and counts. "Next to do" (`N`) jumps to the next item in the queue,
    whichever view is showing.
  - The view (Folders or Queue) is remembered per task per person (localStorage, like today's
    Sources prefs).
  - **Never group by source label by default** (D8). `StudioItem.group` stays as the fallback
    heading when an item has no folder (the dev seed server without the API).
  - **Which one is which:**
    1. **Disambiguate duplicates** VS Code-style. When two items share a name, show the shortest
       distinguishing parent path, dimmed: `IM-0001.dcm  patient_07/series_2`.
    2. **Hover card** (400ms): full Data path, kind, size or dimensions, state, who annotated it and
       when, and a thumbnail when the renderer offers one.
    3. **Status bar path**: `mri ▸ patient_07 ▸ series_2 ▸ IM-0001`. Each segment filters the tree to
       that folder.
    4. **"Show in Data"** in the row's context menu opens Data with the file revealed. The reverse
       way, Data's inspector shows "In tasks: Pneumonia triage (done)" with a link that opens the
       Studio on that item.
    5. **Same identity everywhere**: Studio and Data use the same display name (`node.name`, not the
       storage key) and the same icon map.
  - **Contract.** `StudioItem` gets `folder?: string[]` (display only, the item's Data folder
    segments). The kernel's task document (`kernel/projects.py`, ~575–613) fills it from the first
    asset's node ancestors. Item ids stay `Asset.path`, so annotations are untouched. After todo7,
    a rename or move updates `folder` live through `fs.changed`.
  - The filter field becomes an icon in the panel header that expands (or ⌘F inside the panel), as
    in todo7's tree header. It isn't always visible.

- [x] **D4. Tools: the task decides which tools exist; related tools fold into one button.**
  - **Rule 1: only usable tools.** A tool that `creates` a geometry no label group in the
    environment accepts is not shown. Navigation and measurement tools (`creates` unset, or the
    `measure` group) are exempt. The resolver computes it as `env.tools` filtered, with the dropped
    ones in `env.unusableTools` so Task setup can explain why. The catalogue still lists everything.
  - **Rule 2: fold groups.** In each `ToolGroup` (`shape`, `measure`, `mask`, `time`) with 3 or
    more tools, one **split button** shows the last-used tool. Its chevron, or a long press, opens
    the group with names and keys (Figma and Photoshop tool groups). Groups with 1 or 2 tools stay
    expanded. Navigation keeps Select, Pan and Window/level (when the renderer has it) visible, and
    Zoom joins the View menu (scroll already zooms).
  - **Keys don't change.** Pressing `J` selects Cobb angle and makes it the Measure button's face.
    The "last used per group" memory lives in a small prefs store (localStorage), not in
    `useStudio`, whose fields are a test contract.
  - **Result for `image-2d`**: `Select · Pan · W/L | Box▾ | Length▾ | Brush▾ | ↶ ↷`, so 8 buttons
    with labels where they fit, instead of 18 bare icons.
  - **Plugin toolbar actions** (`data-toolbar-action`) stay visible as they are; the plugin e2e
    tests rely on them.
  - **Seed fix**: the 2D X-ray classification sample drops its duplicate `Labels` group (the region
    copies of normal/pneumonia), so Rule 1 leaves Select, Pan, W/L and the View menu.
    *Alternative*: keep the group and accept that the shape tools stay. Recommended: drop it; a box
    labelled "pneumonia" isn't what that task asks for.

- [x] **D5. Classification gets a decision bar, not a panel hunt.** When the environment has a
  `Choices` group, a bar under the canvas (above the status bar) shows the classes as keyed buttons:
  `[1 Normal] [2 Pneumonia]` and then `Skip`. Picking one records the class, and with **Advance after
  choosing** (on by default for single-choice groups, switchable in the bar's ⋯) it moves to the
  next to-do item. Multi-choice groups toggle and never advance. The Labels panel keeps its picker
  for people who keep the bar hidden. This is the main action of the task, so it sits where the eyes
  are.

- [x] **D6. Shortcuts: essentials first, searchable, mirrors the toolbar.**
  - The top section, **Essentials**, has at most 8 rows from a fixed list in core:
    - Undo and redo;
    - Delete;
    - Previous / next item;
    - Next to do (`N`);
    - Pick label `1–9`;
    - Hold Space to pan;
    - `?`.
    No contract change; the list lives in `core/manifest.ts` next to the commands.
  - Below it, **Tools** appear as a compact keycap grid under the same headings as the toolbar
    groups (Navigate, Shapes, Measure, Paint), showing only this task's tools. **Commands** keep their
    groups.
  - Contextual keys (finish shape, cancel, remove last vertex, Tab through suggestions) collapse
    under a "While drawing" disclosure.
  - A **search field** filters by label or key (typing `b` finds Brush and `[`/`]`).
  - The description line goes. A footer says "Keys don't fire while you type in a field".
  - The sheet opens from `?` and from ⋯ → Keyboard shortcuts. The status bar's right end shows a
    quiet `? Shortcuts` hint until the sheet has been opened once.

- [x] **D7. Environment settings → Task setup, a page and not a dialog.**
  - **Where:** `/projects/:p/tasks/:taskId/setup`, linked from the task switcher, ⋯ → Task setup, and
    the Overview task card. Owners land there after creating a task. Annotators can open it read-only.
  - **Sections, in plain words:**
    - **Labels**: classes, colors, keys, and single or multiple choice. This is a new, real editor;
      today labels can only be changed by the assistant or by JSON.
    - **Tools**: the toolbar's groups with checkboxes. Rule 1's hidden tools are listed greyed, with
      the reason, e.g. "No label accepts boxes".
    - **Viewer**: the renderer's options.
    - **Panels**: add "All annotations", measurements and the rest.
    - **Export formats**: the exporters and their options.
    - **Annotators see**: source labels (D8), file paths.
  - **One Save for the page**, through `patchEnvironment` (same validation, same undo, same
    revision as today). After saving, a toast reads "Task setup changed · Undo". Module ids, JSON
    Pointers and the raw spec are behind **Technical details** (a disclosure, plus "View JSON").
  - **"Describe a change"** opens the assistant with the setup as context ("add a third class,
    Effusion, on key 3").
  - RJSF stays as the engine for viewer, panel and exporter options; Labels and Tools get
    hand-built editors.
  - `ModuleConfigDialog` is removed from the Studio. Its e2e coverage (none found) moves to a new
    `task_setup_test.py`.

- [x] **D8. Blind by default: annotators don't see the source label.**
  - When the environment's `task` is `classification`, `StudioItem.sourceLabel` is hidden in the
    Studio. That means no grouping by it, no status-bar mention, and no hover-card field.
  - Task setup → **Annotators see → "Labels that came with the files"** turns it on (for correction
    work).
  - **Imported labels** (`provenance: imported`, todo6 D8) are a different thing. They are
    proposals to confirm, shown as such, and they stay.
  - For other task kinds the source label is context, not the answer. It's shown in the hover card
    only, never as a group heading.

- [x] **D9. Words.** Each of these replacements is user-facing copy only; code names don't change.

  | Today | After | Why |
  |---|---|---|
  | Review (Studio tab) | gone (D2) | Review is the project section. |
  | Review dataset (header) | gone (rail → Review) | One home per job. |
  | Submit for review | **Request review** | ux.md §10. |
  | Branch `anh/work`, `main`, "protected" | **Your draft**, **Published**, "read-only" | ux.md §10: no git words. |
  | Draft badge without versioning | gone | It has no meaning there. |
  | Environment settings | **Task setup** | "Environment" is a code word (glossary). |
  | `2D image` (preset title) in the header | in the task switcher's subtitle | It's a viewer type, not a status. |
  | Files (Studio tab) | the data kind's plural noun | "Files" is the file system, which the nav calls Data. |

- [x] **D10. A guard against re-cluttering.** An e2e check counts the visible interactive controls in
  the Studio header at 1440px (≤ 7) and the visible toolbar buttons for `image-2d` (≤ 10). A new
  button then has to replace one or go in ⋯. The thresholds sit in the test with a comment pointing
  here.

---

## 4. Visual and spacing rules (the "breathable" part)

Concrete, so they can be reviewed in a screenshot:

- **Panel header pattern** (shared with todo7's tree header): a 36px row with the panel title on the
  left and 1–3 icon actions on the right (filter, view toggle, ⋯). Tabs are a 2-segment control at
  the top, not a full-width 3-column grid.
- **Rows are 28px** in Items (the same as the Data tree) and **24px** in "On this image". There are
  no card borders inside panels; hover is the only row background.
- **Sections in a panel** are separated by 16px and a small heading in sentence case (`Classes`,
  `On this image`), not uppercase tracking. Uppercase stays only for tree group headings, as in Data.
- **Hover-only affordances**: hide, lock and ⋯ on class rows; Remove on annotation rows. They also
  show on keyboard focus (as today's `focus-visible:opacity-100`).
- **Empty states say the next action** in one line: "No annotations on this image. Pick a label and
  draw, or press 1–2.", or "All 20 images done. Request review?".
- **Header height stays 48px**; the gap between zones grows (24px), with no separator bars.
  `bg-header` stays.
- **The toolbar** keeps 40px. Separators sit only between tool groups, and labels show beside icons
  when there's room (container query, as today, but with 8 buttons there's room from about 900px).
- **Icons** come only from `@studio/ui/icons`. Phases 3–5 add `QueueIcon` (`ListUl`),
  `FoldersIcon` (`FolderTree`) and `TaskSetupIcon` (`Sliders`); the split button reuses
  `ChevronDownIcon`. All three glyphs were checked against `@gravity-ui/icons` 2.23.0. Run
  `pnpm check:icons`.

---

## 5. Phases

Each phase is shippable on its own and ends with its checks green.

### Phase 1: words and header (D1, D9)

1. `StudioTopBar.tsx` gets the three zones.
   - Drop `BrandMark`, `WorkspaceSwitcher` and the theme switch from the Studio header.
   - The project becomes a link; a `TaskSwitcher` (new, in `components/layout/switchers.tsx`) lists
     the project's tasks (`GET /v1/projects/:id/tasks`, already used by Overview) with progress.
   - Collapse the title when it equals the project's.
2. `WorkStateChip` (new, in `core/versioning/`) merges `SaveIndicator` and `BranchSwitcher`. Rename
   Submit for review to **Request review**, keeping `data-testid="submit-review"`. Branches show as
   "Your draft" or "Published".
3. A ⋯ menu with Export…, Task setup… (opens today's dialog until Phase 5), Keyboard shortcuts,
   Plugins (a link, so `get_by_role("link", name="Plugins")` still works when the menu is open),
   Theme ▸ and Project review.
4. Update `tests/e2e/plugins_test.py`, `apps/web/e2e/plugin_isolation_test.py` (open ⋯ before clicking
   Plugins) and any test that read the header text.
5. **Exit:** `studio_layout_test.py` and `shell_test.py` pass; a screenshot at 1440, 1024 and 768
   shows ≤ 7 header controls; versioning e2e (`branch-switcher`, `submit-review`, `stale-save`)
   passes.

### Phase 2: Items | Labels (D2)

1. `LeftSidebar.tsx`: a 2-segment tab control; the Items tab title from `env.dataKind.itemNoun`
   (pluralised by a small helper in `lib/format.ts`).
2. `labels.tsx`: Classes, then "On this image" (new `OnThisItem` component; selection, pan-to,
   Shift/⌘-click multi-select and Remove carried over from `review.tsx`), then the pinned Selection
   section. Overlay opacity moves to the viewport bar's View menu: add it to
   `plugins/image2d/ui/panels/viewControls.tsx` and the volume `ViewBar.tsx`, reading the same store
   field `overlayOpacity`.
3. `core/manifest.ts`: re-title `review` "All annotations", update descriptions, and drop it from
   every preset in `registry/presets/*.json`. Run `pnpm emit:schemas`.
4. Update the tests that click the Review tab:
   - `apps/web/e2e/shell_test.py` (~84), `pathology_test.py` (~469, 476) and
     `tests/e2e/mixed_import_test.py` (~229): use the Labels tab and its "On this image" list.
   - Keep `data-testid="files-panel"`, `file-row` and `data-state`.
   - Add `data-testid="on-this-item"` with rows `annotation-row`.
5. **Exit:** the moved tests pass. Pan-to-selection (pathology) works from "On this image". The
   Imported badge is visible in "On this image" (mixed import).

### Phase 3: Items follow the file system (D3, D8)

1. Contracts: add `StudioItem.folder?: string[]` (`packages/contracts/src/types/index.ts`). Run
   `pnpm emit:schemas` and `contracts:check`.
2. Kernel: in the task document, fill `folder` from the first asset node's ancestors, relative to the
   task's common folder. Add a test in `apps/api/tests` with nested folders and duplicate names.
3. `files.tsx`:
   - Folders view on `FileTree` (compaction, numbered runs, folder progress);
   - Queue view with status chips and counts;
   - a view toggle in the panel header;
   - the filter behind an icon;
   - duplicate-name suffixes (a pure function `disambiguate(items)` with unit tests);
   - a hover card;
   - a context menu with Show in Data.
4. `nextTodo` command (`N`, group Navigate) in core: the next to-do item in queue order.
5. `CanvasStatusBar.tsx`: the path breadcrumb (each segment filters Items to that folder) replaces the
   source label. Show `? Shortcuts` until the sheet has been opened once.
6. `image2d` `groupItems`: `group` becomes "Images", not the source label. Hiding `sourceLabel` for
   classification (D8) happens in the Studio, so the data stays intact for Review and export.
7. Data side: the inspector's "In tasks" row (`components/sources/inspector.tsx`) with "Open in
   Studio" (route state `{ itemId }`, read by `useResume`'s restore path).
8. **Exit:** a new e2e `studio_items_test.py`:
   - folders render for the 3D sample;
   - Queue → To do → `N` walks only to-do items;
   - duplicate names show suffixes;
   - Show in Data reveals the file;
   - in the 2D sample, no item row or status text contains "Pneumonia" or "Normal" until Task setup
     turns it on.

### Phase 4: Toolbar (D4, D5)

1. Resolver (`extension-host/resolve.ts`): Rule 1 (usable tools), with `env.unusableTools` and
   reasons. Unit tests in `extension-host` for each preset's resulting tool list.
2. `CanvasToolbar.tsx`: a `ToolGroupButton` split button (Radix DropdownMenu with the tool's name and
   key in each row), and a prefs store `stores/tool-prefs.ts` holding the last used tool per group per
   environment. The hotkey path (`useHotkeys` in `DatasetStudioPage.tsx`) also sets it.
3. Seed: drop the duplicate `Labels` group from 2d-xray in `seed-data/manifest.json`'s generator (not
   the gitignored output; find where `pnpm seeds` builds it) and the e2e fixture.
4. `DecisionBar` (new, `components/studio/`) for `Choices` groups: keyed buttons, Skip, and Advance
   after choosing. It uses the existing `setClass` and `pickLabel` paths, so the keys already work.
5. **Exit:** `image2d` and `volume3d` e2e pass with tools chosen by key (`p.tool("r")`). The toolbar
   count guard (D10) passes. In the 2D sample, pressing 2 records Pneumonia and moves to the next
   to-do item.

### Phase 5: Shortcuts sheet and Task setup (D6, D7)

1. `ShortcutsDialog.tsx`: an Essentials list, a tool keycap grid by group, a "While drawing"
   disclosure, search, and a footer line.
2. A Task setup page, `app/routes/TaskSetupPage.tsx`:
   - a Labels editor (classes, colors from the chart tokens, keys with conflict check against tool
     hotkeys, single or multiple);
   - Tools checkboxes, with greyed rows for unusable tools;
   - Viewer, Panels and Export formats (RJSF, reusing `ModuleConfigForm`'s schema extraction);
   - Annotators see;
   - Technical details;
   - one Save through `patchEnvironment`, and an Undo toast.
   Annotators get the page read-only (the role check is already used by Settings).
3. Remove the ⚙ button and `ModuleConfigDialog`'s mount from `DatasetStudioPage.tsx`; ⋯ → Task setup
   links to the page.
4. **Exit:** a new e2e `task_setup_test.py`:
   - add a class and give it a key, then see it in the Studio and the decision bar;
   - untick Brush, then the toolbar has no Paint group;
   - Undo restores both;
   - the module id is visible only after opening Technical details.

### Phase 6: Verification and docs

1. Run all of `apps/web/e2e`, `tests/e2e/{plugins,builder,mixed_import,agent}_test.py`, `pnpm
   typecheck`, `pnpm test`, `check:boundaries`, `check:names`, `check:icons` and `emit:schemas
   --check`.
2. Screenshots before and after at 1440, 1024 and 768, for 2D (classification), 3D (segmentation),
   ECG (events) and WSI (regions), committed under `docs/screenshots/todo8/`.
3. `docs/ux.md` §2 and §8: the Studio's left panel is Items | Labels, the decision bar is added, and
   so is Task setup. §10 gets the Your draft / Published wording. `docs/modules.md`: Rule 1 and the
   group folding, for plugin authors. The `AGENTS.md` glossary needs no change.
4. The assistant's tools: the agent's `ui` tool descriptions that say "Review tab" or "Environment
   settings" get the new names (`apps/agent`; grep for both).

---

## 6. Order and size

| Phase | Size | Depends on | Risk |
|---|---|---|---|
| 1 Header and words | S–M | — | low; test selector updates |
| 2 Items \| Labels | M | — | medium; three e2e files move |
| 3 Items follow folders | M–L | contract change; best after todo7 Phase 1 (computed paths) | medium |
| 4 Toolbar and decision bar | M | resolver change | medium; every preset's tool list |
| 5 Shortcuts and Task setup | L | Phase 4 (Tools section) | the Labels editor is the biggest piece |
| 6 Verification | S | all | — |

Phases 1 and 2 give most of the calm for the least risk; do them first, even while todo7 runs.

---

## 7. Where this touches todo7

- **Naming.** `main` now calls the project's file system **Data** (1dc77c1), while todo7's D11 says
  "Files". Pick one before either plan renames anything. This plan assumes **Data** for the
  section and the data kind's noun (Images, Studies) inside the Studio, so "Files" isn't used
  anywhere in the Studio.
- **Display names and folders.** D3's `StudioItem.folder` and the hover card's path are computed the
  way todo7 D4 computes paths. Before todo7 lands, fill `folder` from `rel_path`; after it, from the
  node's ancestors, refreshed by `fs.changed`.
- **The shared tree header.** todo7's tree header (New folder, Upload, Collapse all, Sort, filter) and
  D3's Items header (view toggle, filter, ⋯) should be one component in `packages/ui` with slots,
  built by whichever lands first.
- **Show in Data.** It needs a stable node id. Today it's the path-hash id and after todo7 D3 an
  opaque one; both work, because the link carries the node id rather than a path.

---

## 8. Not now (BACKLOG candidates)

Moved to `todo/BACKLOG.md` (Studio, todo8); kept here for the record.

- A focus mode (hide the header and both panels, keep the toolbar and decision bar), e.g. on `⌘.`.
- ⌘K command palette over commands, items and tasks (there is none today; ⋯ and `?` cover the gap).
- A first-run tour. Tooltips with keys and the `? Shortcuts` hint should be enough; add a tour only
  if people don't find the decision bar or the Queue.
- Per-person toolbar customisation (pinning a folded tool). Task setup covers the owner's case.
