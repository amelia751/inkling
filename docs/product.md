# Inkling — Technical Architecture & MVP Implementation Specification

**Status:** Proposed engineering plan, v0.1  
**Date:** 2026-10-29  
**Audience:** Inkling cofounders and implementation contributors  
**Product:** Browser-first, no-code studio for domain experts to create, annotate, validate, version, and eventually distribute high-quality datasets. **Initial vertical: medical imaging research.**

> This document describes an implementation proposal, not a claim of HIPAA compliance or medical-device clearance. The initial product must use appropriately licensed, de-identified or synthetic data; no unrestricted uploads of clinical PHI. Confirm licenses of all libraries, models, datasets, and transitive dependencies at the exact pinned versions before release.

## 1. Executive decision

Build a **React + TypeScript + Vite** browser application, with a **Cornerstone3D** imaging viewer embedded in an accessible custom UI. Use a **Python/FastAPI modular monolith**, **PostgreSQL**, **private S3-compatible object storage**, and **Redis + Dramatiq** background workers. Maintain original source images and spatial/temporal metadata. Integrate **Orthanc + DICOMweb** when robust DICOM series ingestion is needed, rather than treating Orthanc as mandatory on day one.

### Objectives

1. A nontechnical researcher can import an authorized medical imaging dataset and annotate it without writing code.
2. Another person can reproduce and load the published dataset, including annotation coordinates and source metadata.
3. The system supports 2D X-rays first and a limited 3D CT/MRI demo next, without redesigning the entire data model.
4. The system preserves the foundation for creator reviews, version history, licensing, future normalization, bundles, and commercial distribution.
5. The deployment is browser-first, but storage and processing are modular to permit future institution-hosted/private configurations.

### Explicit MVP non-goals

- Clinical diagnosis, treatment recommendations, FDA-cleared workflows, or PACS replacement.
- Direct unrestricted upload, hosting, or sale of identifiable patient data.
- Full pathology, 4D cardiac ultrasound, real-time video, and ECG support all at once.
- A multi-tenant health-data enterprise deployment claimed to be HIPAA-compliant before an appropriate security/legal program exists.
- A completed payments marketplace, cross-creator payout allocation, or an enterprise bundling engine.
- Training custom medical foundation models in v0.

## 2. Medical data families and interface adapters

| Family | Typical assets | Viewer UI | Annotation examples | Initial priority |
|---|---|---|---|---|
| 2D imaging | X-ray DICOM, PNG, JPEG, retinal images | Zoom, pan, window/level (DICOM), image stack | Classification, boxes, polygons, 2D masks | **P0** |
| 3D volumes | CT/MRI DICOM series, NIfTI, NRRD | Axial/sagittal/coronal orthographic views, slice scrolling | Volume segmentation, 3D regions, measurements | **P1** |
| 2D + time | Cine cardiac MRI, ultrasound, endoscopy | Frame timeline, play/pause, frame-specific labels | Per-frame contours, temporal events | P2 |
| 3D + time (4D) | Dynamic cardiac MR/3D echo | Volume viewer plus time scrubber | Time-indexed 3D masks | P3 |
| Whole-slide pathology | SVS, OME-TIFF, DICOM WSI | Tile-based pan/zoom at multiple resolutions | Tissue regions, cells, counts | P2/P3 |
| Signals/clinical tables | ECG, waveform, CSV | Waveforms, structured forms | Interval markers, events, labels | Later |

**Product rule:** the creator chooses a task (e.g., “mark abnormal areas”), not a coordinate system, serialization format, or library. The system auto-detects data type and boots an **environment** for it. Medical families are first-class but are *presets*, not hardcoded code paths: the same platform boots non-medical data (shelf photos, drone video, sensor CSV, satellite tiles) from environment JSON alone.

**Module contract:** modules share a dataset/annotation API (the studio store, core geometries, the runtime context), not a universal renderer. Each module ships its own renderer for its data family and contributes tools, commands, panels, inspectors and exporters around it; the shell never knows which renderer is mounted. See `docs/modules.md`.

## 3. Technology stack

### 3.1 Frontend

