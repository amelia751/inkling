# Inkling Studio — UI/UX Specification

**Status:** MVP design proposal  
**Platform:** Browser-first, desktop-first responsive web application  
**Audience:** Medical domain experts with limited programming or machine-learning experience  
**Primary objective:** Enable an expert to import authorized medical imaging data, create and review annotations, then export a well-documented dataset without writing code.

## 1. Product principles

1. **Canvas-first inside the Studio.** The image/volume being annotated is the visual focus.
2. **Progressive disclosure.** Everyday tools stay obvious; specialist controls appear when relevant.
3. **Manual workflow always works.** AI suggestions accelerate tasks but are never required.
4. **No silent AI edits.** Suggested labels, contours, or metadata must be previewed and confirmed before they are committed.
5. **One workflow, different viewers.** The shell stays consistent across 2D images, 3D volumes, video, and eventual pathology slides.
6. **Preserve provenance and privacy.** Keep original files, track annotation authorship and revisions, and do not presume that clinical images are redistributable.
7. **Avoid unnecessary panels.** Sidebars collapse; the canvas can expand.

## 2. Primary information architecture

The app's information architecture is in [`ux.md`](ux.md): the organization and its projects
(§2, §3), the project sidebar and its sections (§2, §5), the Overview (§4), the assistant
drawer (§9) and the routes (§11). This document keeps the rules for the Studio, the editor for
one task.

In short:

- Home (`/`) lists recent projects; `/projects` lists all of them.
- A project has a sidebar with Overview, Data, Studio, Review and Activity, and Settings at the
  bottom. "Data" is ux.md's Sources section (the route stays `/sources`). Explore and Datasets are
  off the sidebar for now; their pages open from Overview, Review and the Studio's top bar. The breadcrumb reads `Workspace ▾ / Project ▾ / Section`
  ("Workspace" is the organization in UI copy).
- The Studio opens one task at `/projects/:projectId/studio/:taskId`. There the project sidebar
  collapses to a 48px icon rail.
- The assistant follows the project across sections: a drawer on the right outside the Studio,
  the Studio's right panel inside it. Same thread, same context chip.
- Export and versions live under Datasets › (dataset) › Publish & export and Versions; plugins
  under Settings › Plugins. Old `/datasets/:id/…` links redirect.

The Studio itself:

```text
Studio / :projectId / :taskId
├── Project rail (collapsed project sidebar)
├── Files (left tab, task-scoped)
├── Labels & layers (left tab)
├── Review queue (left tab)
├── Viewer / canvas (center)
└── Inkling AI assistant (right)
```

Public marketplace browsing, paid licensing, and creator storefronts are later phases.

## 3. Desktop Studio layout

```text
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Inkling  /  Cardiac MRI Dataset          Draft · Saved             Share   Review  Export │
├───────────────────────┬───────────────────────────────────────────┬──────────────────────┤
│ LEFT SIDEBAR          │ MAIN CANVAS                               │ RIGHT SIDEBAR        │
│ Files | Labels |      │ Select  Pan  Draw  Brush  Erase  Measure  │ Inkling AI           │
│ Review                │                                           │                      │
│                       │                                           │ Context: Scan 001    │
│ Patient scans         │           [MEDICAL IMAGE VIEWER]          │                      │
│  ▾ Study 001          │                                           │ “Outline the left    │
│    Scan 001 (active)  │                                           │  ventricle”          │
│    Scan 002           │                                           │                      │
│  ▸ Study 002          │                                           │ Suggest contour      │
│                       │                                           │ [Preview] [Discard]  │
│ Annotation layers     │                                           │                      │
│  ◉ Left ventricle    │                                           │ Ask Inkling...       │
│  ◉ Right ventricle   │                                           │                      │
├───────────────────────┼───────────────────────────────────────────┼──────────────────────┤
│ Add files             │ Slice 12/64  [────────●──────] Zoom 100%  │ Current task         │
└───────────────────────┴───────────────────────────────────────────┴──────────────────────┘
```

**Recommended widths:** Left sidebar 240–280 px; AI sidebar 300–360 px; center takes the remaining width with a comfortable minimum of ~600 px on a wide desktop. Both sidebars are collapsible and resizable. For narrower screens, collapse the right AI panel first and then the left sidebar into a drawer. Do not promise full 3D annotation usability on phones.

### Top bar

- Project rail and breadcrumb: Workspace → Project → task.
- Dataset status: Draft, Processing, Needs Review, Ready for Export.
- Autosave state: Saving, Saved, Offline/Error. Never imply saved until the server confirms it.
- Collaborator/avatar controls **only when collaboration is implemented**.
- Actions: Review and Export/Publish; rights confirmation required before public publishing.

