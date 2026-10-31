# Inkling UX Specification

**Status:** Proposed product UX, v0.2  
**Scope:** Workspace, Projects, Project Overview, Data (Files), Explore, Datasets, Studio, Review, Activity, and persistent AI assistant  
**Primary audience:** Domain experts who are not programmers, initially medical-imaging researchers  
**Reference:** Existing Inkling 2D X-ray annotation canvas and current dataset dashboard. This document replaces the earlier *statistics-heavy Project Overview* concept; it does **not** replace the working annotation editor.

## 1. Product vision

Inkling is an **AI-native data studio for domain experts**. A user can bring messy files and folders, understand their structure, organize them into usable datasets, annotate them with appropriate viewers, review the work, and publish versioned outputs without needing to know programming, schema design, or ML conventions.

**North-star interaction:** A user drops in a folder of heterogeneous medical research materials and says, “Help me build a cardiac imaging dataset.” Inkling identifies file types and candidate relationships, proposes a sensible environment, asks for confirmation where needed, and opens the right editor.

Design influences:
- **GitHub:** persistent projects, traceable changes, collaboration, versioned datasets, review requests—without exposing Git jargon to beginners.
- **Google Drive:** natural file/folder browsing and drag-and-drop uploads.
- **Cursor:** a persistent, context-aware agent capable of proposing and executing typed operations.
- **Figma:** large central canvas and contextual panels/toolbars.

### UX principles

1. **Action first, metrics second.** Make the next useful action obvious.
2. **One product, multiple data shapes.** Adapt views to the data; don't coerce data into a universal image canvas.
3. **Bytes are immutable; names and folders are yours, and every change can be undone.** An upload's bytes never change, and the name and path a file arrived with are kept as provenance. Renaming, moving and deleting (to Trash) are journaled and undoable, and nothing a dataset or a version depends on changes silently.
4. **Explain inferred structure.** Distinguish detected facts, proposed mappings, and confirmed relationships.
5. **Human control.** AI makes proposals; consequential or irreversible actions require approval.
6. **Progressive disclosure.** Clean, straightforward uploads go directly to an editor; messy ones get an Explore flow.
7. **Never confuse identity, expertise, data quality, and publishing rights.** These are distinct signals.
8. **Browser first, privacy by design.** No assumption that clinical PHI may be uploaded or shared by default.

## 2. Information architecture

```text
Workspace (personal or organization)
├── Home
├── Projects
├── Datasets (cross-project index; optional for MVP)
└── Recent
    └── Project (the durable container for a goal)
        ├── Overview       ← redesigned project home
        ├── Data           ← Files (the project's drive), import history
        ├── Explore        ← discovered shapes, schemas, relationships
        ├── Datasets       ← logical collections, tasks, versions
        ├── Studio         ← modality-aware editor for a selected task
        │   └── Task setup ← the task's labels, tools, viewer, panels, exports
        ├── Review         ← annotation issues, import conflicts, mappings
        └── Activity       ← audit-friendly change history

Persistent contextual Inkling AI panel can accompany any Project section.
```

**Terms:**

- **Workspace** is an account or organization and its members.
- **Project** is a durable research goal, e.g. *Cardiac Research*.
- **Files** is the project's drive: one tree of folders and files, shown in the **Data** section. Names and folders change freely; bytes don't.
- **Source** is an import's provenance: who brought which files in, when and from where (an upload or a seed). It's shown in the inspector and the Imports list, not as a tree root.
- **Trash** holds deleted files and folders for 30 days; Restore puts them back where they were.
- **Dataset** is a logical, structured set of samples built from one or more sources.
- **Collection** is a coherent group within a dataset (e.g. MRI studies or echo recordings).
- **Task** describes work on a dataset: classification, segmentation, event marking, review, etc.
- **Version** is a published immutable snapshot with derivation history.