| Function | Selection | Why |
|---|---|---|
| Runtime | TypeScript + React + Vite | Interactive SPA, strong imaging ecosystem, easy deployment |
| Package management | pnpm | Reproducible monorepo and shared packages |
| Styling | Tailwind CSS + shadcn/ui + Radix primitives | Accessible, customizable UI; keep clinical workstation complexity hidden |
| Router | React Router | App navigation and nested studio routes |
| Server state | TanStack Query | Query caching, mutation and invalidation |
| Local UI state | Zustand | Viewer/tool selection, annotation drafts; never store entire volumes in React state |
| Forms | React Hook Form + Zod | Guided creator workflows, shared input validation |
| Medical rendering | `@cornerstonejs/core`, `@cornerstonejs/tools` | GPU rendering, annotation and segmentation |
| DICOM decoding | `@cornerstonejs/dicom-image-loader` | DICOM P10 / DICOMweb image loading |
| NIfTI rendering | `@cornerstonejs/nifti-volume-loader` | Research volume loading (P1) |
| Conversion helpers | `@cornerstonejs/adapters` (if required) | Interchange/annotation adapters; test current API and support |
| 3D segmentation helpers | `@icr/polyseg-wasm` (optional) | Only when polygon/labelmap conversion is required |
| Whole-slide imaging | OpenSeadragon (later) | Tiled high-resolution pathology images |
| Tests | Vitest + Testing Library + Playwright | Unit, component, and browser tests |
| API typings | Generated TypeScript client from FastAPI OpenAPI | Avoid manual type drift |

**Package installation sketch** (resolve a compatible tested set, lock versions, check browser/WebGL constraints):

```bash
pnpm add react react-dom react-router-dom @tanstack/react-query zustand \
  react-hook-form zod @hookform/resolvers
pnpm add @cornerstonejs/core @cornerstonejs/tools \
  @cornerstonejs/dicom-image-loader
# P1: pnpm add @cornerstonejs/nifti-volume-loader
# Optional: pnpm add @cornerstonejs/adapters @icr/polyseg-wasm
pnpm add -D typescript vite @vitejs/plugin-react vitest \
  @testing-library/react @playwright/test eslint prettier
```

Use actual shadcn CLI generation for UI primitives, rather than assuming every shadcn component comes from a single packaged UI dependency. Verify a compatible Tailwind configuration.

**Viewer design: modules, environments, presets.** Do **not** fork OHIF; copy its extension/mode pattern (and VS Code `contributes` + `when`, Label Studio `name`/`toName`, JupyterLab `requires`). Cornerstone3D remains the SDK for radiology renderers.

- **Extension host** (`apps/web/src/extension-host/`, contract in `packages/plugin-ui-sdk`): module contract, registry, environment schema (zod), resolver with structured errors, `when`-clause evaluator, runtime context, command registry, agent catalogue. No domain code.
- **Kits** (`kits/`): domain-neutral building blocks: 2D vector overlay, viewport chrome, timeline, file I/O (NIfTI, DICOM, WFDB, video), Cornerstone glue.
- **Modules** (`plugins/<name>/ui/`): a pure-data `manifest.ts` plus a lazy `load()` returning implementations keyed by contribution id. Contributions are addressed `<module>.<type>.<name>`, e.g. `inkling.wsi.renderers.osd`.
- **Environments**: JSON documents (seed manifest, `registry/presets/*.json`, or agent-written) that pick modules and configure them. Validated against a JSON Schema generated from the live registry.

```ts
// packages/plugin-ui-sdk/src/module.ts (abridged)
export interface ModuleManifest {
  id: string; version: string; title: string; description: string;
  requires?: string[];
  contributes: { dataKinds?; renderers?; geometries?; tools?; commands?; panels?;
                 inspectors?; exporters?; labelControls?; reviewRules?; presets? };
  load?: () => Promise<ModuleImpl>;          // renderers, panels, inspectors, exporters
}

// An environment: medical presets are just `extends`.
{ "extends": "preset:pathology",
  "labels": [{ "name": "tissue", "control": "PolygonLabels", "classes": [{ "id": "tumor", "color": "#e66" }] }] }
```

`ViewerAdapter`/`ViewerKind` (the earlier proposal) are retired; the six original viewers became the presets `image-2d`, `volume-3d`, `ecg`, `video`, `cine-4d` and `pathology`.

### 3.2 Backend and workers

