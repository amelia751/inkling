# Inkling UX Specification

**Status:** Proposed product UX, v0.2  
**Scope:** Workspace, Projects, Project Overview, Sources, Explore, Datasets, Studio, Review, Activity, and persistent AI assistant  
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
3. **Preserve originals.** Imported files and their structures remain inspectable and immutable by default.
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
        ├── Sources        ← original uploads, folders, connectors, import history
        ├── Explore        ← discovered shapes, schemas, relationships
        ├── Datasets       ← logical collections, tasks, versions
        ├── Studio         ← modality-aware editor for a selected task
        ├── Review         ← annotation issues, import conflicts, mappings
        └── Activity       ← audit-friendly change history

Persistent contextual Inkling AI panel can accompany any Project section.
```

**Terms:**

- **Workspace** is an account or organization and its members.
- **Project** is a durable research goal, e.g. *Cardiac Research*.
- **Source** is original imported material and provenance, e.g. `mri_scans/` or `diagnosis.csv`.
- **Dataset** is a logical, structured set of samples built from one or more sources.
- **Collection** is a coherent group within a dataset (e.g. MRI studies or echo recordings).
- **Task** describes work on a dataset: classification, segmentation, event marking, review, etc.
- **Version** is a published immutable snapshot with derivation history.

**Non-equivalence:** Project ≠ Dataset; Source ≠ Dataset; Dataset ≠ Task. A project may contain several datasets, one dataset may derive from many sources, and the same sample may serve several tasks.

### Navigation placement

- **Global rail/sidebar:** Home, Projects, Datasets, Recent; switch organization/workspace.
- **Project sidebar:** Overview, Sources, Explore, Datasets, Studio, Review, Activity. This is separate from global navigation.
- **Studio contextual left panel:** Files / Labels / Review. This is *not* the project sidebar; the latter collapses to a breadcrumb or icon rail during editing.
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
| **Sources** | Preserve and inspect the messy original files and import history | Folder tree, upload sessions, metadata and source warnings |
| **Explore** | Understand physical and logical data shapes before choosing annotation | Shape summary, table preview, relations and mappings |
| **Datasets** | Manage logical datasets, collections, annotation tasks, versions | Dataset cards or table with clear task entry points |
| **Studio** | Annotate and edit one selected task using its appropriate viewer | Context panel + large canvas + AI assistant |
| **Review** | Resolve import issues, annotation disagreements and quality checks | Filterable queues and issue detail |
| **Activity** | Show who changed what, how data was transformed, and version history | Chronological event log, links to artifacts |

The Overview is deliberately not a replacement for these detailed screens. It only routes users to them.

## 6. Sources and messy-data ingestion

Preserve original filenames, relative folders, checksums, size, source metadata, authorization status, and immutable raw assets. The user can browse these in a Drive-like tree.

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

**ImportSession states:** queued → inspecting → needs review / ready → imported / failed. Show partial successes; failures should be actionable without discarding successfully inspected files.

**Discovery results** should include:
- Confirmed file types, modality signals, dimensions, codecs, row/column profiles and checksums.
- Candidate logical groups (MRI studies, videos, tables, document collections, segmentation masks).
- Possible identifier relationships, missing keys, duplicates, inconsistent schemas and privacy concerns.
- Confidence/evidence and **proposed** mappings requiring confirmation before merging patient/study records.

For medical files, file type classification does not authorize sharing, de-identification, or patient linkage. Never infer a verified clinical relationship from filenames alone.

## 7. Explore — the home for data shape

**Data shape lives primarily in Explore**, with contextual links in Sources, Datasets, and Studio. It should not be buried in the AI chat.

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
[Context sidebar]       [Main viewer / canvas]        [Inkling AI]
 Files | Labels | Review  Zoom/measure/annotate          Conversation
 Selected sample         Modality-specific tools        Proposals
 Quick navigation        Slice/time navigation          Approvals
```

**Context sidebar (left):** Files, Labels, Review tabs are *task-scoped*, not project-wide. For a 3D study, Files lists studies or series rather than hundreds of isolated DICOM slices. Labels shows the relevant ontology. Review shows annotations for the task/current sample.

**Canvas (center):** The visual environment adapts to modality: 2D X-ray/photo, 3D CT/MRI, cine/video, 4D cardiac, pathology WSI, waveform, or tabular editor. Preserve native metadata, orientation and spatial/temporal references.

**Assistant (right):** Context-aware chat may suggest annotations, configure task tools or explain quality issues; user verifies model-generated medical labels before marking them reviewed.

**Space management:** Global/project navigation collapses into breadcrumb/icon rail in Studio. Left and right panels independently collapse, resize, and restore state. Annotation tools remain usable with chat closed.

**Status bar:** Save status, selected sample, zoom, slice/frame/time, current task; show spatial units only when calibrated metadata exists. “No pixel spacing” must never masquerade as measurements in millimeters.

## 9. Persistent AI chat — Cursor-like, not a generic bot

The assistant follows project context across Overview, Sources, Explore, Datasets, Studio, Review, and Activity. It can read permitted project metadata and propose typed tool actions.

Examples:
- “What did I import?” → inspect source inventory.
- “These folders have different schemas—organize them.” → propose groups and mappings.
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

Review issues can concern *data ingestion, mapping, privacy, annotations, and publication*. An issue should link to an exact file, sample, field, region, or time range wherever possible. Show status, owner, comments, fix, and affected versions.

Dataset versions must record inputs, transforms, tasks, annotation versions and rights metadata so buyers or collaborators can understand provenance. Never silently rewrite a published artifact.

## 11. Suggested routes and component structure

```text
/workspace
/workspace/projects
/workspace/projects/new
/projects/:projectId/overview
/projects/:projectId/sources
/projects/:projectId/explore
/projects/:projectId/datasets
/projects/:projectId/datasets/:datasetId
/projects/:projectId/studio/:taskId
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
│   ├── SourcesPage
│   ├── ExplorePage
│   │   ├── ShapeSummary
│   │   ├── DataPreview
│   │   └── MappingReview
│   ├── DatasetsPage
│   ├── StudioPage
│   │   ├── ContextTabs (Files / Labels / Review)
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

**One-sentence design rule:** *Overview helps you resume and decide what to do; Sources preserves what you brought; Explore explains what it means; Datasets organizes what you're building; Studio lets you work; Review protects quality; Activity shows what changed; and Inkling AI connects them without taking control away from the expert.*
