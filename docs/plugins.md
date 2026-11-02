# Plugin Infrastructure — Agent-Extensible Data Studio

**Status:** Proposed architecture / implementation specification  
**Scope:** Studio kernel, plugin packages, Python agent harness, frontend contributions, plugin registry, sandboxed authoring, lifecycle, and security  
**Primary principle:** *The studio is a stable workbench; domain-specific capabilities are installed, composed, updated, and (when necessary) authored as plugins by an agent.*

## 1. Product contract

A user can say:

- “Add image segmentation with Meta SAM 3.1.”
- “Make segmentation available on my image toolbar.”
- “Use a self-hosted segmenter instead of Meta’s API.”
- “Extend segmentation to videos and let me correct masks.”
- “Build me a microscope-image workspace with cell masks, labels, and exports.”

The **Studio Builder Agent** interprets this as a request to change a **workspace configuration and its installed extension set**, not a request to rewrite shared production app code. It should inspect existing capabilities; discover, install, configure, and compose vetted plugins; and invoke a sandboxed coding worker only if no existing module meets the requirement. Activation is versioned and reversible.

A plugin can contribute tools, skills, providers, commands, UI contributions, event hooks, data-format handlers, jobs, and exporters. A plugin is **not** necessarily one model: a segmentation plugin may support multiple model providers.

### 1.1 Non-goals (MVP)

- Arbitrary npm packages executing in the main browser origin.
- User-generated code deployed into shared API processes.
- Auto-installation from arbitrary URLs without policy checks.
- A general marketplace with billing and third-party payouts.
- Perfectly generic editors for every conceivable modality.
- Agent autonomy that bypasses installation approval or budgets.

### 1.2 Invariants

1. **Kernel owns trust.** Identity, permissions, secrets, persistence, auditing, extension loading, jobs, events, and versioning stay in the kernel.
2. **Plugins own domain behavior.** They register capabilities against documented contracts and cannot modify kernel internals.
3. **One capability, many callers.** UI, agent, workflows, and API clients all use the same authorized command path.
4. **One output model.** Provider-specific outputs are normalized into studio-owned annotation/artifact schemas.
5. **No ambient privileges.** Plugins receive narrowly scoped capabilities, never raw tenant credentials or unrestricted DB/network access.
6. **Repeatable activation.** Every workspace installation is pinned to an immutable artifact/version and config revision.
7. **Safe failure.** A crashed plugin fails its own action, not the studio; rollback preserves data.
8. **User controls material changes.** Installing code, enabling new egress, or raising spend requires explicit approval.

## 2. Mental model: Claude Code plugins × IDE extensions × data workbench

| Construct | Role | Example |
|---|---|---|
| Plugin | Installable distribution unit | `studio.segmentation` |
| Capability | Semantic action contract discoverable by callers | `image.segment` |
| Tool | Executable, typed action accessible to agent/API/UI | `segment_objects` |
| Skill | Markdown instructions explaining when/how agent uses tools | `skills/segment-image/SKILL.md` |
| Provider | Implementation/backend for a capability | Meta SAM API, local SAM |
| UI contribution | Toolbar action, panel, viewer, editor, inspector | Mask refinement panel |
| Hook | Event subscription with explicit permissions | `asset.ingested` → enqueue job |
| Job | Durable asynchronous operation | Segment 10,000 images |
| Workspace installation | Version-pinned activation with tenant config | SAM enabled in workspace A |

**Important:** Skills describe behavior; they do not grant authority. Tool schemas describe callable interfaces; runtime policy grants authority. UI contributions should preferably be **declarative** and rendered by trusted components.

## 3. System architecture

```text
                          USER (chat / command palette / UI)
                                        |
                             Studio Builder Agent
                     discover -> plan -> request approval -> apply
                          |                         |
                     Plugin Catalog             Code Sandbox
                    + Capability Index       (only if needed)
                          |                         |
                          +------ Package Validator-+
                                        |
                           Workspace Install Manager
                                        |
           +----------------------------+---------------------------+
           |                            |                           |
    Studio UI Host                Tool/Job Gateway             Event/Hook Bus
    trusted renderers             permissions & budgets       bounded subscriptions
           |                            |                           |
    UI contributions             Python plugin worker           async work
           |                            |                           |
           +------------------- Studio Kernel ---------------------+
                 assets, annotations, auth, audit, secrets, jobs,
                  versions, datasets, workspace state, exports
                                        |
                             Model Provider Adapters
                            Meta API / local / other
```