| Function | Selection | Purpose |
|---|---|---|
| API | Python 3.12+ + FastAPI | Authenticated application API and OpenAPI schema |
| Validation | Pydantic v2 | Request, response, dataset schema validation |
| ORM | SQLAlchemy 2 + Alembic | Database access and migrations |
| Database | PostgreSQL | Users, tenants, access, projects, metadata, labels, versions, reviews |
| Background queue | Redis + Dramatiq | Ingest, scan, thumbnails, export and validation |
| Object storage | S3-compatible private bucket | Raw files, derived imagery, masks, exports |
| Image metadata | pydicom | DICOM study/series/instance parsing |
| Volumes/transforms | SimpleITK | Image orientation, spacing, conversion and transforms |
| NIfTI | NiBabel | NIfTI files, affine/coordinate metadata |
| Arrays | NumPy | Processing and validation |
| Medical models | MONAI / PyTorch (later) | Optional segmentation/AI assistance; isolated worker |
| DICOM archive | Orthanc + DICOMweb plugin (P1) | Standards-based DICOM studies and image retrieval |
| Tests/lint | pytest, pytest-asyncio, httpx, Ruff, mypy | Tests and static checks |
| Observability | OpenTelemetry + error reporting | Traces, failures, job metrics without exposing PHI |
| Agent runtime | **Node + pi** (`apps/agent`, TypeScript) with Daytona sandboxes | The Inkling AI agent loop, tools and approvals; a private service only the API (dev: the Vite proxy) talks to. See `agent.md` |

The API, validation and workers stay Python/FastAPI. Only the agent runtime is Node: pi is a TypeScript harness, so it shares wire types with `apps/web` (`@studio/agent-protocol`) and keeps model keys and sandbox credentials server-side.

**Python dependencies sketch:**

```bash
uv add fastapi 'uvicorn[standard]' pydantic pydantic-settings \
  sqlalchemy alembic 'psycopg[binary]' redis dramatiq boto3 \
  pydicom SimpleITK nibabel numpy python-multipart
uv add --dev pytest pytest-asyncio httpx ruff mypy
# Later, in a separately managed inference environment:
# uv add monai torch
```

Use version constraints and lockfiles (`uv.lock`, `pnpm-lock.yaml`) in the repo. Production images should be built from pinned dependencies and scanned. Native SimpleITK packages, codecs, and optional PyTorch can significantly increase container size; separate inference workloads rather than placing all model dependencies in the API image.

### 3.3 Optional components, not default MVP dependencies

- **Orthanc:** DICOM archive and DICOMweb endpoint for robust study handling; isolate behind authenticated proxy and verify its licensing and plugin versions before shipping.
- **OpenSeadragon:** whole-slide image viewer when pathology is actually prioritized.
- **MONAI Label:** investigate for assisted segmentation, but keep inference behind a generic `InferenceProvider` contract.
- **Stripe Connect / identity verification:** defer until commercial marketplace payments are in scope.
- **pgvector / search service:** not required to prove creator usability; PostgreSQL text search suffices initially.
- **Kubernetes / Kafka / separate Go service:** avoid at MVP stage.

## 4. Monorepo layout