### Left sidebar — three tabs

**Files:** Nested datasets, studies, series, images or frames; search/filter; upload; active item; import/processing state. Show patient/study grouping when permitted, but avoid presenting identifying details by default.

**Labels:** Ontology/classes, annotation layers, per-layer visibility, label colors, counts, selected class. Include quick Add label and per-label description. Explain medical terms in plain language when helpful, without replacing clinical expertise.

**Review:** Outstanding annotations, AI suggestions awaiting acceptance, reported issues, unresolved warnings, and reviewed items. Filters: My work, Needs review, Completed. Annotations link back to their exact slice/frame and version.

### Center canvas

- Compact toolbar: select, pan, zoom, window/level (for DICOM), contour/polygon, brush, erase, measure, undo/redo.
- Contextual tools: do not show segmentation brush for a simple classification-only task.
- Canvas should render using a modality-aware viewer, not a single custom HTML canvas.
- Image navigation: slice index, cine/time playback, multi-planar views, zoom, orientation, scale metadata where relevant.
- Safe empty state: `Upload images to begin` with accepted formats and privacy reminder.
- Never overwrite original image files during annotation.

### Right sidebar — Inkling AI

- Conversation scoped to current dataset, selected image/series, selected annotations, and user permissions.
- Sample prompts: “Help me define labels,” “Suggest a contour,” “Find unlabeled scans,” “Explain validation warnings,” “Prepare dataset documentation.”
- AI responses can contain structured actions: preview proposed label schema, show annotation overlay, highlight missing cases.
- **Preview → Approve/Reject** required for all AI-generated or AI-modified annotations. Always mark provenance `AI suggested`, `Human corrected`, or `Human created`.
- Surface failures, uncertainty, and processing cost/limits. Don't claim clinical diagnosis or expert verification.
- Chat can be hidden without blocking any core manual workflow.

### Bottom status/navigation bar

- Contextual status: slice/frame position, zoom, image orientation or spacing (if available), processing status, pending unsaved edits.
- Slider for slice/time with keyboard navigation; in 3D show synchronized axial/sagittal/coronal positions.
- Keep the bottom bar lightweight; it must not consume vertical canvas space unnecessarily.

## 4. Viewer modes and contextual UI

| Data type | Viewer | Canvas interactions | Additional controls |
| --- | --- | --- | --- |
| 2D image (X-ray, fundus, dermatology) | Cornerstone3D image viewport | Pan, zoom, window/level, box, polygon, brush, classification | Image list; label selector |
| 3D CT/MRI volume | Cornerstone3D volume/multi-planar view | Slice navigation, 3D segmentation masks, measurements | Axial/sagittal/coronal views, volume position |
| 2D time series (echo/cine/video) | Cine or video viewport | Frame-specific marks, temporal labels | Play/pause, timeline, frame step |
| 3D + time (4D) | Dedicated temporal volume workflow | Time-indexed volumetric annotations | Time slider + spatial navigation; **later phase** |
| Whole-slide pathology | OpenSeadragon or dedicated WSI viewer | Tile-based pan/zoom, polygons, regions | Magnification, overview minimap; **later phase** |
| ECG/physiological signals | Waveform viewer | Segment/events/markers | Channels, time scale; **later phase** |

For the MVP, support **2D images first**, followed by one **3D CT/MRI** workflow. Architect a `ViewerAdapter` boundary for future data types.

## 5. Key user flows

### A. Create a dataset

1. Workspace → **Create dataset**.
2. Plain-language prompt: “What do you want to teach or evaluate?”
3. Select task: classification, detection, segmentation (MVP); advanced tasks later.
4. Upload approved data or use a sample dataset.
5. Inkling identifies supported formats, groups studies/series, and extracts metadata safely.
6. Confirm import results and resolve unsupported files.
7. Studio opens with the correct viewer, initial label suggestions optional.

### B. Manual annotation

1. Select image and label class.
2. Choose relevant drawing tool.
3. Annotate and preview overlay.
4. Save annotation with reference to dataset version, image coordinates, author, and timestamp.
5. Move to next image; indicate completion clearly.

### C. AI-assisted annotation

1. Expert asks AI for an annotation suggestion or clicks Suggest.
2. Async operation runs with bounded compute quota.
3. Suggested annotation appears as distinguishable preview overlay.
4. Expert accepts, edits, or discards it.
5. Store model/provenance metadata and user decision; never silently record a suggestion as expert verified.

### D. Review and correction