**Control plane:** registry, dependencies, installation, approvals, configuration, versioning, updates.  
**Data plane:** execution of tool calls, jobs, providers, artifact reads/writes, UI interactions.  
Keep these separate so a segmentation job does not need installer privileges.

## 4. Recommended monorepo layout

```text
studio/
├── apps/
│   ├── web/                          # React application
│   │   └── src/
│   │       ├── studio/              # stable shell, layouts, surfaces
│   │       ├── extension-host/      # slots, command palette, safe renderers
│   │       └── components/          # trusted canvas, masks, timeline, forms
│   ├── api/                          # Python API/control plane
│   │   └── src/
│   │       ├── kernel/              # auth, assets, annotations, events, jobs
│   │       ├── plugins/             # catalog, resolver, installer, policy
│   │       ├── agents/              # orchestrator and builder harness
│   │       └── routes/
│   └── worker/                       # job workers and plugin executors
├── packages/
│   ├── plugin-sdk/                   # typed Python SDK; no privileged access
│   ├── contracts/             # JSON Schemas + shared types
│   ├── plugin-ui-sdk/                # TS types; declarative contribution API
│   └── renderers/             # trusted image/video/audio/document UI
├── plugins/
│   ├── segmentation/                # first-party reference plugin
│   ├── transcription/
│   └── export-coco/
├── registry/                         # curated package metadata and index
├── schemas/                          # versioned platform schemas
├── docs/
│   ├── plugins.md                    # this document
│   ├── agents.md
│   └── security.md
└── infra/                            # workers, storage, queue, secrets
```

**Do not place every plugin implementation in `/api`.** The API owns stable contracts and installation endpoints. Plugin source lives in separate workspaces, packages, or registries; runtimes load pinned artifacts into isolated workers. First-party plugins may live in `plugins/` in the monorepo for development.

## 5. Package specification

### 5.1 Package layout

```text
plugins/segmentation/
├── plugin.yaml                       # manifest and permissions
├── README.md
├── pyproject.toml                    # pinned Python dependencies
├── uv.lock                           # exact reproducible environment
├── skills/
│   └── segmentation/SKILL.md
├── src/studio_segmentation/
│   ├── __init__.py
│   ├── tools.py                      # registered tool entrypoints
│   ├── providers/
│   │   ├── base.py
│   │   ├── meta_sam.py
│   │   └── local_sam.py
│   └── normalize.py                  # masks -> studio annotation schema
├── ui/
│   └── contributions.json            # action/panel descriptors
├── migrations/                       # optional scoped plugin-owned state
├── tests/
│   ├── test_contracts.py
│   ├── test_provider_mock.py
│   └── test_permissions.py
└── fixtures/
    └── sample_image.png
```

### 5.2 Manifest example (proposed studio schema, not Meta's API)

```yaml
schemaVersion: studio.plugins/v1
id: studio.segmentation
name: Segmentation
version: 1.0.0
publisher: studio
license: Apache-2.0              # plugin CODE license, not underlying model license
compatibility:
  studio: ">=0.1.0 <1.0.0"
  pluginApi: "^1"

capabilities:
  - id: image.segment
    inputSchema: schemas/segment-request.json
    outputSchema: schemas/segment-result.json
    tool: segment_objects
    mediaTypes: [image/png, image/jpeg, image/webp]

runtime:
  kind: python-worker
  entrypoint: studio_segmentation.tools:register
  maxExecutionSeconds: 180
  concurrency: 4

providers:
  - id: meta.sam-3.1
    implements: [image.segment]
    configSchema: schemas/meta-config.json
    secrets: [META_MODEL_API_KEY]
  - id: local.sam
    implements: [image.segment]
    configSchema: schemas/local-config.json

ui:
  contributions: ui/contributions.json

skills:
  - skills/segmentation/SKILL.md

permissions:
  required:
    - assets.read
    - annotations.write
    - jobs.create
  optional:
    - network.egress:dev.meta.ai
    - secrets.use:META_MODEL_API_KEY

resources:
  defaultBudgetUsdPerJob: 1.00
  maxImagesPerJob: 1000

events:
  subscribes: []
```