```text
inkling/
├── docs/product.md                   # This specification
├── README.md
├── pnpm-workspace.yaml
├── package.json
├── pnpm-lock.yaml
├── pyproject.toml                    # uv workspace, or per-app Python project
├── uv.lock
├── .env.example
├── .gitignore
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── security.yml
│       └── deploy.yml
├── apps/
│   ├── web/                          # React + Vite
│   │   ├── index.html
│   │   ├── vite.config.ts
│   │   ├── public/
│   │   └── src/
│   │       ├── app/                  # Router, providers, entrypoint
│   │       ├── pages/                # Projects, studio, datasets, review
│   │       ├── features/
│   │       │   ├── auth/
│   │       │   ├── datasets/
│   │       │   ├── uploads/
│   │       │   ├── annotation/
│   │       │   ├── reviews/
│   │       │   └── publishing/
│   │       ├── studio/               # Shell: app/ (routes), components/, stores/, lib/, styles/
│   │       │   └── core/             # Built-in Studio contributions (files, labels, select, pan…), not a plugin
│   │       ├── extension-host/       # Registry, resolver, when, commands, catalogue, agent tools, host API binding
│   │       │   ├── agent-panels/     # Tier 2 declarative + tier 3 sandboxed agent UI
│   │       │   └── bundled.ts        # The one place that lists bundled plugins
│   │       ├── main.tsx
│   │       └── server-entry.ts       # What the dev server and emit-schemas load through Vite SSR
│   ├── api/
│   │   ├── Dockerfile
│   │   └── app/
│   │       ├── main.py
│   │       ├── core/                  # Config, auth, permissions, logging
│   │       ├── db/                    # SQLAlchemy models, session, migrations
│   │       ├── modules/
│   │       │   ├── accounts/
│   │       │   ├── organizations/
│   │       │   ├── projects/
│   │       │   ├── assets/
│   │       │   ├── studies/
│   │       │   ├── annotation/
│   │       │   ├── ontologies/
│   │       │   ├── review/
│   │       │   ├── versions/
│   │       │   └── exports/
│   │       ├── integrations/
│   │       │   ├── object_storage.py
│   │       │   ├── dicomweb.py
│   │       │   └── queue.py
│   │       └── tests/
│   └── worker/
│       ├── Dockerfile
│       ├── main.py
│       ├── jobs/
│       │   ├── ingest.py
│       │   ├── scan.py
│       │   ├── preview.py
│       │   ├── validate.py
│       │   ├── deidentify_check.py
│       │   ├── export.py
│       │   └── conversion.py
│       ├── imaging/
│       │   ├── dicom.py
│       │   ├── nifti.py
│       │   ├── geometry.py
│       │   └── thumbnails.py
│       └── tests/
├── packages/
│   ├── contracts/             # Canonical types, environment schema, migrations, naming config
│   ├── plugin-ui-sdk/                # Module contract, resolved-env types, runtime bus, host API (useHost)
│   ├── ui/                    # shadcn components, icons, cn(), key and shortcut display
│   └── renderers/             # Trusted renderers and kits: cornerstone, overlay2d, timeline, viewport-chrome, io
├── plugins/                          # First-party plugins: <name>/ui (image2d, volume, timeseries, video, cine,
│                                     #   cardiac-metrics, wsi, text-spans, dicom-export, _template)
├── registry/
│   └── presets/                      # Workspace templates (environment JSON)
├── schemas/                          # Emitted JSON Schemas, catalogue and naming.json
├── infra/
│   ├── docker-compose.yml
│   ├── docker-compose.dicom.yml       # Optional Orthanc
│   ├── db/
│   └── deploy/                        # Provider-specific infrastructure later
├── docs/
│   ├── architecture/
│   ├── data-model/
│   ├── security/
│   ├── licensing/
│   └── runbooks/
├── fixtures/
│   ├── synthetic-dicom/
│   ├── public-research/
│   └── annotations/
└── scripts/
    ├── seed_dev.py
    ├── verify_exports.py
    └── check_licenses.sh
```

**Monorepo rule:** Python business logic and data schemas remain server-side. Do not share a Python internal ORM model as a frontend contract; generate an API client from OpenAPI. Prefer a modular monolith over services until organizational or scaling pressures demand otherwise.

## 5. End-to-end creation flow

```text
Creator signs in
  ↓
Create project and select medical task
  ↓
Choose files + attest rights/authorized use
  ↓
API creates upload session (size/type/quota checks)
  ↓
Browser uploads directly to quarantined private object storage
  ↓
Worker validates integrity, type, DICOM metadata, safety/privacy flags
  ↓
Accepted assets are indexed; viewer adapter selected automatically
  ↓
Creator annotates, reviews, saves drafts
  ↓
Reviewer flags examples; creator fixes; changes are auditable
  ↓
Publisher selects license/visibility and requests validation
  ↓
Worker builds immutable dataset version + manifest + exports
  ↓
Authorized users download supported output package
```

**Never** automatically publicize an uploaded DICOM study immediately after parsing. Validation, authorization, and publication are distinct stages.

### Upload and processing safeguards

- Use multipart/resumable upload for large files; short-lived, scoped signed URLs.
- Verify files by content/type and checksums, not extension alone.
- Store raw assets in a quarantine prefix until policy checks complete.
- Protect the service from decompression bombs, oversized pixel data, malformed archives, and overlong background jobs.
- Do not log raw patient tags, image pixels, signed URLs, or PHI.
- Make imports and exports idempotent; add retry and dead-letter handling.
- Give users clear “processing / needs review / ready” statuses.
- Apply per-user and per-project storage and compute budgets; never offer unlimited free model inference.