**Non-equivalence:** Project ≠ Dataset; Files ≠ Source ≠ Dataset; Dataset ≠ Task. A project may contain several datasets, one dataset may derive from many sources, and the same sample may serve several tasks. A dataset pins the files (and their versions) it was made from, so reorganizing Files never changes it.

### Navigation placement

- **Global rail/sidebar:** Home, Projects, Datasets, Recent; switch organization/workspace.
- **Project sidebar:** Overview, Data (the Files drive), Explore, Datasets, Studio, Review, Activity. This is separate from global navigation.
- **Studio contextual left panel:** Items / Labels. The Items tab is named by the data kind's noun (Images, Studies, Slides, Recordings, Videos); "Files" is the drive, which the nav calls Data, and "Review" is the project section, so neither word names a Studio tab. This is *not* the project sidebar; the latter collapses to a breadcrumb or icon rail during editing.
- **Task setup** (`/projects/:p/tasks/:taskId/setup`) is where an owner configures a task: labels, tools, viewer, panels, export formats and what annotators see. It's reached from the Studio's task switcher, its ⋯ menu and the Overview task card; annotators can open it read-only.
- **Right panel:** persistent, collapsible AI chat that carries project context across sections.

## 3. Workspace home / Projects

**Primary prompt:** “What are you working on?”

Screen elements:
- App identity + workspace switcher.
- Primary action: **New project**.
- Recent/active project cards with human names, one-line description, last activity, and a single direct resume action.
- Secondary navigation to all Projects and cross-project Datasets.
- Optional natural-language entry: “Describe what you want to work on—or add some files.”

**Create Project flow:**

1. User names a project or states a goal in natural language.
2. User may drag/drop files or whole folders immediately, or create an empty project.
3. Inkling creates the project, preserves original source paths, and begins safe file inspection.
4. Clean 2D image import can offer **Open Studio** directly. Mixed or ambiguous imports offer **Explore results** first.

Avoid making users define labels, JSON schemas, medical modality or export formats before they've supplied data.

## 4. Redesigned Project Overview — the project home

### Intent

A calm, useful home screen that quickly answers:
1. Where am I and what is this project about?
2. What was I doing most recently?
3. What data is here?
4. What requires my attention?

**Explicitly avoid** the previous dashboard with four dominant statistic tiles (`4 Sources`, `3 Datasets`, `247 Samples`, `12 Issues`). Metrics may appear *within relevant cards*, but should not define the screen.

### Recommended desktop hierarchy

```text
Inkling / Cardiac Research                             [•••]

PROJECT WORKSPACE
Cardiac Research
Organize, annotate, and prepare cardiac imaging data.

┌────────────────────────────────────────────────────────────┐
│ ✦ Continue where you left off                             │
│                                                            │
│ [scan thumbnail]  MRI Ventricle Segmentation               │
│                   Study 012 · 3D volume annotation         │
│                   [────── 13 / 20 reviewed ──────]         │
│                   [ Open Studio → ]                        │
└────────────────────────────────────────────────────────────┘

Your data                                          View sources
┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐
│ MRI Scans        │  │ Ultrasound       │  │ Diagnoses    │
│ 120 · 3D volumes │  │ 34 · Videos      │  │ 247 · Table  │
└──────────────────┘  └──────────────────┘  └──────────────┘
┌──────────────────┐
│ + Add data       │
└──────────────────┘

Needs your attention
┌────────────────────────────────────────────────────────────┐
│ ⚠ 7 records need matching                               > │
│   Possible links between diagnoses and MRI studies        │
│ ────────────────────────────────────────────────────────── │
│ ◻ 2 annotation reviews                                  > │
│   Confirm suggested ventricular contours                  │
└────────────────────────────────────────────────────────────┘
```

All numbers and records above are **illustrative placeholders**; real UI displays verified project state only.

### Details and interaction rules

**Project header**
- Breadcrumb, subtle project icon, project title, short editable description.
- Private/shared visibility state and overflow menu, not a row of analytics.
- Avoid treating the top heading as a second navigation sidebar.