All file paths in a manifest are relative to the immutable package root. Validate against a strict schema; reject unknown privileged fields rather than silently interpreting them. Explicitly distinguish code license, model license, and provider service terms in the catalog.

### 5.3 UI contributions example

```json
{
  "toolbarActions": [
    {
      "id": "segmentation.segment-selection",
      "surface": "image.viewer.toolbar",
      "title": "Segment",
      "command": "studio.segmentation.segment_objects",
      "visibleWhen": {"assetMediaType": ["image/png", "image/jpeg", "image/webp"]}
    }
  ],
  "panels": [
    {
      "id": "segmentation.mask-review",
      "surface": "annotation.inspector",
      "renderer": "studio.mask-review.v1",
      "dataBinding": "annotations.currentSelection"
    }
  ]
}
```

In MVP, `renderer` names MUST refer to trusted, precompiled UI components. A plugin supplies descriptors and data, not arbitrary React code. Later, consider isolated iframe-based UI extensions with a message API, origin isolation, CSP, and explicit permissions. Do not evaluate runtime-generated JavaScript in the host page.

## 6. Kernel: minimum stable APIs

The kernel offers versioned interfaces only:

- **Asset API:** read asset metadata, request short-lived signed URLs, create derived artifacts.
- **Annotation API:** write masks, boxes, polygons, labels, tracks, provenance, review states.
- **Command API:** dispatch validated capability calls with subject, workspace and policy context.
- **Job API:** enqueue, pause/cancel, progress, retries, idempotency, cost accounting.
- **Event API:** typed subscriptions; bounded queues and at-least-once delivery.
- **Secrets broker:** inject or proxy credential use without exposing plaintext to agent context/UI.
- **Workspace API:** read active plugin versions, feature settings, layouts, and compatibility.
- **Audit API:** log installer actions, tool invocations, permissions, spend and artifact provenance.

Every action includes a `workspace_id`, user/agent principal, correlation ID, idempotency key when relevant, and an authorization decision. Never trust these fields merely because the plugin sent them; derive identity and tenancy from the execution context.

### 6.1 Canonical segmentation contracts

```python
from typing import Literal
from pydantic import BaseModel, Field

class PointPrompt(BaseModel):
    x: float
    y: float
    positive: bool = True

class SegmentRequest(BaseModel):
    asset_id: str
    provider: str | None = None
    text_prompt: str | None = None
    points: list[PointPrompt] = Field(default_factory=list)
    boxes: list[list[float]] = Field(default_factory=list)

class MaskInstance(BaseModel):
    instance_id: str
    mask_artifact_id: str
    box_xyxy: list[float] | None = None
    label: str | None = None
    confidence: float | None = None

class SegmentResult(BaseModel):
    instances: list[MaskInstance]
    provider: str
    model: str
    status: Literal["completed", "partial"] = "completed"
```

Coordinate frames and mask encoding MUST be defined by separate schema contracts (e.g. pixel-coordinate XYXY; binary mask encoded as RLE or artifact-backed PNG). Confidence is optional—do not invent a calibrated score when a provider does not return one. In production, use discriminated prompt types and schema-validated artifact references rather than loosely typed boxes.

## 7. Discovery, selection, installation, and activation

### 7.1 Registry index

Maintain indexed metadata: plugin ID/publisher/version, signature digest, declared capabilities, media types, runtime needs, permissions, license, provider availability, cost hints, compatibility, health, and trust status. The agent searches the registry **before** generating new code.

Order of preference:

1. Already-installed compatible capability.
2. Existing vetted plugin that can be enabled/configured.
3. Compose several vetted plugins into a workflow or view.
4. Modify/fork a compatible plugin in a sandbox.
5. Author a new plugin from the SDK template in a sandbox.

### 7.2 Install state machine

```text
REQUESTED -> RESOLVED -> STAGED -> VALIDATED -> AWAITING_APPROVAL
                                            |              |
                                            |              v
                                            |           ACTIVATED
                                            |              |
                                            +-> REJECTED    +-> DISABLED
                                                           +-> ROLLED_BACK
```