## 6. Core data model

### Entities

- `User`: auth subject and profile; external identity provider ID.
- `Organization`: organization with memberships and RBAC roles.
- `Project`: owner, modality, task, dataset purpose, permitted data policy.
- `Asset`: immutable raw binary, SHA-256 digest, MIME/type, storage key, rights declaration, metadata.
- `Study` and `Series`: DICOM-native groupings where applicable; patient pseudonym scoped to authorized project.
- `Sample`: annotatable unit; points to asset/study/series/frame as needed.
- `Ontology`: named/versioned label definitions, descriptions, allowed relations.
- `Annotation`: creator or model label and geometry, coordinate frame, target sample, time index and provenance.
- `ReviewIssue`: sample/annotation-specific concern, status, assignee, comments.
- `DatasetVersion`: immutable manifest tying asset hashes, ontology versions, accepted annotations, export artifacts.
- `AuditEvent`: append-only changes to permissions, annotation approvals and publication status.
- `Export`: output format, job status, artifact key, checksum and validation result.
- `LicenseGrant` (future): rights, distribution scope, sublicensing, commercial bundling, territory and revocation terms.

### Geometry conventions

Support a discriminated union of:

- `classification` — label applying to sample/study/image.
- `box2d` — bounding rectangle associated with a frame/image.
- `polygon2d` — coordinate sequence with frame reference.
- `mask2d` — binary or multi-label pixel mask in referenced image coordinates.
- `mask3d` — volume mask with affine transform/voxel spacing/orientation.
- `measurement` — distance/angle/region-derived metric with units.
- `temporal_event` (later) — interval/frame-index reference.

For medical images, preserve **original DICOM UIDs where authorized, frame-of-reference identifiers, pixel spacing, slice direction/orientation, NIfTI affine, units, and time coordinates**. Normalization must never silently replace physical coordinates with only arbitrary pixel locations.

### Example internal annotation contract

```json
{
  "id": "ann_123",
  "project_id": "proj_1",
  "sample_id": "sample_20",
  "ontology_version_id": "ont_v3",
  "label_code": "left_ventricle",
  "geometry": {
    "type": "mask3d",
    "asset_id": "mask_80",
    "coordinate_system": "image_physical",
    "frame_of_reference_id": "frame_22"
  },
  "provenance": {
    "created_by": "user_1",
    "method": "human",
    "review_state": "draft"
  }
}
```

This is **Inkling internal JSON**, not DICOM SEG. Write and test explicit converters rather than describing proprietary annotations as medical standards.

## 7. API design (initial endpoints)

```text
GET    /v1/health
GET    /v1/me
POST   /v1/projects
GET    /v1/projects/{project_id}
POST   /v1/projects/{project_id}/upload-sessions
POST   /v1/upload-sessions/{session_id}/complete
GET    /v1/projects/{project_id}/assets
GET    /v1/assets/{asset_id}
GET    /v1/projects/{project_id}/samples
GET    /v1/samples/{sample_id}/annotations
POST   /v1/samples/{sample_id}/annotations
PATCH  /v1/annotations/{annotation_id}
POST   /v1/annotations/{annotation_id}/submit
POST   /v1/annotations/{annotation_id}/review
POST   /v1/review-issues
GET    /v1/projects/{project_id}/review-issues
POST   /v1/projects/{project_id}/versions
GET    /v1/projects/{project_id}/versions
POST   /v1/versions/{version_id}/exports
GET    /v1/exports/{export_id}
```

API invariants:

- Every project, asset, sample and annotation read/write is checked against organization/project permissions on the server.
- Use cursor pagination for samples, annotations, and reviews.
- Use optimistic concurrency (`version`/ETag or `If-Match`) for annotation edits to avoid silent overwrites.
- Use signed asset download URLs only after server-side authorization; short expiry and restricted methods.
- Store an annotation's author/model identity and edit history; never allow silent replacement of published versions.
- Validate request sizes, masks, labels and geometry; don't trust browser checks alone.

## 8. Exports, quality checks and reproducibility

### MVP exports

