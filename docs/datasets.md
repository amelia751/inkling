# Datasets — UI/UX Specification

**Status:** Proposed product and interface specification (not a claim of implemented functionality)  
**Scope:** The existing **Datasets** tab, at project level and within individual datasets  
**Related:** `pipeline.md`, `versioning.md`, `plugins.md`, `agent.md`  
**Principle:** **Datasets is where people understand, organize, inspect, refine, and publish their data.** The shape and meaning of data are first-class. Version history is an integral capability, not the identity of the page.

---

## 1. Product intent

The Datasets tab should feel like a welcoming scientific data workspace, not a Git client, SQL schema editor, cloud bucket browser, or admin dashboard.

A researcher should be able to answer, without understanding backend architecture:

1. **What data do I have?** Which datasets, modalities, formats, records, studies, labels, and derived artifacts exist?
2. **How is it organized?** What is a patient, study, series, scan, video, measurement, or annotation? How do they relate?
3. **What shape does it have?** Which fields, dimensions, types, units, spatial/temporal axes, classes, and constraints describe it?
4. **Is it usable?** What is missing, malformed, mismatched, duplicated, uncertain, or pending review?
5. **How was it produced?** Which sources, pipeline runs, plugin and model versions, approvals, and data transformations generated it?
6. **Can I change it safely?** Can I propose new fields, relink items, edit labels, and change structures without destroying history or surprising downstream pipelines?
7. **What can I publish or share?** Which immutable snapshot is approved, what changed from the last release, and who may access it?