- **Resolve** dependency graph, semantic version constraints, kernel API compatibility, cycles/conflicts, and policy.
- **Stage** download from allowlisted registry; verify checksum, signature, lockfile and package provenance.
- **Validate** schema, static checks, vulnerability/license checks, test suite, mocked provider interactions, permissions and resource limits.
- **Approve** show user/admin diff: modules, permissions, secrets, egress destinations, estimated spend, data residency, UI surfaces.
- **Activate** atomically pin `{plugin_id, version, artifact_digest, config_revision}` to workspace; publish changes to extension host and tool catalog.
- **Rollback** atomically restore previous active set and config; don't silently delete user-created annotations. Data migrations require explicit reversibility rules/backups.

An already approved low-risk settings change may follow a streamlined policy path. New executable artifacts, broader permissions or higher budgets always need approval.

### 7.3 Updates

- Default to **pinned versions**, never floating latest in production.
- Compare manifest/config/data-schema changes and dependency graph.
- Run compatibility and migration tests against a snapshot.
- Canary enable for one workspace; monitor invocation failure rate and latency.
- Roll back on error; maintain an append-only installation history.

## 8. Agent architecture and tools

The **Builder Agent** modifies workspace capabilities. The **Task Agent** performs data work with already authorized capabilities. Keep their permissions separate. A specialist **Coder Worker** authors packages only in a temporary sandbox.

### 8.1 Builder tools (control plane)

```text
studio.inspect_workspace
studio.list_capabilities
studio.search_plugins
studio.inspect_plugin
studio.plan_plugin_change
studio.stage_plugin
studio.run_plugin_checks
studio.request_install_approval
studio.activate_plugin
studio.configure_plugin
studio.disable_plugin
studio.rollback_plugin
studio.create_plugin_sandbox
```

### 8.2 Task tools (data plane)

```text
studio.list_assets
studio.invoke_capability
studio.create_job
studio.get_job_status
studio.list_annotations
studio.export_dataset
```

The public tool catalog is generated from the registry and each active manifest. The agent should see capability summaries plus lazily loaded schemas; do **not** stuff all plugin instructions and full schemas into every prompt.

**Tool invocation:** User/UI/agent submits a typed command → gateway resolves active plugin/version → validates input → checks RBAC/ABAC, secrets, egress and budget → routes to isolated execution → validates output → commits artifacts and audit log. MCP adapters may expose these same tools externally but do not bypass the gateway.

### 8.3 Agent plan-and-apply contract

For “Add segmentation using SAM 3.1”:

1. Discover active image viewer and annotation capabilities.
2. Search plugin registry for `image.segment` and inspect SAM support.
3. Prepare declarative UI changes and provider config.
4. Explain to user which new permissions, costs and credentials are needed.
5. Stage and test in sandbox with a fixture image; credentials via broker only.
6. Request approval; activate in **current workspace only**.
7. Check a smoke-test result and provide visible controls in image viewer.
8. Persist installation manifest and audit entry.

For “replace Meta API with local SAM,” first check local provider compatibility and availability, then change the provider binding; preserve the canonical annotation schema and UI. If unsupported, disclose the limitation instead of silently falling back to the hosted API.

## 9. Sandbox-generated plugins (Level 2 extension)

A code-generation agent may create tools/providers/UI adapters not already in the registry, but generated code is **untrusted** until validated and approved.

### 9.1 Development sandbox flow

```text
User asks for new capability
    -> builder checks catalog (no fit)
    -> creates short-lived coding workspace from SDK template
    -> coder edits only mounted plugin source and fixtures
    -> runner installs locked dependencies + executes tests
    -> artifact builder creates signed/versioned candidate
    -> policy scanner reviews permissions, code, dependencies
    -> user/admin reviews changes
    -> install manager stages and activates to one workspace
```

A provider such as Daytona can supply ephemeral coding sandboxes. Treat it as an **execution backend**, not as the plugin runtime's security model. The kernel must independently enforce workspace boundaries, access tokens, network policy, quotas, log retention, cleanup and artifact verification.

### 9.2 Sandbox boundaries