1. **2D classification:** image references + label CSV/JSONL + dataset card.
2. **2D shapes:** image files and geometry JSON with explicit coordinate conventions; provide COCO-compatible exports only where the mapping is accurate.
3. **3D masks (P1):** NIfTI or NRRD with source spatial metadata and manifest; DICOM SEG later with a dedicated standards-compliant exporter.
4. **Manifest:** source checksums, dataset version, ontology version, annotator/reviewer provenance, known limitations, license and rights documentation.

### Validation checks

- Missing or invalid labels; corrupted or unreadable files.
- Conflicting ontology labels and unsupported values.
- Duplicate bytes and visually near-duplicate candidates (flag, not auto-delete).
- Volume shape, affine consistency, orientation, spacing and masks aligned with source.
- DICOM series ordering and incomplete studies.
- Leakage warnings when the same patient/study appears across data splits; derive safe pseudonymous grouping IDs when permitted.
- License/authorization completeness before publication.
- Review status and human-confirmed corrections.

**Important:** structural validity does not equal clinical truth. Human and qualified independent review remain separate from automated quality checks. Avoid asserting clinical correctness or medical safety based on crowdsourced ratings alone.

## 9. Medical privacy, trust, and legal boundaries

### Initial permissible data policy

- Allow **synthetic datasets** or **licensed, de-identified public research datasets** under verified use terms.
- Do not assume public download permission gives redistribution, commercial, or model-training rights.
- Restrict uploads of PHI until policies, security controls, contracts, and any necessary HIPAA agreements are in place.
- Ask creators to attest the legal right to contribute, annotate, publish and license each dataset; verify where feasible.

### Controls to implement early

- Auth via OIDC; server-enforced project RBAC.
- HTTPS and encryption at rest; private buckets; server-side access control.
- Tenant-scoped storage keys and authorization independent of any client-supplied IDs.
- Audit records for downloads, exports, review, publication and access changes.
- Logging redaction; no sensitive image pixels or metadata in telemetry.
- DICOM metadata de-identification checks and detection/review of burned-in identifiers; **do not claim automated checks guarantee de-identification**.
- Secret management, dependency scanning, regular backups, retention and deletion workflows.
- Rate limiting, per-user storage and inference budgets, abuse reporting.
- Controlled public reviews with sample-level issue references that do not reveal restricted data.

For future ePHI deployments, seek security/legal review and applicable BAAs with service providers. Public SaaS, private cloud and locally deployed browser clients may share a frontend, but are different trust environments.

## 10. Browser vs desktop deployment

**Default: browser.** Minimizes installation friction for research users, supports immediate iteration, and enables self-service onboarding.

Support these possible operational modes over time:

1. **Managed cloud:** approved datasets upload to Inkling-controlled infrastructure.
2. **Browser-local preview:** where feasible, decode/annotate without transmitting originals; document what is transmitted for account, telemetry, or AI features.
3. **Institutional/private deployment:** identical studio UI backed by organization-approved compute/storage/DICOM archive, requiring separately validated security and administration.

Avoid building a desktop application unless field tests show a real need for offline workflows, unusual hardware access, or local-only processing that the browser cannot adequately deliver.

## 11. Implementation milestones

### Milestone 0 — Foundation

- Set up pnpm + Python uv project, devcontainers or Docker Compose, CI, formatting and tests.
- Local PostgreSQL, Redis, S3-compatible dev storage; test fixtures with no PHI.
- Managed-auth integration and project RBAC.
- Define the first ontology and annotation schema, document data rights policy.

**Exit:** two developers can clone repo and run the stack; a signed-in user can create a private project.

### Milestone 1 — First 2D dataset

- Upload DICOM image / PNG / JPEG.
- File validation and preview generation.
- Embedded Cornerstone-based 2D viewer.
- Classification and bounding-box labeling.
- Persist drafts, retrieve annotations, basic export.

**Exit:** a nontechnical tester independently annotates a small approved image collection and an engineer loads the exported data.

### Milestone 2 — Quality and publication

- Dataset card and licensing metadata.
- Immutable version manifest; download/export.
- Sample-level review issues and correction history.
- Basic data integrity and duplicate checks.

**Exit:** another user can reproduce the same exported dataset version and inspect its corrections.

### Milestone 3 — 3D medical imaging proof

- Accept a carefully selected NIfTI volume / DICOM series.
- Orthographic planes and slice navigation.
- One narrow 3D annotation type with correct source-space mapping.
- Export a correctly aligned mask; independent technical validation.
- Add Orthanc and DICOMweb if required for reliable DICOM study streaming.