1. Review tab shows outstanding warnings and proposals.
2. Reviewer clicks issue and navigates to exact image/slice/frame and annotation.
3. Reviewer comments, requests correction, or accepts annotation.
4. Creator fixes issue; change is reflected in annotation history.
5. Published dataset versions remain immutable; corrections create a new version.

### E. Export / publish

1. Review dataset summary: counts, labels, missing annotations, quality checks.
2. Generate dataset card: source, task, format, limitations, annotation method, version.
3. Confirm licensing rights and privacy status; block public sharing where checks are incomplete.
4. Choose appropriate export representation, including images, annotations, and machine-readable metadata.
5. Download or publish approved version. Commercial marketplace transactions are out of scope for MVP.

## 6. React component structure

The pages outside the Studio and their components (`ProjectShell`, `ResumeWorkCard`,
`AttentionQueue`, the source tree, `PersistentAgentDrawer`, …) follow [`ux.md`](ux.md) §11.
The project shell isn't a separate component: `AppLayout` grows the project sidebar and rail.
What's where today:

```text
apps/web/src/studio/
├── app/
│   ├── AppShell.tsx              # routes (ux.md §11), legacy /datasets/… redirects
│   └── routes/                   # HomePage, ProjectsPage, ProjectOverviewPage, FilesPage,
│                                 # ExplorePage, DatasetsPage, DatasetStudioPage, ProjectReviewPage,
│                                 # ReviewPage, ActivityPage, ProjectSettingsPage, ExportPage, PluginsPage
├── components/
│   ├── layout/                   # AppLayout (project sidebar and rail), breadcrumb switchers
│   ├── ai/                       # AssistantPanel, the agent drawer, cards
│   ├── sources/                  # tree, listing, inspector, Quick Look, imports
│   ├── uploads/                  # the upload tray
│   ├── projects/                 # New project
│   └── studio/                   # StudioLayout, StudioTopBar, LeftSidebar, CanvasToolbar,
│                                 # CanvasStatusBar, ViewportHost, PanelHost
├── core/panels/                  # Files, Labels, Review and AI panels of the Studio
├── lib/                          # API clients, routes, resume, uploads (hash worker, folder walk)
└── stores/                       # Zustand: studio, shell, sources, uploads, agent
```

Shared primitives (shadcn, the file tree, icons) are in `packages/ui`; viewers are trusted
renderers in `packages/renderers` and plugins (`docs/modules.md`).

**State split:** React/Zustand owns selected tools, panels, current sample and in-progress edits. TanStack Query owns server state. Cornerstone manages image cache/rendering; avoid putting pixel arrays in React state. Persisted annotation records come from the backend.

## 7. Responsive behavior and accessibility

- Desktop is the primary annotation environment.
- Tablet: one sidebar at a time, large touch targets, basic image review supported.
- Mobile: dataset list, reviews, comments, and lightweight status—not full 3D annotation.
- Keyboard shortcuts for navigation, undo, zoom, and tool selection. Provide discoverable shortcut help.
- Clear focus states, semantic labels for controls, accessible contrast, and non-color-only annotation statuses.
- Support large text without clipping essential controls; maintain canvas resize behavior.

<a id="files-keyboard"></a>
### Files keyboard (Data section)