**Continue where you left off — primary card**
- Show only when there is resumable activity.
- Include a thumbnail or modality icon, task name, current file/study, short task description, and relevant progress.
- **Open Studio** resumes exact context: dataset, selected sample, slice/frame, tool, and optional panel state when safe/appropriate.
- If no resumable state, use an encouraging start state rather than an empty progress bar.

**Your data — compact cards**
- Surface 2–4 meaningful sources or logical collections, e.g. MRI Scans, Ultrasound, Diagnoses.
- Each card shows name, modality/type, a relevant count, and a clear open action.
- **View sources** goes to the full source inventory.
- **Add data** supports file upload, folder upload, and later supported connectors.
- Avoid presenting this section as exhaustive file navigation.

**Needs your attention — actionable queue**
- Show only a few high-priority items: unmatched records, unconfirmed schema mappings, review requests, blocked import, privacy warnings.
- Every row opens its exact resolution surface, not a generic dashboard.
- Indicate actual severity rather than colorful badges used only as decoration.
- Empty queue state should be quiet: “You're all caught up.”

### New-project empty state

Replace Resume + existing-data cards with a primary upload surface:

```text
Cardiac Research
Let's start with your data.
[ Drop files or folders here ]    [ Browse files ]
Or tell Inkling what you're trying to create…
```

Examples can be optional, not a mandatory wizard. Chat may suggest next steps but should not dominate Overview.

### Responsive behavior

- **Wide desktop:** project sidebar left; content central; optional AI chat right. Overview content must remain readable when chat is open.
- **Laptop:** collapsible project rail and AI drawer; main content remains the focal point.
- **Tablet/mobile:** Overview and browsing should work; heavy medical annotation may explicitly recommend desktop and appropriate controls. Do not promise full 3D authoring parity on phones.

### Visual treatment

Match current Inkling dark theme: restrained near-black surfaces, subtle borders, indigo/purple accent, compact typography, generous whitespace around the primary resume card, and minimal decorative icons. Prefer understated cards over metric-heavy dashboards. Avoid making Overview look like business intelligence software.

## 5. Project sections — unchanged responsibilities

| Section | Purpose | Primary surface |
|---|---|---|
| **Data** (Files) | Keep, organize and inspect the project's files and import history | Folder tree with editing, listing, inspector, upload tray, Imports, Trash |
| **Explore** | Understand physical and logical data shapes before choosing annotation | Shape summary, table preview, relations and mappings |
| **Datasets** | Manage logical datasets, collections, annotation tasks, versions | Dataset cards or table with clear task entry points |
| **Studio** | Annotate and edit one selected task using its appropriate viewer | Context panel + large canvas + AI assistant |
| **Review** | Resolve import issues, annotation disagreements and quality checks | Filterable queues and issue detail |
| **Activity** | Show who changed what, how data was transformed, and version history | Chronological event log, links to artifacts |

The Overview is deliberately not a replacement for these detailed screens. It only routes users to them.

## 6. Data: Files and messy-data ingestion

The **Data** section (nav label) holds the project's **Files**: one drive per project, a real file
system built on the kiwifs tree (todo7). Two things stay true: the **bytes** of every upload are
immutable, and nothing a dataset or version depends on changes silently. Names and folders are
the user's: every change is journaled, undoable and restorable, and the original filename,
relative folder, checksum, size, source metadata and authorization status are kept as provenance
("Uploaded as …" behind **Show original name**, members only, never sent to the assistant).
Wire contract: [`files-api.md`](files-api.md).

**Model.**
- One root per project ("Files"); each import lands in a folder the user picks, and each older
  source is a top-level folder named after it. Sample data is locked ("Copy it to make your own");
  copying is free (same bytes).