- Ephemeral per-build filesystem, no host mounts, no production database, no privileged Docker socket.
- Unprivileged process/container or stronger isolation; limit CPU, RAM, disk, runtime and processes.
- Default-deny outbound network; add explicit host allowlist for dependency fetching or test providers.
- Short-lived narrow tokens only; fake credentials and mock APIs for tests by default.
- Source inputs and package dependencies treated as untrusted; scan and pin dependencies.
- Store resulting package artifact in a private immutable registry; never execute a build artifact automatically in production.
- Expire build environments and delete ephemeral secrets; retain logs/artifacts only under documented policy.

### 9.3 Signed, content-addressed artifacts (todo10 Phase 3)

- **Layout.** One plugin version is one OCI image manifest: config = `plugin.yaml` as JSON,
  one deterministic tar layer = the package, annotation `<ns>.plugin.tree-digest`. Every blob
  is stored once, in the BlobStore's data namespace at `artifacts/sha256/<hex>`
  (`apps/api/src/studio_api/plugins/store.py`, packing in `packages/signing`'s `studio_signing.oci`).
  The registry entry is a `plugin_artifacts` row.
- **Two digests.** The *manifest digest* is what's signed. The *tree digest* (sha256 over
  `<path>\0<sha256>\n`, same as `tools/build-registry.mjs`) is what workspace pins and lockfiles carry.
- **Signing.** Generated plugins: the `Signer` from `studio_signing` (`sign(digest)`,
  `verify(digest, signature)`, `key_id`), picked by `STUDIO_API_SIGNER`: `local` (Ed25519 key
  file, dev) or `gcpkms` (Cloud KMS `EC_SIGN_P256_SHA256` key version in
  `STUDIO_API_SIGNER_KMS_KEY`; the key id is a `gcpkms://` URI that cosign also accepts).
  Each build also gets a DSSE-signed in-toto SLSA provenance attestation recording the agent run,
  prompt hash, model, checks and sample digests (`POST /api/v1/plugins/artifacts?runId=&promptHash=&model=&sampleDigests=`).
  Signature and attestation are OCI referrers of the manifest. First-party plugins are signed in
  CI with cosign keyless (`.github/workflows/sign-plugins.yml`, `tools/pack-plugins.py`).