Declared as core commands with `when: section == files` (the Data section's drive), never
hard-coded in a component (`AGENTS.md`; the `shell-commands.test.ts` pattern). From todo7 §2.

| Action | macOS | Windows / Linux | Note |
|---|---|---|---|
| New folder | ⇧⌘N | Ctrl+Shift+N | Finder, Explorer |
| Rename | F2 / Enter-on-focused-name in the inspector | F2 | Enter stays "open" in tree and list (todo6) |
| Cut / Copy / Paste | ⌘X / ⌘C / ⌘V | Ctrl+X / C / V | paste goes into the focused folder or the listed one |
| Duplicate | ⌘D | Ctrl+D | |
| Move to Trash | ⌘⌫ | Delete | |
| Undo / Redo | ⌘Z / ⇧⌘Z | Ctrl+Z / Ctrl+Y | server journal: undoes your last batch, including an applied assistant plan |
| Select all / Clear | ⌘A / Esc | Ctrl+A / Esc | |
| Extend selection | ⇧↑ ⇧↓, ⇧-click, ⌘-click | same with Ctrl | |
| Expand all below | ⌥-click, or ⌥→ | Alt-click, Alt+→ | capped at 2,000 rows |
| Info (toggle inspector) | ⌘I | Ctrl+I | |
| Already there | Space Quick Look · ⌘↑ parent · ⌘F search · ← → in Quick Look | | todo6 |

Every drag has a keyboard twin (Cut and Paste, or Move to…), and Shift+F10 or the Menu key opens
a row's context menu.

## 8. Privacy and safety UX

- Import screen warns that users must have the right to upload and process the files.
- Default new projects to private; do not publicly share scans automatically.
- Do not display full patient identifiers in file trees or AI chat prompts by default.
- AI assistant must not send raw images or metadata to a third-party model provider without an approved processing path and explicit applicable consent/authorization.
- Offer deletion, retention and access controls; show when images are being uploaded versus processed locally.
- Separate `Identity verified`, `Expert credentials verified`, and `Dataset quality reviewed` concepts; do not conflate them.
- For MVP, support appropriately licensed, de-identified or synthetic research data only. HIPAA-regulated workflows require further security, legal, and operational work.

## 9. Visual language

- Calm, neutral UI; let the underlying medical images take priority.
- Dark canvas by default, with light/dark application chrome optional.
- Clear typography and sparse icons; descriptive tooltips for nontechnical users.
- Human-review and AI-suggestion states must be visibly distinct.
- Avoid overwhelming experts with machine-learning terminology. Use plain-language task instructions with advanced settings expandable on demand.

### Errors and empty states

Five tiers, as in the Nebius console. Pick the smallest one that still shows where the problem is.
Every error says what happened and the next step, in plain words; never a bare status code.

| Tier | Use for | Component |
| --- | --- | --- |
| Page | Unknown URL, deleted item, no access, server unreachable, crash, stale deploy | `ErrorState variant="page"` (`NotFoundPage`, `RouteError`, `ErrorView`, `FullPageMessage`) |
| Section | Empty list, search or filter with no results | `ErrorState variant="section"`; tables use `NoResults` |
| Inline alert | An action in a page or dialog failed; a note about the whole page | `Alert theme="danger" \| "warning" \| "info"` |
| Field | One input is invalid | `Field error=…` + `invalidProps(id, error)`: red border, 13px danger text under the input |
| Toast | A background action finished or failed, nothing to fix on the page | `notify(msg, { tone })` |

- `describeError` (`studio/lib/errors.ts`) turns any thrown value into one of: not found, no
  access, can't reach the server, new version available, needs the full stack, something went
  wrong. Each has its illustration and next step: Go to homepage for 403/404, Retry or Reload
  where it can help, and Copy error details (with the API request ID) for unknown errors.
- Every route sits under one `errorElement` (`RouteError`), so a page that throws never leaves a
  blank tab.
- Validate a field on blur or on submit, not while the person is still typing.
- Illustrations are Gravity's (`@studio/ui/illustrations`, MIT), coloured by the `--gil-color-*`
  tokens. Danger red is for errors only, never for decoration.

## 10. MVP implementation order and acceptance criteria

### Phase 1 — Studio shell

- Workspace with dataset cards and create workflow.
- Three-column Studio layout, tabs, collapsible right assistant panel.
- Empty states and file tree.
- **Pass:** User can navigate from a dataset to a clearly structured canvas without guidance.

### Phase 2 — Real image editing

- Cornerstone viewer for approved 2D images.
- Label classes, basic annotations, undo/redo, autosave, version-aware storage.
- **Pass:** Expert can label a small dataset and reload the work without losing annotations.

### Phase 3 — Review and AI assistance

- Review queue, issue comments, optional AI suggestions with approval.
- **Pass:** Human can reject or edit AI-generated annotations, and provenance is accurately stored.

### Phase 4 — Imaging expansion and export

- One 3D DICOM/NIfTI workflow using a volume viewer.
- Dataset card, validation, export and versioning.
- **Pass:** An independent ML engineer can load the exported dataset, verify spatial metadata, and reproduce annotations.

## 11. Deliberately out of scope for the first release

- Public dataset marketplace, payments, dynamic commissions, revenue splits.
- Automatic medical diagnosis or clinically approved decision support.
- Advanced 4D heart contour tracking, whole-slide pathology, waveform annotation.
- Complex enterprise user provisioning, real-time multi-user editing, bespoke annotation model training.
- Unrestricted patient-data uploads or claims of HIPAA compliance.

## 12. Open product questions to validate with users

1. Do experts naturally prefer navigating **files first** or **tasks/labels first**?
2. Does an always-visible AI panel help, or distract from image review? Test with it collapsed by default.
3. What is the most understandable representation of a 3D segmentation task for a beginner?
4. Which first-use template resonates most strongly: chest X-ray classification or MRI segmentation?
5. How much manual correction do experts expect from AI-generated contours?

---

**Product shorthand:** **Left = what I'm working on. Center = where I work. Right = optional AI help.**

**Navigation shorthand:** **Workspace → Studio → Review → Export/Publish.**