**Do not introduce a new top-level tab named “Data Model.”** All of the structure and format capabilities below live inside **Datasets**. Keep the existing project navigation (todo13 D10: Overview, Files, Datasets, Studio, Review, Activity; Files is the `sources` route, Explore opens from Datasets' "Needs attention", Datasets shows while `API_FEATURE_DATASETS_TAB` is on); pipeline runs live under Files.

### Distinguish adjacent features

| Area | Main job | What it must not duplicate |
|---|---|---|
| Sources | Connect, upload, and inventory raw inputs | Dataset curation and publishing |
| Explore | Search and visually browse across available data | Full structure editor |
| **Datasets** | Define logical collections, shape, relationships, quality, provenance, versions, and releases | Raw source upload experience; full task annotation canvas |
| Studio | View, label, correct, and manipulate individual data items | Project-wide dataset structure management |
| Review | Work queue for annotation, schema, pipeline and release approvals | Dataset history browsing |
| Pipelines | Design, monitor, rerun transformations | Source of truth for dataset releases |
| Activity | Chronological collaboration/event feed | Detailed diff or provenance investigation |

A dataset may be formed from several sources and may contain several modalities. A source file is not necessarily a dataset item; multiple files can form one study, and one file can yield many records or frames.

---

## 2. Navigation and information architecture

### 2.1 Project-level Datasets landing page

**Header:** `Datasets`  
**Subheading:** `Organize, understand, and prepare your data.`  
**Primary CTA:** `Create dataset`  
**Secondary actions:** `Add from sources` (links to Sources), `Import structure` (advanced; optional in MVP).

**Above the fold, show meaningful work, not vanity stats:**

- **Continue working:** datasets recently edited or viewed, with most relevant pending action.
- **Needs attention:** malformed data, missing relationships, pending schema proposals, incompatible pipeline consumers, items that need review.
- **Your datasets:** searchable, filterable cards/rows displaying name, short purpose, modality icons, content summary, freshness, and last meaningful change.

**Dataset card example:**

> **Cardiac Imaging Cohort**  
> MRI volumes · Ultrasound videos · Clinical table  
> 120 studies · 34 recordings · 247 measurements  
> Structure: 4 collections · 3 relationships  
> 7 unmatched study links · Last curated Oct 30  
> **Open dataset**

Counts are illustrative; summarize unique logical items rather than summing files + series + studies indiscriminately. Show which level is counted.

**Filters:** project/team, modality (image, volume, video, tabular, text, WSI, timeseries), status (ready, draft, needs attention, processing), ownership, updated date. **Search:** dataset names and descriptions; optional tags. **Display:** comfortable list/card toggle; never make a data table the only landing view.

**Empty state:** `Your datasets will appear here once you create one from your sources.` Actions: `Create dataset`, `Explore sources`. Include a small concrete example rather than technical vocabulary.

### 2.2 Inside a dataset

**Header:** Dataset name, editable description, location/breadcrumb, status, current view (`main` / draft), compact revision indicator, actions `Add data`, `Propose changes`, `Publish` (permission-dependent).

**Secondary navigation (within Datasets):**

1. **Overview** — collection composition, status, recent work, meaningful previews.
2. **Structure** — entities/collections and relationships; visual and list views.
3. **Fields & Formats** — exact data shape and physical representations.
4. **Annotations** — label ontology, geometry, tasks, attributes and attachment rules.
5. **Quality** — integrity, completeness, drift and compatibility diagnostics.
6. **History** — revisions, compares, branches, releases, provenance and change requests.

`History` is only one of six subviews; do **not** rename the entire Datasets tab to Versions. If six secondary sections feel too dense at narrow widths, keep Overview/Structure/Quality/History visible and nest Fields & Formats and Annotations under Structure, preserving deep links.

Cross-cutting controls: **dataset snapshot selector**, **search within dataset**, **filter**, **view provenance**, and a context-aware **Propose change** action. Snapshot selector distinguishes `Working draft`, `main (latest approved)`, and `Release vN` (read-only). Avoid implying drafts are published.

---

## 3. Layout and interaction language

- **Default:** a clean two-column workspace with secondary tab/navigation at top; main work area; optional contextual right inspector, not a permanent heavy sidebar.
- **Structure graph:** spacious, pan/zoom, auto-layout; switch to accessible tree/list for dense models and keyboards. Avoid rendering every patient or file as a node: show *entity types and links*, optionally with sample counts.
- **Details inspector:** opens on selecting an entity, field, link, validation error, or history entry. Use plain-language labels with developer details expandable.
- **Progressive disclosure:** show `MRI volumes` before `NIfTI float32[Z,Y,X]`; show `Image size / voxel spacing / units` before complex JSON schema details.
- **No destructive instant edits on published snapshots.** Editing an approved structure creates a draft/proposal.
- **Visual terminology:** `Collection`, `Field`, `Format`, `Connection`, `Label`, `Issue`, `Change`, `Release`. Use `schema`, `ontology`, `commit`, `CAS` in advanced details/tooltips, not every primary label.
- **Do not present inferred facts as verified.** Proposed relationships and guessed formats must be visibly tagged `Suggested` until confirmed.

### Suggested desktop layout

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Cardiac Research  /  Datasets  /  Cardiac Imaging Cohort                    │
│                                                                             │
│ Cardiac Imaging Cohort                    [main ▾] [Add data] [Propose change]│
│ MRI studies, ultrasound and measurements                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ Overview  Structure  Fields & Formats  Annotations  Quality  History         │
├──────────────────────────────────────────────────────┬──────────────────────┤
│                                                      │                      │
│  Main workspace: graph / table / diff / previews     │ Context inspector    │
│                                                      │ selected item details│
│                                                      │ constraints/actions  │
│                                                      │                      │
├──────────────────────────────────────────────────────┴──────────────────────┤
│ Contextual notes and action status (never an always-on metrics dashboard)    │
└─────────────────────────────────────────────────────────────────────────────┘
```

Mobile/tablet: replace right inspector with drawer; graph defaults to navigable list of relationships; preserve core browsing and review; heavy schema editing may show an explicit desktop-optimized affordance rather than a broken editor.

---

## 4. Overview — the dataset home screen

**Question:** `What is this dataset, and what needs my attention?`

- Intro: one-sentence description and source/project context.
- **Collections:** cards by logical collection (MRI studies, ultrasound exams, diagnoses, segmentation annotations), with modality, a representative preview, *number of logical items*, and format badges.
- **Continue where you left off:** e.g., `Review 7 unmatched study links`, `Inspect 3 files with unknown spacing`.
- **Needs attention:** unresolved issues prioritized by risk (PHI policy, schema breaking change, geometry mismatch, missing references), not raw count alone.
- **How things connect:** small summary graph or relationship list with `View structure`.
- **Recently changed:** human-readable recent curation, not a stream of hashes.
- **Latest release:** one compact line `Published v1.3` with `Compare changes`.

Do not use giant KPI tiles as the default dataset homepage. Do not duplicate the project Overview or Studio's active editing tasks.

---

## 5. Structure — the logical shape of the data

This should be the **signature view** of Datasets. It answers `What things exist, and how are they related?`

### 5.1 First-class entities

- A **collection/entity type** describes a logical thing: Patient, Study, Series, Volume, Recording, Diagnosis, Annotation, Derived Measurement, Pathology Slide, etc.
- A **record/item** is an instance of one entity. One study may reference hundreds of files, and one patient may have several studies.
- A **relationship** links entities with semantics, cardinality, join keys/reference IDs, requiredness, and privacy scope.
- **Fields** belong to an entity type. **Formats** describe physical encodings backing items. **Annotations** attach under explicit rules.

Illustrative structure:

```text
Patient (pseudonymous ID)
  ├── 1 : N ── Study
  │             ├── 1 : N ── Imaging Series
  │             │             └── 1 : N ── Volume / Image
  │             └── 0 : N ── Ultrasound Recording
  ├── 0 : N ── Clinical Measurement
  └── 0 : N ── Diagnosis

Volume / Image ── 0 : N ── Segmentation Annotation
                       └── label ontology + spatial reference
```

Model patients and linkage as *application entities* rather than leaking PHI into graph labels or sample previews. External, pseudonymous IDs only where allowed.

### 5.2 Structure graph interactions

- Click entity → inspector with purpose, record counts, required fields, source origins, supported formats, relations, annotation dependencies and data-quality summary.
- Click edge → description, cardinality, join mapping, unmatched/duplicate-reference count, referential-integrity policy.
- `Add collection`, `Connect collections`, `Propose field`, `Import suggested structure` create a **draft**; offer impact preview before review.
- Zoom, expand/collapse, filter by modality, show only problematic links. `List view` provides complete alternative and search.
- Relationships with inferred join keys show `Suggested`, and may show confidence/coverage; require confirmation before enforcement.
- No file-level giant graphs, no auto-creation of patient connections from unsafe name matching.

### 5.3 Sample relationship inspector

**Study → Volume**  
`One study may have many image volumes`  
Keys: `study_ref → study_id`  
Requirement: volume must link to an existing study before release  
Status: `3 orphaned volumes`  
Actions: `Inspect unmatched items`, `Propose mapping change`, `View lineage`.

---

## 6. Fields & Formats — physical representation and semantic meaning

**Question:** `How is each collection represented, and what shape does each item have?`

Do not make a flat column table the universal UI. Use a **collection selector** and a **format-aware inspector**.

### 6.1 Three complementary layers

1. **Logical structure:** entity types, field identities, relationships, cardinality.
2. **Physical representation:** bytes and media/file formats, dimensions, encodings, compression, channel ordering, spatial/temporal axes.
3. **Semantic meaning:** units, definitions, constraints, labels, acquisition metadata, clinical concepts, confidence/quality flags.

Example: a single logical `MRI Volume` entity can be backed by DICOM series or NIfTI; it carries orientation, voxel spacing, array shape, intensity type, and references to its study. Format conversion does not automatically redefine what a study or volume means.

### 6.2 Format-specific detail modules

| Data kind | Show by default | Advanced details |
|---|---|---|
| Table / clinical records | columns, types, nullability, unique keys, example rows (permissioned) | stable IDs, units, category values, ranges, parquet schema, encoding |
| 2D image | width × height, channels, bit depth, file type, linked record | color space, physical pixel spacing, orientation, masks |
| 3D/4D volume | dimensions with named axes, spacing, orientation, intensity type | affine transforms, coordinate convention, DICOM series mapping, time dimension |
| Video / ultrasound cine | frame count, duration, frame rate, linked study | timestamps, codecs, frame geometry, temporal annotations |
| Whole-slide imaging | pyramid levels, scan size, magnification, tissue regions | tiled image properties, microns-per-pixel, coordinate transforms |
| Text | encoding, language if known, document count, linked entities | offsets/spans, sections, schema for extracted entities |
| Timeseries | sample rate, units, channels, time domain | time zone, gaps, resampling, synchronization |
| Mask / annotation | target media, dimensions, label set, current state | classes, coordinate frame, instance-vs-semantic segmentation, interpolation |

These are plugin-provided capabilities as available, with a core fallback for unknown formats. Never claim every format is understood or auto-convertible.

### 6.3 Field inspector example

**Field:** `ventricle_volume`  
Type: decimal  
Unit: mL  
Optional: Yes  
Belongs to: `Cardiac Measurement`  
Semantic meaning: `Measured ventricular volume at a defined cardiac phase`  
Reference: `study_id`; possibly `phase` and `ventricle`  
Stable internal ID: `field_104`  
Validation: `>= 0`, finite numeric, required study linkage  
Used by: `Cardiac metrics pipeline`, `Report export`.

Allow rename, type adjustment, new constraint and unit change **as proposed edits**. Explain consequences: a label rename may be safe; changing mL to L needs a value conversion and consumer revalidation; deleting consumed fields may be breaking.

### 6.4 Example record preview

Show a *permissioned, representative sample* with provenance; let the user switch between rendered media, field summary and raw metadata where authorized. For PHI datasets, honor field redaction, no unreviewed identifiers, no raw patient directory paths and no data passed to an external AI panel.

---

## 7. Annotations — the meaning of labels and linked outputs

**Question:** `What kinds of labels, measurements and reviews can exist for these data?`

Annotation structures must not be treated as ordinary CSV columns.

Show **annotation types** and their constraints:

- Classification (single-label, multi-label, hierarchical classes).
- Bounding boxes, polygons, keypoints, masks, instance/semantic segmentation.
- 3D segmentation and spatial annotations.
- Temporal segments, frame-linked annotations, tracking.
- Text spans and extracted entities.
- Measurement outputs, with units and uncertainty if relevant.

For each type show: eligible target modalities, label ontology/version, geometric coordinate system, required metadata, reviewer policy, and allowed state transitions.

**Example ontology:** `Ventricle Segmentation` → Left ventricle / Right ventricle / Myocardium. Provide color swatches as editor affordances only; actual semantic identities must be stable label IDs, not colors or class index positions.

**Changes:** adding a new class, splitting a class, renaming a label, changing spatial coordinate conventions, or changing mask geometry creates an ontology/annotation-schema proposal. Impact preview should identify affected masks, validations, training data, exports and pipelines.

**Division of responsibility:** Datasets defines *what an annotation is*. Studio edits *individual annotations*. Review approves *proposed changes*.

---

## 8. Quality — actionable understanding, not a scorecard

**Question:** `Is this dataset internally coherent and fit for its intended work?`

Use grouped issue panels with clear severity, impact and next action:

| Category | Example | Action |
|---|---|---|
| Missing values | 18 clinical records lack diagnosis | Inspect / request completion |
| Type drift | `age` contains `unknown` | Review parsing and normalization plan |
| Identity | 7 volumes have no matching study | Inspect relationships |
| Duplicates | Same source fingerprint imported twice | Review deduplication policy |
| Geometry | Segmentation mask and MRI affine differ | Inspect spatial alignment |
| Modality | 3D MRI routed to a 2D-only plugin | Fix processing route |
| Annotation | Deprecated class still referenced | Review ontology migration |
| Compatibility | Schema update breaks two dependent steps | Inspect impact |
| Security | PHI policy check incomplete | Restrict release; request review |

**Severity** and **blocking** must be different: a warning might be visible but nonblocking under an explicit policy; sensitive-data violations must follow hard policy checks.

**Interactions:** filter to affected records; preview permitted examples; navigate to linked Studio/Review/Pipelines action; create a proposed correction; revalidate; compare quality before/after a candidate change.

**No silent coercion:** messy CSVs, changed image shapes, or malformed archives enter staged ingestion; the UI shows the proposed interpretation and the rejected/uncertain portion. A newly uploaded file never silently redefines published structure.

**Validation attribution:** every issue records rule ID/version, run ID, source snapshot, severity, affected item refs and revalidation state. If a validation rule was wrong, users can identify impacted releases and launch corrected review/backfill without mutating history.

---

## 9. History — versioning that supports the work

**Question:** `What changed, why, and can I inspect or recover an earlier version?`

Versioning exists inside each dataset, accessible through the snapshot selector and **History** subview. It is not the dominant top-level navigation model.

### 9.1 Distinguish three states clearly

- **Working draft / proposal:** editable, isolated, not yet published.
- **Approved `main`:** latest accepted version of the dataset.
- **Published release:** immutable, named/pinned snapshot suitable for downstream consumers as permitted.

The UI must distinguish a *commit*, a *branch head*, and a *published release* without requiring users to know the internals. Developers can see immutable commit IDs in an expandable detail.

### 9.2 History screen

Header: `History` + branch/snapshot selector + `Compare versions`.

Timeline rows use human titles:

- `Added 24 reviewed MRI studies`
- `Connected ultrasound exams to study records`
- `Updated ventricle segmentation labels`
- `Changed study metadata requirements`

Each row can show author, time, review ID, validation status, scope, and a short diff summary. Opening a row provides **semantic diff**, not raw JSON by default:

- Added/removed logical items and changed metadata fields.
- Field add/rename/type/constraint changes.
- Entity and relationship changes.
- Annotation class and geometry changes.
- Changed GCS object references and derivation lineage.
- Pipeline definition or plugin revision impact.
- Data-quality before/after.

Users should be able to compare two snapshots visually; highlight sample images/masks where appropriate and authorized. Provide raw metadata and immutable hashes in advanced mode.

### 9.3 Review requests from Datasets

A user proposes: `Add ejection fraction to Cardiac Measurement`.

1. Edit a draft under `Structure` or `Fields & Formats`.
2. Show suggested migration and whether an existing pipeline can produce it.
3. Run schema contracts/quality checks on a candidate snapshot.
4. Show affected data, downstream consumers, and estimate of reprocessing.
5. `Request review` sends the change to the existing **Review** tab.
6. Approvals bind to immutable proposal digest/revision and are invalidated when it changes.
7. Versioning atomically publishes an approved release after validation; pipeline runs may trigger from the published event.

A comment requesting “third row” must be disambiguated in context as adding a *record* (data change) versus a *field/column* (schema change), not blindly treated as schema evolution.

### 9.4 Conflict and rollback UX

- If `main` advanced while a draft was being prepared: `This dataset changed since you started. Compare and update your proposal.`
- Offer merge/rebase preview for supported semantic changes. Never silently overwrite another user's approved work.
- A rejected publication retains the candidate and clear diagnostic.
- Restore means propose an old snapshot as a **new approved state or pointer change**, not mutate an immutable historical snapshot.
- If a published validator was later found incorrect, mark affected releases `Needs revalidation`, show provenance and correction plan. Don't erase historical evidence.

---

## 10. Cross-view workflows

### A. User imports a messy folder

1. In **Sources**, upload folders containing DICOM, PNG and CSV; raw files go to immutable staging.
2. In **Datasets → Overview**, show `New files ready to organize` and unknown items.
3. **Structure** suggests `Study`, `Image`, `Diagnosis` collections and potential links—visibly unconfirmed.
4. **Fields & Formats** previews inferred types, dimensions, units and encodings; uncertain fields are flagged.
5. **Quality** groups malformed CSV rows, unmatched records and geometry issues.
6. User accepts/corrects a mapping; data processing uses pinned inputs and appropriate plugins.
7. Create a candidate dataset snapshot; **Review** approves; versioning publishes it.

### B. Researcher adds a new measurement

1. Open dataset → **Fields & Formats** → `Propose field`.
2. Enter display name, meaning, type, units, optional/required, collection and validation.
3. Show potential sources and producer pipeline; if no producer exists, label new field `Not yet populated` rather than fabricating values.
4. **Quality** presents compatibility impact and expected missing values.
5. Propose a revision; request approval; approved schema and data/pipeline references become part of the release.

### C. Annotation ontology changes

1. Open **Annotations**, split one class into two.
2. Show current count of masks using affected class, downstream model/export dependencies and conversion ambiguity.
3. Require explicit migration/relabel policy; ambiguous cases become review tasks.
4. Retain old ontology ID and annotations in historical snapshots.
5. Publish only after accepted checks and required approvals.

### D. A running pipeline overlaps a change

1. A run starts with dataset commit A, schema S1, pipeline P1.
2. User publishes dataset B, schema S2, pipeline P2.
3. Existing run still renders as `Using A / S1 / P1`; new ones use the configured current release.
4. If old run proposes output against stale `main`, the UI opens a reconciliation/review state instead of silently publishing.

### E. A user wants to know where a derived mask came from

1. Select a mask in dataset item preview.
2. Open `Provenance` in inspector.
3. Show source study, raw object digest, transform/plugin/model version, pipeline run, annotator/reviewer (when permitted), and publication release.
4. Jump to the relevant Studio item, pipeline run or reviewed change.

---

## 11. Data and API contracts (UI-level; proposed)

The UI must depend on authenticated `apps/api` endpoints or generated clients, **not** call Go services, Git storage, Cloud SQL, DBOS or GCS directly. Specific route names below are illustrative, not claims about shipped endpoints.

### 11.1 Read models

- `DatasetSummary`: ID, project/workspace, name, description, status, modalities, logical counts, last meaningful change, issues summary.
- `DatasetSnapshot`: dataset commit, schema version, ontology versions, pipeline revision, release ID/status, read-only flag.
- `CollectionDefinition`: ID, entity kind, display name, linked formats, fields, relationships, observed cardinalities.
- `FieldDefinition`: **stable ID**, name, type, nullability, units, constraints, semantic description, lineage/consumer refs.
- `PhysicalFormatDefinition`: modality, accepted codecs/encodings, dimensions/axes, spacing/orientation/time metadata, validation profile.
- `RelationshipDefinition`: from/to entities, cardinality, reference mapping, requiredness, matching confidence/coverage.
- `AnnotationDefinition`: geometry type, target modality, ontology/class IDs, metadata constraints, reviewer policy.
- `QualityIssue`: rule ID/version, snapshot, severity, blocking, redacted message, affected refs, suggested action.
- `DatasetChangeSummary`: source/target snapshot, semantic diff, review and validation states.
- `DatasetProvenance`: source object refs, processing run, plugin/code digest, annotation/review lineage.

All responses must be workspace/project scoped; counts/details may be redacted by permissions. Paginate large collections and issue lists, and lazy-load preview assets.

### 11.2 Proposed UI queries/actions

| Action | Server ownership |
|---|---|
| List datasets; fetch collection summaries | API/kernel + read models |
| Read dataset structure and format profiles | API backed by versioning/schema registry and inspection projections |
| Fetch sample preview or provenance | API with scoped signed/streamed access as approved |
| Evaluate schema or ontology proposal | API → pipeline compatibility/impact services |
| Save draft structure changes | API → versioning candidate/review workflow |
| List/compare snapshots/releases | API → versioning |
| Inspect quality issues; request revalidation | API → worker/pipeline |
| Approve/merge a change | Existing Review flow → versioning authority |
| Publish dataset release | API → versioning CAS publication |

Reads for a dataset detail should use a **single pinned snapshot descriptor**; don't join the latest fields from S2 with the records from S1. Server should return snapshot identifiers and ETags. Proposals carry `expected_head` and an idempotency key; conflicts are user-visible.

### 11.3 Avoid client-side backend duplication

Do not parse DICOM or compute authoritative masks in web code for publishing. Preview renderers may inspect permitted bytes for display; validation and canonical derived artifacts are produced by protected workers. Do not persist schema edits simply by updating local React state and calling them released.

---

## 12. State design, permissions, and accessibility

### 12.1 Screen states

For every view define: loading skeleton, empty, loaded, partially available, error, permission-denied, stale snapshot, offline/connection-lost, and pending proposal. A failed field-inspection plugin should degrade a single panel rather than blank the whole dataset page.

### 12.2 Permission-based affordances

- **Viewer:** browse permitted summaries, previews, published versions and quality issues.
- **Contributor:** create dataset drafts, mappings, label/schema change proposals, and remediation requests.
- **Reviewer:** approve/reject changes within their scope; approval requires immutable revision binding.
- **Publisher:** publish approved candidate releases; sensitive-data release additionally requires its own policy gate.
- **Administrator:** configure policies, retention and access, separately from everyday data editing.

These are UI concepts; enforce actual authorization on every server mutation and data access. Sensitive projects may forbid raw metadata or previews for particular users regardless of role name.

### 12.3 Accessibility

Keyboard-operable secondary nav, tables, drawers and graph node selection; screen-reader alternative to visual structure graphs; visible focus, noncolor-only warnings, readable units and field types, reduced-motion support, and large dataset virtualization without losing keyboard navigation.

---

## 13. React implementation suggestion

Fit the existing `apps/web` conventions and routing instead of introducing a new application or claiming this exact directory structure is already present:

```text
apps/web/src/studio/core/datasets/
├── DatasetsPage.tsx                 # project-level dataset list and attention
├── DatasetLayout.tsx               # dataset header, snapshot picker, tabs
├── DatasetOverview.tsx
├── structure/
│   ├── DatasetStructure.tsx
│   ├── StructureGraph.tsx
│   ├── StructureList.tsx
│   ├── EntityInspector.tsx
│   └── RelationshipInspector.tsx
├── formats/
│   ├── FieldsAndFormats.tsx
│   ├── FieldInspector.tsx
│   ├── FormatInspector.tsx
│   └── modality-panels/            # contributed/registered panels
├── annotations/
│   ├── AnnotationDefinitions.tsx
│   └── OntologyInspector.tsx
├── quality/
│   ├── DatasetQuality.tsx
│   ├── QualityIssueList.tsx
│   └── ValidationImpact.tsx
├── history/
│   ├── DatasetHistory.tsx
│   ├── SnapshotPicker.tsx
│   ├── SemanticDiff.tsx
│   ├── CompareVersions.tsx
│   └── ProvenancePanel.tsx
├── proposals/
│   ├── ProposedChangeDrawer.tsx
│   ├── CompatibilityPreview.tsx
│   └── StaleHeadResolution.tsx
└── hooks/                           # generated client and pinned-snapshot queries
```

Reuse `packages/studio-ui`, `packages/studio-renderers`, the plugin UI SDK, and established router/query infrastructure. Modality-specific modules plug into the inspector via a supported registry; **Datasets is modular without becoming an arbitrary code execution environment**.

**Ownership:** React displays and proposes; `apps/api` authorizes; `apps/versioning` stores immutable snapshots/reviews/releases; `apps/pipeline` analyzes affected consumers and coordinates processing; `apps/worker` validates/derives; `apps/agent` may suggest structure using only authorized privacy-safe summaries. The self-hosted DBOS engine never becomes a frontend concern.

---

## 14. Rollout plan

### Phase 1 — useful browsing (MVP)

- Datasets landing page; create/open dataset; Overview; collection list.
- Structure list (with simple relationship presentation, not full graph editor).
- Fields & Formats read-only inspector, modality-aware summaries from existing inspection.
- Basic Quality issues and links to existing Studio/Review.
- Pinned snapshot selector and basic human-readable history.

### Phase 2 — editable structure and Git-style proposals

- Structure graph and field/relationship editing as drafts.
- Versioned schema field IDs, annotation ontology definitions and format profiles.
- Compatibility impact preview; candidate snapshots; semantic diffs; Review integration.
- Conflict resolution, read-only releases, and atomic publication UX.

### Phase 3 — richer multimodal refinement

- Dedicated modality panels: 3D axes/affines, cine timeline, WSI pyramid, timeseries, text spans.
- Quality trend analysis and revalidation controls.
- Detailed provenance lineage and cross-dataset relationship explorer.
- Policy-aware agent suggestions for structure and normalization (never automatic publication).

### Phase 4 — advanced authoring

- Complex join mapping editor; format transforms; ontology migration previews.
- Compatibility matrices for multiple published datasets and pipeline consumers.
- Advanced release comparison, partition-aware diffs, managed bulk remediation.

Prioritize user research with nontechnical researchers: whether they understand `collection`, `field`, `format`, `connection`, `annotation`, and `release` without training is a launch criterion.

---

## 15. Acceptance criteria

1. User can tell the difference between a source file, a dataset, a study, and an annotation.
2. The default Datasets view communicates **what data exists and how it is organized**, not just how many commits it has.
3. Structure handles multiple modalities and relationships; it isn't limited to spreadsheet columns.
4. Physical file format and logical field/ontology meanings are presented separately.
5. Unknown or malformed input never silently modifies published structure.
6. Viewers can inspect a selected collection's fields, axes, formats, constraints, and provenance subject to access controls.
7. Every published snapshot is internally consistent: dataset + schema + ontology + pipeline revisions.
8. Existing pipeline consumers affected by a proposed change are discoverable and explained before publication.
9. Changing a published structure starts a proposal; approvers review the exact revision tested.
10. A concurrent edit cannot silently overwrite a newer branch head.
11. Large datasets are browsable without loading every record, file, or graph node.
12. Quality issues identify affected items, validation-rule version, impact and next action.
13. Annotation classes retain stable IDs even if their display names/colors change.
14. PHI-containing paths, field values, error traces, and examples are withheld/redacted according to the server policy.
15. Older versions remain inspectable; recovery doesn't rewrite immutable historical commits.
16. Users can navigate from a derived artifact to its source and process without exposing restricted data.
17. A plugin failure or unrecognized modality degrades gracefully to a safe generic format inspector.
18. Keyboard users can navigate every dataset subview and inspect relationships without relying on graph dragging.

---

## 16. Non-goals and design guardrails

- **Not a replacement for Sources:** raw upload sessions and connector configuration stay there.
- **Not a replacement for Studio:** pixel-level or frame-level annotation happens in Studio.
- **Not a replacement for Review:** approve/reject work in the centralized Review queue.
- **Not a Git interface:** Git terminology and hashes can be available for advanced users, never required for routine curation.
- **Not a universal schema:** collections can be heterogeneous, with optional and format-specific fields; don't force everything into one enormous relational table.
- **Not auto-publish by AI:** inference and agent-written migrations produce suggestions and test results, not trusted release mutations.
- **Not a compliance guarantee:** permission, isolation, audit, de-identification and retention behavior require backend enforcement and independent review.

**Final UX rule:** When someone opens **Datasets**, their first impression must be *“I understand my data and can improve it safely,”* not *“I'm looking at a database admin tool or Git history.”*