**Exit:** a medical ML practitioner verifies image/mask alignment, scale/orientation and re-import success.

### Milestone 4 — Commercial discovery (after product validation)

- Conduct expert interviews and usability sessions.
- Establish buyer demand for specific classes of datasets.
- Explore paid licensing and buyer/seller feedback with legal review.
- Only then design revenue-sharing commissions and portfolio bundling.

## 12. Testing strategy

| Layer | Tests |
|---|---|
| Frontend | Component tests; accessibility; upload wizard state; annotation-tool state |
| Imaging | Known-good DICOM stack load; window-level; image flip/orientation; NIfTI affine and volume alignment |
| API | Tenant isolation, malformed payloads, pagination, optimistic concurrency, download authorization |
| Workers | Corrupt files, malicious archives, memory/timeout budgets, idempotent retries, partial failures |
| Exports | Golden-fixture comparison; reimport; hash stability; mask/source alignment |
| Security | Auth bypass attempts, cross-project IDOR, signed URL expiry, logging redaction, upload content validation |
| User experience | Observed nontechnical labeling tasks, time to first completed dataset, errors, help requests |

Use small synthetic fixtures in CI and keep any licensed clinical research fixtures out of public repositories unless redistribution is explicitly authorized.

## 13. Metrics that matter initially

- Time from signup to first successfully exported dataset.
- Share of nontechnical testers completing the workflow unaided.
- Number of blocking errors per 100 imported files.
- Export re-import success and annotation alignment accuracy.
- Percentage of datasets with complete required metadata/rights attestations.
- Human-review disagreement and resolution rates.
- Compute and storage cost per successfully completed dataset.

Do **not** optimize GMV, marketplace take rate, or frontier-lab procurement before the initial workflow proves useful.

## 14. Open architectural decisions

1. **First dataset/task:** chest X-ray classification versus 2D lesion bounding boxes; choose after interviewing users.
2. **DICOM storage:** direct object storage for first single images versus Orthanc from the start for series-heavy use.
3. **Auth provider:** select based on deployment requirements, pricing, and future institutional SSO.
4. **Browser-local processing:** assess size ceilings, memory pressure, WebGL support and caching risks for the chosen modality.
5. **Medical review:** determine the required reviewer credentials for each task without treating credentials as a universal substitute for dataset quality.
6. **Licensing:** define upload/annotation ownership, publication grants, commercial reuse, derivative works and eventual bundling permissions with counsel.
7. **Inference economics:** add models only after measuring how much they improve throughput and quality relative to cost.

## 15. Reference documentation and license checks

These are starting points, not a substitute for checking exact dependency versions and commercial redistribution conditions.

- Cornerstone3D installation: https://www.cornerstonejs.org/docs/getting-started/installation/
- Cornerstone3D concepts: https://www.cornerstonejs.org/docs/getting-started/scope/
- Cornerstone3D source: https://github.com/cornerstonejs/cornerstone3D (MIT reported in repository/package metadata)
- OHIF documentation: https://docs.ohif.org/ ; source: https://github.com/OHIF/Viewers (MIT)
- OHIF DICOMweb integration: https://docs.ohif.org/configuration/datasources/dicom-web/
- Orthanc: https://www.orthanc-server.com/ (review core/plugin licenses and deployment obligations)
- OpenSeadragon: https://openseadragon.github.io/ (BSD-3-Clause)
- FastAPI: https://fastapi.tiangolo.com/
- SQLAlchemy: https://docs.sqlalchemy.org/
- pydicom: https://pydicom.github.io/
- NiBabel: https://nipy.org/nibabel/
- SimpleITK: https://simpleitk.org/
- MONAI Label: https://monai.io/label.html (optional; check model licenses separately)
- DICOM standard: https://www.dicomstandard.org/
- HHS HIPAA de-identification guidance: https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html
- HHS cloud/BAA guidance: https://www.hhs.gov/hipaa/for-professionals/faq/2075/may-a-hipaa-covered-entity-or-business-associate-use-cloud-service-provider-that-stores-ephi/index.html

---

**Founder principle:** Inkling should make medical dataset creation straightforward for experts who do not know machine learning, while preserving rigorous technical provenance, reproducibility, privacy controls, and exportability underneath the interface.