- Node ids are permanent and paths are computed, so a rename or move never breaks annotations
  (items key on the asset's storage path) or datasets (they pin files and versions, with a "new
  files since" banner for followed folders).
- Delete moves to **Trash** for 30 days. Undo (⌘Z) lives on the server and undoes the last batch
  *you* did, unless someone touched those files since ("Can't undo: *patient_002* changed after
  that").
- Uploading a file with a name already in the folder asks **Keep both / Replace / Skip**; Replace
  adds a version you can restore.

**Interaction spec (summary; the full one is todo7 §2).**
- *Where actions live:* a tree header (New folder, Upload, Collapse all, Sort, a filter of the
  loaded tree), hover `+` and `⋯` on folder rows, the toolbar's **New ▾**, a **selection bar**
  when anything is selected ("3 selected" · Move to… · Copy · Download · Star · Move to Trash),
  right-click menus on every row and breadcrumb segment, Rename / Versions / Activity in the
  inspector, and Starred · Recent · Imports · Trash under the tree.
- *Keyboard:* declared commands, never hard-coded; see [`ui.md`](ui.md#files-keyboard).
- *Drag and drop:* rows from the tree, list or grid onto folders, breadcrumb segments or starred
  folders; one visual for "this goes here"; 700 ms spring-loading; ⌥ copies; no reordering inside
  a folder; invalid targets say why; Esc cancels; every drag has a keyboard twin (Cut/Paste,
  Move to…).
- *Rename:* inline in the tree, the list and the inspector, the stem selected (Finder); names are
  unique per folder ignoring case, without `/`; changing an extension asks first. Renaming a file
  flagged for a name in its path re-runs the privacy check: the everyday way to remove a
  patient's name.
- *Conflicts:* one dialog for move, copy, paste and upload: Keep both (`name (2).ext`), Replace
  (a version) or Skip for files, Merge or Keep both for folders, "Do this for the other *n*".
- *Feedback:* optimistic with rollback; toasts bottom-left with **Undo** ("Moved 3 items to *MRI*"),
  mirrored to an `aria-live` region; other people's changes appear live ("Lam moved 2 items here").
- *The assistant:* reads folders and names, never contents or original names, and proposes a
  reorganization plan the user applies (one batch, one undo) or edits in Files (§9).

Example import:

```text
hospital_research/
├── MRI/
│   ├── patient_001/
│   │   ├── scan001.dcm
│   │   └── scan002.dcm
│   └── patient_002/
├── echocardiograms/
│   ├── echo_001.mp4
│   └── echo_002.mp4
├── diagnoses.csv
├── measurements.xlsx
├── reports/report_001.pdf
└── annotations/masks.nii.gz
```

**ImportSession states:** uploading → inspecting → needs review / ready → imported / failed. Show partial successes; failures should be actionable without discarding successfully inspected files.

**Discovery results** should include:
- Confirmed file types, modality signals, dimensions, codecs, row/column profiles and checksums.
- Candidate logical groups (MRI studies, videos, tables, document collections, segmentation masks).
- Possible identifier relationships, missing keys, duplicates, inconsistent schemas and privacy concerns.
- Confidence/evidence and **proposed** mappings requiring confirmation before merging patient/study records.

For medical files, file type classification does not authorize sharing, de-identification, or patient linkage. Never infer a verified clinical relationship from filenames alone.

## 7. Explore — the home for data shape

**Data shape lives primarily in Explore**, with contextual links in Data, Datasets, and Studio. It should not be buried in the AI chat.

Three levels:

| Level | User-facing question | Stored interpretation |
|---|---|---|
| Physical | What files and formats do I have? | File paths, hashes, dimensions, headers, codecs |
| Logical | How are records related? | Typed samples, studies, columns, join keys, mappings |
| Task | What am I trying to annotate? | Ontology, annotation geometry, reviewer state |

Example progression: 120 DICOM instances → one validated MRI study/volume → one left-ventricle segmentation task. Validation is needed; do not assume file count implies one volume.

Suggested Explore panels:
- **Shape summary** by modality / structure.
- **Data preview** (table, image, waveform, or metadata as appropriate).
- **Relationships** graph/list with explicit unconfirmed versus confirmed status.
- **Schema mapping** review: source field → intended dataset field, with examples and conflicts.
- **Quality checks** (missing values, duplicates, mismatched IDs, unsupported files).

If the data is already clean, summarize and offer **Create task / Open Studio** rather than forcing every Explore step.

## 8. Studio — preserve the current working editor

Keep the current capable X-ray canvas, toolbar, image controls, and overall visual density. Do not replace it with a general dashboard.

### Three-column editing shell

```text
[Header]  project ▸ task ▾   ·   Your draft · Saved ✓ ▾        [Request review] [✦] [⋯]
[Context sidebar]       [Main viewer / canvas]        [Inkling AI]
 Items | Labels          Toolbar (usable tools only)    Conversation
 Folders or Queue        Modality-specific canvas       Proposals
 On this image           Decision bar (classification)  Approvals
                         Status bar (path, item, ?)
```

**Header:** three zones, at most seven controls at 1440px. Left, where am I: the panel toggle, the project (a link to its Overview) and a task switcher that lists the project's tasks with their progress plus "Task setup…". Middle, the state of my work: one chip that merges saving with versioning (`Saved ✓`, `Saving…`, `Not saved · Retry`; with versioning `Your draft · Saved ✓` or `Published (read-only)`), whose popover holds Compare versions and the switch between your draft and the published copy. Right, the one next step: **Request review** when the draft has changes, otherwise Export; then the assistant and a ⋯ menu (Export, Task setup, Keyboard shortcuts, Plugins, Theme, project Review). Workspace switching, the brand mark and the theme stay out of the Studio header.

**Context sidebar (left):** Items and Labels are *task-scoped*, not project-wide.
- **Items** (titled Images, Studies, Slides…) answers "what do I work on next?". The **Folders** view mirrors the Data tree (same names, icons and compaction, rooted at the task's common folder); leaves are items, never raw slices, so a 3D study is one row with its slice count. The **Queue** view is a flat list in work order with `All · To do · Needs review · Done` chips. `N` jumps to the next to-do item from either view. Duplicate names get a dimmed distinguishing parent path; a hover card shows the full Data path; the row's menu has **Show in Data**, and Data's inspector links back ("In tasks").
- **Labels** has Classes (key and count visible; hide, lock and color behind the row's ⋯), **On this image** (the current item's annotations as compact rows: click selects and pans to it, Shift/⌘-click multi-selects) and the selection inspector pinned at the bottom. The project-wide feed of annotations belongs on the Review page; owners can add an "All annotations" panel back in Task setup.
- **Blind by default:** for a classification task, labels that came with the files (e.g. a source folder named `pneumonia`) aren't shown to annotators, so the labels they produce are an independent read. Task setup → Annotators see turns them on for correction work. Imported annotations are proposals to confirm and always show, marked as imported.

**Toolbar:** the task decides the tools. A drawing tool appears only when some label group accepts what it draws (a classification task has no shape tools). Groups of three or more tools (Shapes, Measure, Paint) fold into one split button that shows the last used tool; its chevron lists the group with names and keys. Keys never change. View settings (window/level, invert, overlay opacity, and a View ▾ menu with the Zoom tool, reset, flip and rotate) sit at the bar's right end with the renderer's other view controls.

**Decision bar:** when the task has a single- or multi-choice group, keyed buttons under the canvas (`[1 Normal] [2 Pneumonia]`, Skip) record the class; with **Advance after choosing** (on by default for single choice) the Studio moves to the next to-do item. It's the task's main action, so it sits where the eyes are.

**Keyboard shortcuts:** `?` (or ⋯ → Keyboard shortcuts) opens a searchable sheet that leads with at most eight Essentials, then this task's tools as keycaps under the toolbar's group headings, then the commands; contextual keys sit under "While drawing". Tooltips and menus show keys where the action is.

**Task setup:** owner work, done before annotating, in plain words and on one page: Labels (a real editor for classes, colors, keys, single or multiple choice), Tools (checkboxes; tools hidden because no label accepts them are listed greyed with the reason), Viewer, Panels, Export formats and Annotators see. One Save, with an Undo toast; module ids and the raw spec stay behind Technical details. "Describe a change" hands the same edit to the assistant.

**Canvas (center):** The visual environment adapts to modality: 2D X-ray/photo, 3D CT/MRI, cine/video, 4D cardiac, pathology WSI, waveform, or tabular editor. Preserve native metadata, orientation and spatial/temporal references.

**Assistant (right):** Context-aware chat may suggest annotations, configure task tools or explain quality issues; user verifies model-generated medical labels before marking them reviewed.

**Space management:** Global/project navigation collapses into breadcrumb/icon rail in Studio. Left and right panels independently collapse, resize, and restore state. Annotation tools remain usable with chat closed.

**Status bar:** previous / next, the item's position and its Data path as a breadcrumb (each segment filters Items to that folder), zoom, slice/frame/time, current task, and a quiet `? Shortcuts` hint until the sheet has been opened once; show spatial units only when calibrated metadata exists. “No pixel spacing” must never masquerade as measurements in millimeters.

## 9. Persistent AI chat — Cursor-like, not a generic bot

The assistant follows project context across Overview, Data, Explore, Datasets, Studio, Review, and Activity. It can read permitted project metadata and propose typed tool actions.

Examples:
- “What did I import?” → inspect source inventory.
- “These folders have different schemas—organize them.” → propose groups and mappings.
- “Group these scans by patient.” → propose a reorganization of Files (new folders, moves, renames) as a before/after card; **Apply** runs it as the user in one undoable step, **Edit** opens it in Files with a checkbox per step. The assistant can't change files itself.
- “Match diagnosis.csv to MRI studies.” → display candidate joins and ambiguous rows for review.
- “Create a ventricular segmentation task.” → propose ontology, tooling, scope.
- “Open the scan with missing labels.” → navigate to task/sample.
- “Export the reviewed version.” → prepare export with validation and rights checks.

### Agent interaction contract

1. Assistant states what it detected and what it proposes.
2. Show **action preview**: affected sources, output collections, field changes, estimated compute if significant, and privacy/rights implications.
3. User approves consequential writes, bulk transformations, external calls or publication.
4. Backend executes only through typed, permission-checked tools.
5. UI reports actual results and preserves an execution log with source links and transformation provenance.
6. User can inspect or reverse changes where supported; immutable originals remain intact.

Never claim data is normalized, linked, published, or saved before a backend operation confirms success. Never let chat silently merge patient identities or expose protected information.

**Action vocabulary:** inspect_source, propose_schema, create_collection, map_fields, configure_annotation_task, open_viewer, suggest_annotation, validate_dataset, prepare_export, publish_version. Tool names are internal; visible labels use plain language.

## 10. Review and versioning language

Keep user-facing language accessible:

| Technical concept | User-facing term |
|---|---|
| Git commit | Save draft |
| Tag/release | Publish version |
| Pull request | Request review |
| Diff | Compare versions |
| Merge conflict | Changes need review |
| Working branch (`anh/work`) | Your draft |
| `main` / protected branch | Published (read-only) |
| Stale head after someone else saved | Someone else saved |

In the Studio this is one work-state chip: `Your draft · Saved ✓`, or `Published (read-only)` when you're looking at the published copy. Its popover offers Compare versions and the switch between your draft and the published copy; the branch name appears only there, in small print. The header's primary button reads **Request review** (never "Submit for review" or "Pull request"). "Review" otherwise means exactly one thing: the project section.

Review issues can concern *data ingestion, mapping, privacy, annotations, and publication*. An issue should link to an exact file, sample, field, region, or time range wherever possible. Show status, owner, comments, fix, and affected versions.

Dataset versions must record inputs, transforms, tasks, annotation versions and rights metadata so buyers or collaborators can understand provenance. Never silently rewrite a published artifact.

## 11. Suggested routes and component structure

```text
/
/projects
/projects/new
/projects/:projectId/overview
/projects/:projectId/sources
/projects/:projectId/explore
/projects/:projectId/datasets
/projects/:projectId/datasets/:datasetId
/projects/:projectId/studio/:taskId
/projects/:projectId/tasks/:taskId/setup
/projects/:projectId/review
/projects/:projectId/activity
```

Suggested frontend composition:

```text
AppShell
├── WorkspaceNavigation
├── ProjectShell
│   ├── ProjectNavigation
│   ├── ProjectHeader
│   ├── ProjectOverview
│   │   ├── ResumeWorkCard
│   │   ├── SourceSummaryCards
│   │   └── AttentionQueue
│   ├── FilesPage
│   ├── ExplorePage
│   │   ├── ShapeSummary
│   │   ├── DataPreview
│   │   └── MappingReview
│   ├── DatasetsPage
│   ├── StudioPage
│   │   ├── ContextTabs (Items / Labels)
│   │   ├── ViewerAdapter
│   │   └── AnnotationToolbar
│   ├── ReviewPage
│   └── ActivityPage
└── PersistentAgentDrawer
    ├── ChatHistory
    ├── ContextIndicator
    ├── ActionProposal
    └── ActionResults
```

Persist project/task selection in URLs. Do not encode sensitive medical content in query strings. Keep preview/agent action state coherent with the underlying project revision.

## 12. Implementation priorities

### P0 — product foundation

- Introduce projects above datasets.
- Create redesigned Project Overview with resume card, data cards, attention queue and empty state.
- Preserve working 2D annotation Studio and contextual left tabs.
- Add Sources import sessions and source preservation.
- Add basic Explore data-shape summary with detected versus proposed labels.
- Add persistent, collapsible right-side AI panel with read-only project context initially.

### P1 — useful AI-native workflows

- Schema mapping approval and heterogeneous input grouping.
- Task and collection creation from approved proposals.
- Safe typed agent tool calls with action preview, audit log and permissions.
- Studio routing into task-specific viewers.
- Review links from Overview to exact issues.

### P2 — collaboration and marketplace preparation

- Dataset version comparison and review requests.
- Advanced data pipeline graphs, additional connectors, multi-author workflows.
- Commercial publishing and bundled dataset composition subject to rights and quality checks.

## 13. Acceptance criteria

**Overview:**
- A returning user can resume the exact last task in one prominent action.
- Data cards navigate to sources/datasets and do not display fabricated metrics.
- Each attention item opens a specific solvable issue.
- A brand-new project prominently supports upload and natural-language description.

**Mixed data import:**
- Import a folder containing 2D images, CSV labels, and unrelated files.
- Preserve originals and show detected shapes.
- Suggest, but do not silently apply, a CSV-to-image relationship.
- User approves mapping and opens the correctly configured existing 2D Studio.

**Agent:**
- Chat retains project context when changing sections.
- Proposed writes display intended changes and require appropriate approval.
- Results report success/failure from the backend, with log entries.
- No unauthorized external calls or unreviewed clinical annotations.

**Studio:**
- Left task tabs and viewer remain functional with chat hidden.
- Image controls, annotation persistence, current sample and save state remain intact.
- Project navigation can collapse to recover editing space.

## 14. Design choices deliberately deferred

- Public marketplace browsing and pricing controls.
- Full Git UI, branch management and developer terminology.
- Automated medical diagnosis and clinically validated decision support.
- Unrestricted PHI ingestion, cloud transfer or model inference.
- Complete mobile parity for 3D medical annotation.
- Autonomous agent mutation without preview and permission controls.

---

**One-sentence design rule:** *Overview helps you resume and decide what to do; Data keeps your files, tidy and undoable, with what you brought preserved; Explore explains what it means; Datasets organizes what you're building; Studio lets you work; Review protects quality; Activity shows what changed; and Inkling AI connects them without taking control away from the expert.*