- **Verification on every load.** The kernel re-verifies on stage, `GET /plugins/{id}`,
  `/docs` and `/files`. It checks, from the manifest down: blob hashes, the tree digest against
  the pin, the signature by a trusted key, that the registry's `plugin.yaml` is the signed one,
  and the attestation. Curated packages are checked against their registry digest. The browser
  loads remote plugins by fetch-and-hash (`GET /plugins/{id}/files`, checked against the
  workspace's pin in `contributions-loader.tsx`). Every refusal returns its reason and writes a
  `plugins.artifact.refused` audit entry (`where`: stage, inspect, docs, files, browser).

### 9.4 Distribution and promotion (todo10 Phase 8)

- **Export / import.** `GET /api/v1/plugins/{id}/export?version=` returns a tar of an OCI
  image layout: the manifest tagged `<version>` plus its signature and attestation referrers.
  `POST /api/v1/plugins/import?tier=` takes one back. It verifies every byte and requires a
  signature by this installation's key or one in `STUDIO_API_SIGNER_TRUSTED_KEYS_FILE`; nothing
  is stored unless all of it passes, and refusals are audited (`where: import`). Both need
  `plugins.approve`, so agent tokens can't call them. `tools/oras-plugins.sh` moves layouts
  through any OCI registry with `oras copy -r`: `export`, `import`, `mirror`, and `save`/`load`
  for air-gapped sites. `zot` starts a local zot registry.
- **Promotion tiers.** `generated` (the authoring workspace) → `organisation` (every project of
  its organisation) → `curated` (every workspace of the installation), one step at a time.
  `POST /api/v1/plugins/{id}/promotions` asks (`plugins.manage`, a person).
  `POST /api/v1/plugins/promotions/{n}/review` decides (`plugins.approve`). The reviewer must be
  neither the requester nor the artifact's author, and the artifact is re-verified at approval.
  Requests and decisions are append-only `plugin_promotions` rows plus audit entries. Only the
  authoring workspace may publish later versions of an id, whatever its tier.

### 9.5 The ladder and converters (todo10 Phases 5–6)

The builder agent adapts the Studio on the lowest rung that works
(`apps/agent/src/agent/prompts/builder.md`): configuration, then a **converter**, then a
declarative panel, then a **sandboxed viewer** (`docs/modules.md`, "Sandboxed viewers on MCP
Apps"). A converter (`packages/contracts/src/converter.ts`, `schemas/converter.v1.json`) is a
package with `converter.yaml` and a Python function or a WASI module that turns one file into a
canonical shape (assets an existing data kind reads, a Zarr array or an Arrow table). The
worker runs it (`apps/worker/src/studio_worker/convert/`, `python -m studio_worker.convert
<package> <input> <out>`) on a read-only copy of the input, in its own process or under
wasmtime, with no network, and returns only a fixed-schema `ConversionSummary`. The same WASI
module runs in Node or the browser through jco (`jco new --wasi-command` + `jco transpile`).

## 10. Security and multi-tenancy

**Threats:** malicious plugin package, prompt-injected skill instructions, dependency compromise, SSRF, cross-tenant asset access, API-key exfiltration, infinite job loops, surprise API charges, browser-origin compromise and unsafe migrations.

Required safeguards:

| Boundary | Requirement |
|---|---|
| Workspace | Tenant isolation checked by kernel on every asset/annotation call |
| Execution | Plugin processes isolated from core API; no shared trusted Python interpreter for unreviewed code |
| Network | Per-plugin egress allowlist; deny access to metadata/internal services |
| Secrets | Broker-controlled, scoped use; never included in model prompts or manifest plaintext |
| Authorization | Permission grants bound to plugin version + workspace + actor |
| UI | Trusted renderer registry for MVP; sandbox remote extensions later |
| Supply chain | Signed artifacts, locked dependencies, vulnerability scans, provenance |
| Jobs | Concurrency limits, cancellations, retries with idempotency, budget caps |
| Events | Rate limits, recursion guards and loop detection |
| Audit | Record who/what changed, version, permissions, invoked providers and costs |

Skills and README files are **untrusted input** to the agent. Instructions from plugins cannot override system policy or install privileges.

### 10.1 Permission review semantics

Distinguish `permission requested`, `permission granted`, and `permission used`. A module can optionally request `network.egress:dev.meta.ai`, but no runtime call can use it until a workspace-admin grant exists. Changing provider can change egress and residency implications, even if the UI stays identical.

## 11. Data model and persistence

Suggested normalized tables (or equivalents):

```text
plugin_packages(id, publisher, license, trust_tier)
plugin_versions(plugin_id, version, artifact_digest, manifest, signature, created_at)
workspace_plugins(workspace_id, plugin_id, version, config_revision, state)
workspace_plugin_grants(workspace_id, plugin_id, version, permission, granted_by)
workspace_plugin_configs(workspace_id, plugin_id, config_revision, config_json, secret_refs)
plugin_capabilities(plugin_id, version, capability_id, schema_ref)
plugin_jobs(job_id, workspace_id, plugin_id, version, state, cost_usd, correlation_id)
plugin_events(event_id, workspace_id, type, idempotency_key, payload_ref)
plugin_audit(id, actor_id, workspace_id, action, before_ref, after_ref, timestamp)
```

Keep source assets and canonical annotations in kernel-owned stores, not arbitrary plugin tables. Plugin-specific state can use namespaced storage subject to quotas and migration policies. Every generated mask stores source asset, mask encoding/artifact reference, provider/model/version, prompt/provenance, creator, timestamp and review status.

## 12. SAM 3.1 reference integration

### 12.1 MVP experience

1. Workspace starts with `image.viewer` and annotation storage available.
2. User says: “Add segmentation with SAM 3.1.”
3. Builder finds `studio.segmentation`, reviews requested API egress/credentials, and installs it.
4. Toolbar appears only on compatible image assets.
5. User enters a text prompt or clicks an object; action calls `image.segment` through gateway.
6. Provider calls Meta Model API server-side; adapter converts response into canonical masks.
7. Trusted mask-review renderer overlays instances; user edits and approves.
8. Canonical annotations are available for export, training and later provider swaps.

**API contract note:** `meta_sam.py` must be implemented against the official current Meta API request/response format; the `SegmentRequest` above is an internal abstraction, **not** a copied upstream SDK signature. Validate currently supported prompts, media limits, auth, rate limits and pricing at integration time.

### 12.2 Pricing and model terms

Keep pricing in registry/provider metadata with `effective_at` and `source_url`, not hardcoded in orchestration. Before a batch call, calculate an estimate from current configured rate and number of billable images/frames/passes; impose an enforceable max spend. Publicly available model weights are not necessarily OSI open source; display the actual SAM model license separately from the plugin package license.

### 12.3 Provider switch

```text
image.segment
   |
   +--> meta.sam-3.1       (hosted, API key + approved egress)
   +--> local.sam          (self-hosted, compatible inference endpoint)
   +--> future.segmenter   (later)
```

Provider features are not assumed identical: model selection exposes a capability/feature matrix (text prompts, point prompts, boxes, video tracking, max dimensions, masks, latency). The UI hides unsupported actions or explains gaps; it never pretends providers are interchangeable in quality or semantics.

## 13. Implementation milestones

### Phase 0 — contracts and kernel primitives

- Define plugin schema, capability IDs, command gateway, canonical annotations, policy engine, and extension slots.
- Implement config and version persistence plus traceable tool calls.
- Add trusted image canvas and generic mask editor primitives.

**Exit condition:** a hardcoded first-party segmentation command runs through the gateway and stores provider-independent masks.

### Phase 1 — manifest-driven plugins (MVP)

- Build registry, resolver, install/disable/configure lifecycle, and declarative UI contributions.
- Ship `studio.segmentation` with Meta SAM adapter plus mock provider for CI.
- Agent can discover, propose, stage, and activate a vetted plugin after approval.
- Integrate queue-backed batches, spend limits, basic progress and rollback.

**Exit condition:** “Add segmentation” activates a new toolbar and functioning masks without a main-app deploy.

### Phase 2 — composition and portability

- Allow workflows combining plugins, such as segment → human review → export.
- Add plugin dependencies, capability negotiation, provider switching, optional self-host adapter.
- Introduce reviews, per-workspace configuration snapshots and canary updates.

**Exit condition:** swapping providers preserves prior annotations and requires no frontend rewrite.

### Phase 3 — agent-authored plugins

- Add Daytona or equivalent short-lived sandbox backend, SDK templates, automated builds/tests, signing and review.
- Permit agent to propose new server-side plugin artifacts; optional UI through safe declarative renderers.
- Later consider iframe-isolated custom interfaces and curated marketplace publishing.

**Exit condition:** agent can build a narrowly scoped new capability, test it, request approval and install it in one workspace with rollback.

## 14. Acceptance tests and failure cases

**Must pass:**

1. Installing `studio.segmentation` in workspace A does not expose it in workspace B.
2. Unapproved plugins cannot invoke tools or access assets.
3. A plugin requesting undeclared egress fails closed.
4. The agent cannot install a new code artifact solely because a skill file instructs it to.
5. Invalid provider outputs produce a recoverable job error, never malformed annotations.
6. Plugin worker timeout/cancellation doesn't bring down core API.
7. Re-running a job with the same idempotency key doesn't duplicate committed annotations.
8. A provider switch preserves existing masks and provenance.
9. Version rollback restores commands and UI contributions without deleting annotations.
10. Price estimate/budget denial occurs **before** an external billable batch begins.
11. Dependency conflicts are surfaced rather than silently rewriting another plugin.
12. Untrusted generated UI code never executes in the trusted main-app origin.

## 15. Design decisions to keep explicit

- **MVP registry:** curated first-party and reviewed packages; open marketplace later.
- **MVP UI:** manifest descriptors + trusted renderers; untrusted React injection prohibited.
- **Plugin execution:** separate Python workers, not dynamic imports into the API server.
- **Builder privileges:** workspace-scoped, approval-gated control plane.
- **Coder:** sandboxed artifact authoring, never direct production code mutation.
- **Data ownership:** kernel-owned assets and annotations with provider-neutral formats.
- **Commercial extensibility:** plugin code licenses, model licenses and API terms disclosed separately.

## 16. One-sentence architecture rule

> **The agent can change what the studio *does* by installing or authoring plugins; it cannot bypass the kernel that determines what plugins are *allowed* to do.**
