# Adaptable Studio: a ladder for new data, versioned Studio definitions, signed plugins

**Goal.** People will bring data we have never seen. We should not ship a viewer for every format, and
we should not let every new format become an unreviewed blob of plugin code either. This plan:

- gives the agent a **ladder** of ways to adapt the Studio, and makes it use the lowest rung that works;
- **versions the Studio's definition, not its code**: each task's setup is a small file plus a
  lockfile of exact plugin versions, committed next to the annotations it produced;
- makes plugin bundles **immutable, content-addressed and signed**, so any Studio can be rebuilt,
  rolled back or started in a safe mode after corruption or a malicious instruction.

**Status (2026-10-31).** Ready for agents. D1–D8 accepted as recommended; D9 accepted as a trial.
Google Cloud groundwork is done (BAA accepted, folders, organization policies, perimeter in
dry-run; see Phase 9). No code phase has started. Agents: start at "Start here (agents)" below.

**Audit date:** 2026-10-31, against `main` a1817c7 (todo6 merged; todo7 and todo8 in progress).

---

## Start here (agents)

This file is the whole brief. If you were handed only this file and a workstream name, you have
everything you need.

**1. Read, in this order, before touching code:**

1. `AGENTS.md` (repo rules: layout, naming, worktrees, checks).
2. This file: the goal, §1 principles, §6 (the data boundary), the phases of your workstream in §9,
   and §11 (ownership, contracts between workstreams, rules, merge order).
3. `docs/deployment-gcp.md` (the three Google Cloud projects and what the agent may see).
4. The docs for the area you'll change:

   | Workstream | Read |
   |---|---|
   | `todo10-studio-defs` | `docs/versioning.md`, `apps/versioning/README.md`, `docs/modules.md`, `packages/contracts/src/environment.ts`, `apps/api/src/studio_api/routes/environments.py`, `apps/web/src/extension-host/workspace.ts` |
   | `todo10-artifacts` | `docs/plugins.md`, `apps/api/src/studio_api/plugins/{installer,artifacts,policy,digest,catalog}.py`, `routes/plugins.py`, `apps/web/src/extension-host/contributions-loader.tsx`, the `BlobStore` implementation |
   | `todo10-boundary` | `docs/agent.md`, `docs/plugins.md`, `apps/agent/src/{config.ts,sandbox/*,tools/*}`, `apps/worker/**`, `apps/api/src/studio_api/routes/**`, `secrets/README.md`, `todo/BACKLOG.md` |
   | `todo10-viewers` | `docs/modules.md`, `docs/plugins.md`, `apps/web/src/extension-host/{trusted-renderers.tsx,registry.ts,resolve.ts}`, `packages/plugin-ui-sdk/src/module.ts`, `apps/agent/src/agent/prompts/builder.md`, `apps/mcp` |
   | `todo10-gcp` | `infra/terraform/org/` (already applied; copy its style), `infra/k8s/README.md`, `docs/running.md`, `apps/agent/src/config.ts`, the `BlobStore` implementation |

**2. Set up:**

```sh
cd /Users/anhlam/inkling
git worktree add .worktrees/todo10-<name> -b todo10-<name> main   # or reuse the empty one if it exists
```

Work only there. If the worktree already exists and is empty (a cancelled start), first run
`git -C .worktrees/todo10-<name> rebase main` to pick up this file.

**3. The data boundary. Holds for every workstream, every commit:**

- Customer data lives only in `spurby-phi`; nothing reads it from `spurby-ai`, where the agent runs.
- No real sample, item bytes or customer file ever reaches a sandbox (Daytona or any
  `SandboxProvider`) or the model's context. The agent gets only fingerprints, synthetic fixtures,
  fixed-schema verify reports, typed probe answers and job summaries.
- Raw exception text, stack-frame values and free-text annotation fields never go back to the agent
  unfiltered. Job summaries suppress small counts (default under 20).
- Sandbox egress stays closed; no secrets passed into sandboxes (`envVars`).
- No new route callable by the agent token without updating the list in `docs/deployment-gcp.md`
  and saying so in your report.
- Nothing copies data from `spurby-phi` to `spurby-data` except the de-identified release path.
- Plugin code that runs on real data runs in the worker (gVisor, no egress, read-only input) or the
  browser sandbox, never in a build sandbox.
- Development, tests and staging use synthetic data only.
- No account emails, organization, folder or billing IDs in committed files.

**4. Google Cloud access:** read-only unless a person says otherwise in chat. You may
`terraform init/validate/plan` as the keyless deploy identity:

```sh
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=terraform@spurby-phi.iam.gserviceaccount.com --configuration=spurby-phi)
```

Account IDs are in the git-ignored `/Users/anhlam/inkling/secrets/gcp.local.md`; pass them as `-var`.
`terraform apply`, enforcing the perimeter, IAM changes and enabling APIs need a person's go-ahead.
This works only on this Mac (it uses the person's `gcloud` sign-in).

**5. Hand back** with: done per phase against its exit criteria, commits (hash + one line),
migrations, env vars, contracts other workstreams need, checks run with results, and what's left or
blocked. Don't merge and don't edit this file; the integrator does both.

**Prompt to give each agent** (replace `<name>` with `studio-defs`, `artifacts`, `boundary`, `viewers`
or `gcp`):

> Read `/Users/anhlam/inkling/todo/todo10.md` from "Start here (agents)" and follow it. You are
> workstream `todo10-<name>`. Do every phase §11 assigns to you, to its exit criteria.

**For the integrator** (a person, or one coordinating agent): merge in the §11 order, re-chain
Alembic migrations, wire the `Signer` into `build_plugin`, run the full `AGENTS.md` check list on
`main` after each merge, then tick the phases here and update the Status line.

---

## 0. Where we are

### What Inkling already has

| kiwifs (`~/kiwifs`) | Inkling today |
|---|---|
| Typed fence: YAML body, validated against a schema, no author code | Environment JSON (`packages/contracts/src/environment.ts`) plus `ui/contributions.json` declarative plugins |
| `widget:live`: composition of built-in views | Presets, `extends`, `overrides`, `layout` (`apps/web/src/extension-host/resolve.ts`) |
| `kiwi-app`: iframe with `sandbox="allow-scripts"`, a versioned postMessage envelope | Tier-3 `studio.sandbox-frame.v1` (`extension-host/trusted-renderers.tsx`), an iframe without `allow-same-origin` |
| MCP `kiwi_widget_reference` + lint, generated from the same specs | `schemas/catalog.json`, `catalog.md`, agent tools `get_environment` / `patch_environment` |
| Git as the write log (`internal/versioning/git.go`) | Three unrelated histories (below) |

Plugin trust tiers today (`docs/plugins.md`, `apps/api/src/studio_api/plugins/*`):

- first-party React modules in the bundle;
- declarative third-party plugins, which can only name trusted renderers and kernel commands;
- Python workers, one process per job, in locked `uv` environments;
- tier-3 sandboxed iframes.

Agent-built plugins are made in a Daytona sandbox and sent to `POST /api/v1/plugins/artifacts`. They're
stored under `{API_DATA_DIR}/plugin-artifacts/<id>/<ver>/` and signed with an **Ed25519 development
key**, with a comment saying "sigstore later".

### Three histories that don't know about each other

| What | Where | Shape |
|---|---|---|
| Environment revisions | `workspace_environments` + `workspace_environment_history` (migration 0003) | append-only rows, optimistic `revision` |
| Plugin pins | `workspace_plugins` + `workspace_plugin_history` | `{plugin_id, version, artifact_digest, config_revision}`, rollback route |
| Dataset versions | `apps/versioning` (Go) | go-git objects in Postgres, bytes in S3, branch heads with compare-and-swap, reviews, releases |

**Consequence.** A published dataset version can't say which viewer, plugins, label setup or layout
produced its labels. ux.md §10 requires it ("Dataset versions must record inputs, transforms, tasks,
annotation versions…").

### What doesn't exist yet

- OCI artifacts, Sigstore, WebAssembly plugins, a marketplace, or a safe mode.
- A "last known good" Studio.
- Provenance on agent-made environment changes, beyond `author`.

---

## 1. Principles

1. **Lowest rung first.** The agent must try configuration, then a converter, then a declarative panel,
   and write a custom viewer only when nothing else works. Each rung up costs review and risk.
2. **Canonical shapes, many adapters.** The long tail is in file formats and task panels, not in
   display. Medical and scientific data reduce to a few shapes:
   - n-dimensional arrays: images, volumes, slide pyramids;
   - signals (waveforms);
   - video;
   - tables;
   - documents;
   - meshes and point clouds;
   - graphs and geo.
3. **Definitions are data; code is an immutable artifact.** People and agents edit JSON. Code changes
   only by publishing a new artifact with a new digest.
4. **Pin by digest, verify on every load.** Tags are labels; digests are identity.
5. **Model output never widens permissions.** A capability change always goes through a person
   (`InstallReview` already shows the permission diff).
6. **Rollback is a pointer move, not a model request.** It restores a named known-good revision, not
   just "the previous one".
7. **Self-hostable by default.** Every piece must run inside a hospital's own cloud or data centre.
   Managed services are an option, never a requirement on the patient-data path.

---

## 2. The ladder (what "adaptable" means)

| Rung | What the agent produces | Runs where | Review |
|---|---|---|---|
| 1. Configuration | an `environment.json` that recombines existing viewers, tools, panels | nowhere new | schema + resolver; auto-apply, undoable |
| 2. Converter ("decoder") | a small module turning an unknown file into a canonical shape (Zarr array, Arrow table, our assets) | Python worker, or a WebAssembly component in browser and worker | tests pass on the user's sample; person approves first use |
| 3. Declarative panel | `contributions.json`, A2UI-style specs naming catalogue components | the Studio, no new code | schema; auto-apply |
| 4. Sandboxed custom viewer | an ESM module with anywidget's shape `render({ model, el, signal, host })` | opaque-origin iframe; MCP Apps JSON-RPC bridge | permission diff approved; signed by the platform |
| 5. First-party | a reviewed module in the bundle | main origin | code review; promoted from rung 4 |

Notes:

- **Converters** are where most new work should land. They're small and have no UI. They're tested
  against the actual sample the user dropped. And they're portable:
  [jco](https://bytecodealliance.github.io/jco/wasi/index.html) runs the same WASI 0.3 component in
  the browser and in Node (WASI 0.3 shipped June 2026), and wasmtime runs it in the worker.
- **The viewer bridge** should be [MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
  (stable since 2026-01-26), not a home-grown postMessage dialect. It brings:
  - a sandbox proxy on a separate origin;
  - CSP declared per resource (`connectDomains`, `resourceDomains`);
  - `ui/initialize`;
  - auditable JSON-RPC.

  Our viewers would also render in Claude and ChatGPT, and we already run an MCP server (`apps/mcp`).
- **Annotations** from rung-4 viewers come back only through the typed geometry API (`packages/contracts`),
  never by writing the document directly.
- **Promotion** follows [3D Slicer's tiers](https://github.com/Slicer/ExtensionsIndex/) (experimental →
  community → core) and Grafana's signature levels:
  - workspace-private (generated);
  - organisation;
  - curated catalogue.
- OHIF is going the same way: its docs say the CLI is "being phased out in favour of generating
  extensions and modes with an agent". Their "modes" are our environments.

---

## 3. What to version, and how

### 3.1 Plugin artifacts (code)

- **Immutable and content-addressed.** A new version means new bytes and a new SHA-256, never edited
  in place. Store each bundle at `artifacts/sha256/<digest>` in object storage.
- **Format.** A manifest (`plugin.yaml`) plus layers (ESM bundle, `.wasm` component, Python wheel),
  laid out **OCI-compatible** (manifest + blobs with media types). Pushing to a registry later is
  then an export, not a migration.
- **Signatures.**
  - First-party: Sigstore cosign, keyless, from CI.
  - Agent-generated: a per-organisation platform key held in a KMS, which the agent runtime can't read.
  - Both carry an in-toto/SLSA-style attestation recording which agent run, which prompt hash,
    which model, which checks passed, and which sample digests were tested.
- **Verification on every load,** not only at install:
  - the API checks digest and signature;
  - the browser loads ESM through an import map with `integrity`, or verifies the bytes it fetched.

### 3.2 The Studio definition (small JSON, edited often)

Files, committed in the project's `apps/versioning` repository next to the annotations:

```text
.studio/
  plugins.lock.json            {id, version, digest, signer, permissions, configRevision} per plugin
  tasks/<taskId>/environment.json   the environment spec (schema'd; edited by JSON-Patch)
  tasks/<taskId>/README.md          intent and notes, written by the agent or a person (kiwifs's SCHEMA.md idea)
```

- **JSON is canonical,** hashed in RFC 8785 canonical form. Markdown is only the human-readable
  companion: validation, JSON-Patch and diffs all depend on JSON.
- **Consequences:**
  - a dataset release pins the exact interface and plugins that produced its labels;
  - an experimental viewer is a branch;
  - an agent's change goes through Request review;
  - "go back to an older Studio" moves a branch pointer.
- **Two paths for edits, one source of truth.**
  - The Postgres revision table stays as the fast undo journal (per keystroke, per agent patch).
  - It is committed into the repository at meaningful moments: Task setup saved, an agent change
    approved, before a release.
  - With versioning on, the repository is authoritative and the table is a cache of uncommitted
    work.
- **Named refs** per project:
  - `main`;
  - `last-known-good`, moved only by a person or by passing checks;
  - drafts per person.

### 3.3 Data bytes

Already handled: immutable blobs plus versioned manifests. For very large re-uploads later, consider
content-defined chunking like Hugging Face's open-source [Xet](https://huggingface.co/docs/xet/chunking)
(about 64 KiB chunks, deduplicated across versions).

### 3.4 Recovering from corruption or a malicious instruction

- **Every revision is immutable** and carries its author: a person, or an agent run id with its
  prompt hash.
- **Changes that need a person** (OWASP AISVS C9.2):
  - capability-widening: a new plugin, network egress, write scopes, a new signer;
  - plugin pins and the lockfile's `permissions`.

  The model can propose these; only a person commits them.
- **Rollback** restores `last-known-good` in one transaction (AWS Agentic AI Lens AGENTOPS02-BP03:
  restore a proven baseline, not "the previous one").
- **Safe mode** (`?safe` or a button on the error screen): boot from `last-known-good`'s lockfile with
  every non-first-party plugin off, like VS Code's "disable extensions".
- **Hash-chained audit** of revisions, approvals, rollbacks and plugin loads (extends the kernel's
  audit table).

---

## 4. Where it's hosted

Portable pieces below; the Google Cloud mapping and the two-project layout are in §6.4.

| Piece | Host | Self-host |
|---|---|---|
| Refs, revisions, install control plane, audit | Postgres (managed in the cloud, or the customer's) | yes |
| Plugin bundles, git objects, data | S3-compatible object storage (S3, R2, GCS; RustFS locally) | yes |
| Bundle delivery | a CDN in front of `artifacts/sha256/*`, cached forever (immutable) | optional |
| Distribution between installations | an OCI registry via [ORAS](https://oras.land) + cosign; [zot](https://zotregistry.dev) self-hosted, or GHCR/ECR/Harbor | yes |
| Air-gapped hospitals | `oras copy` into their registry; signatures travel with the artifacts | yes |
| Untrusted server code | Python worker (exists), wasmtime for converters; optionally workerd for quick JavaScript | yes |
| Agent build sandbox | Daytona cloud; only code and synthetic fixtures (§6) | local runner as a fallback |

---

## 5. What we will not do (and why)

- **Dolt.** A versioned database, but it replaces Postgres with a MySQL-compatible engine.
- **Neon branching.** It branches whole databases and can't merge. Good for preview environments, not
  for product versioning.
- **lakeFS.** Versioning over object storage, which overlaps with `apps/versioning`. Revisit only for
  data bytes at very large scale.
- **Module Federation for third-party code.** It loads that code into our origin with no isolation.
- **Markdown as the canonical config format.** It makes validation and JSON-Patch harder.
- **Tags without digests anywhere** in the load path.

---

## 6. Sandboxes (Daytona and friends)

The agent builds plugins in **Daytona's cloud** (`apps/agent/src/sandbox/*`). Assume we must keep it:
self-hosting isn't a real option, because Daytona's open-source server is effectively discontinued.

**Rule: only code and synthetic data enter Daytona. Real data never leaves our boundary, whatever its
class.** The build loop is split so the agent can still iterate against the real file.

### 6.1 The build loop

| Step | Where | What crosses the boundary |
|---|---|---|
| 1. Fingerprint | our worker | nothing |
| 2. Synthetic fixtures | our worker | fixtures + scrubbed fingerprint → Daytona |
| 3. Write and test against fixtures | Daytona | source → us |
| 4. Verify against the real sample | our worker | typed report → agent |
| 5. Probes (unknown layouts) | our worker | typed answers → agent |
| 6. Rebuild, hash, sign | our worker | nothing; this is the shipped bundle |

1. **Fingerprint.** The worker extracts structure from the user's sample: magic bytes, header field
   names, dtypes, dimensions, endianness, size, section layout. Values are dropped or replaced
   (DICOM: the PS3.15 Annex E de-identification profile). Pixels never leave.
2. **Synthetic fixtures.** The worker generates files with the same structure (noise or a phantom of
   the same shape and dtype; placeholder header values). These and the fingerprint are all Daytona
   sees.
3. **Build in Daytona against the fixtures.** One sandbox per build:
   - network blocked (`egress.ts`);
   - dependencies preinstalled in a pinned snapshot (no package downloads);
   - no secrets inside;
   - a short time limit; deleted on finish.
4. **Verify on the real sample in our worker.** No network, read-only input. The agent gets back only
   a **fixed-schema report**, never free text:
   - pass/fail;
   - error class;
   - line number in the plugin source;
   - output shape, dtype and value ranges.

   Raw exception messages and stack-frame values are dropped, because that's where names leak. Loop
   back to step 3.
5. **Probes**, for when fixtures aren't enough because the layout itself is unknown. Small typed
   questions run on the real file:
   - "is `DICM` at offset 128?";
   - "u32 little-endian at offset 0";
   - "list the header tag names".

   Numbers, offsets and field names return as they are. Anything that looks like free text goes
   through a PHI detector (e.g. Presidio) or comes back as a placeholder. Probes are budgeted per
   build and audited.
6. **Rebuild inside our boundary.** Only **source** crosses back. The worker builds it with a pinned
   toolchain, hashes it, and signs it with the KMS-held platform key (§3.1). Daytona's binary is
   thrown away (or only compared against our digest as a check). A compromised sandbox can hand us
   only source, which we test and build ourselves.

### 6.2 Around the loop

- **Running a plugin on real data** happens only in the worker (Python, wasmtime) or the browser
  sandbox. It has no network, and its output is validated against the canonical schema. Daytona is
  never involved after build time.
- **The model provider is a third party too.** Real file contents in the prompt would leak through
  that door instead. The agent's context gets the same fingerprint, fixtures, reports and probe
  answers as Daytona, nothing more.
- **Data classes** (public/synthetic, de-identified, PHI) still label files, for the review UI and
  export rules. They no longer decide what enters the build sandbox, because real samples never do.
- **The provider stays behind one interface** (`SandboxProvider`):
  - Daytona cloud by default;
  - a local container runner (gVisor/Firecracker) for customers who won't send even synthetic data
    out.

  Steps 1, 2, 4, 5 and 6 are already in our boundary, so only step 3 changes.
- **Contract hygiene** with Daytona: a DPA and a pinned region, though by design it only ever holds
  code and synthetic files.

### 6.3 What the agent can and can't see

The agent works on the **Studio's shell, never the data**.

| The agent can | The agent can't |
|---|---|
| read and patch environments (layout, tools, panels, label setup) | read item bytes (pixels, waveforms, documents) |
| write plugin source and test it on synthetic fixtures | receive a real sample, in a sandbox or in its context |
| read fingerprints, verify reports, probe answers | read raw exception text or stack values from a real-data run |
| start jobs on data ("convert these 500 files", "run checks") | see job output beyond counts, statuses, error classes |
| read annotations through a filtered view (below) | read free-text notes unfiltered |

- **It directs work on data without seeing it.** Jobs run in the worker inside the patient-data
  project, and only a summary comes back.
- **People see the data; the agent doesn't.** The annotator's browser talks to the API in the
  patient-data project directly; that traffic never passes through the agent.
- **Annotations.** Geometries and controlled-vocabulary labels pass through. Free text (notes,
  comments, `attributes` strings) passes through Sensitive Data Protection, or a placeholder is
  returned.
- **A later "data assistant"** that looks at scans would be a **second, separate agent** inside the
  perimeter. Its model would run under the cloud provider's BAA (Vertex AI), and it would have no
  sandbox or Daytona access. The plugin-building agent stays outside.

### 6.4 On Google Cloud

> **Superseded by [`docs/deployment-gcp.md`](../docs/deployment-gcp.md)**, which has three projects:
> `spurby-ai` (agent), `spurby-phi` (all customer uploads, inside the perimeter), `spurby-data`
> (curated and de-identified data). It also covers the release path, access tiers and small-count
> suppression. The text below is the original two-project reasoning.

**Two projects in total** (not two per service). Every service goes into one of them:

- **Patient-data project:** API, worker, Cloud SQL, Cloud Storage, Cloud KMS, Healthcare API,
  Sensitive Data Protection. Everything that touches real files lives here, inside a **VPC Service
  Controls perimeter**, so data can't be copied out even with stolen credentials.
- **Build project:** the agent, and its egress to Daytona and the model provider. It reaches the
  patient-data project only through narrow ingress rules on the API's `get_fingerprint`,
  `get_fixtures`, `verify_on_sample`, `probe_sample`, job-start and job-summary routes. A
  compromised agent can't read a patient-data bucket; the perimeter refuses it.

This turns "real data never leaves" from a code rule into an infrastructure rule.

**Contract.**

- Sign Google Cloud's **BAA** (console). Patient data may touch only products on Google's HIPAA
  covered-products list; check each product below against it before relying on it.
- Pin the region with the `gcp.resourceLocations` org policy; use **Assured Workloads** (HIPAA, or EU
  regimes) when a customer requires it.
- Daytona and a direct model provider stay outside Google's BAA. That's acceptable only because of
  §6.1: they get code and synthetic data.

**Service per piece.**

| Piece | Google service |
|---|---|
| Postgres | Cloud SQL for PostgreSQL 17, private IP, CMEK |
| BlobStore, artifacts | Cloud Storage (S3-compatible XML API with HMAC keys, or a native `BlobStore` backend); retention lock on the artifacts bucket so bundles can't change |
| Bundle delivery | Cloud CDN in front of the artifacts bucket |
| Platform signing key (§3.1) | Cloud KMS asymmetric key, HSM protection; cosign signs with `gcpkms://…` |
| First-party CI signing | GitHub OIDC through Workload Identity Federation (no stored keys) |
| OCI registry (Phase 8) | Artifact Registry (OCI artifacts, works with ORAS); Binary Authorization for our own images |
| Kubernetes | GKE Autopilot (the existing k8s overlays get a `gke` overlay) |
| Worker running untrusted plugin code | GKE Sandbox (gVisor) node pool, a NetworkPolicy denying all egress, read-only input |
| Fingerprint and de-identification (§6.1 step 1) | Cloud Healthcare API DICOM de-identify; Sensitive Data Protection for other formats |
| Free-text check (probe answers, annotation notes) | Sensitive Data Protection instead of running Presidio ourselves |
| Secrets | Secret Manager + Workload Identity for pods (no key files); still surfaced as `INKLING_*` env vars |
| Queue and events | keep Postgres (`SqlJobQueue`, `SqlEventBus`) or Memorystore (Redis); Pub/Sub only if we outgrow both |
| Audit (§3.4) | Cloud Audit Logs with Data Access logs on, sunk to a locked bucket; Access Transparency |

**What Google can replace.**

- **The model provider.** Gemini, and Claude through Vertex AI, can run under Google's BAA (confirm the
  exact model on the covered list). That closes the "model provider is a third party" gap in §6.2.
- **Daytona.** A gVisor-sandboxed pod in the build project can do §6.1 step 3. The open-source
  `kubernetes-sigs/agent-sandbox` project provides this on Kubernetes with pre-warmed sandboxes. That's
  the "local runner" of §6.2, hosted by Google, and makes Daytona optional on Google Cloud.

**Org policies from day one.**

- No service-account key creation.
- Resource locations restricted to the chosen region.
- CMEK required for Cloud SQL and Cloud Storage.
- Uniform bucket-level access.
- No public IPs on Cloud SQL or GKE nodes.

---

## 7. Open-source projects to build on

| Area | Projects |
|---|---|
| Viewer protocol | MCP Apps (`modelcontextprotocol/ext-apps`), anywidget's AFM module shape |
| Declarative UI the agent can write | A2UI (Google, Apache-2.0), json-render (Vercel Labs) |
| Viewers to standardise on | Cornerstone3D, OHIF, niivue, OpenSeadragon, Viv (OME-Zarr), Rerun, vtk.js, Mosaic / Vega-Lite + DuckDB-WASM, Neuroglancer |
| Converters | itk-wasm, dcmjs, zarrita.js, Apache Arrow, ffmpeg.wasm, GDAL (WebAssembly), Pyodide; wfdb, MNE in the worker |
| Plugin sandboxing | Extism, wasmtime, jco, SES / Endo (Hardened JavaScript), quickjs-emscripten, workerd |
| Packaging and trust | ORAS, zot, sigstore-js, sigstore-python, cosign, in-toto / SLSA, TUF (python-tuf) |
| Versioning | go-git (have it), RFC 8785 canonical JSON, jsondiffpatch; Automerge or Yjs if several people edit a setup at once |
| Build sandboxes | Daytona (cloud), gVisor / Firecracker for a local runner, esbuild-wasm |
| De-identification | pydicom + DICOM PS3.15 Annex E profiles (e.g. `deid`), Microsoft Presidio for text |

---

## 8. Decisions (decide before Phase 1)

- [x] **D1. One versioning engine.** Should Studio definitions and the plugin lockfile live in the
  project's `apps/versioning` repository (§3.2)? **Recommended: yes.** The alternative is a git-like
  history in Postgres only, which can't be pinned by a dataset release.
- [x] **D2. The viewer bridge is MCP Apps** (§2). **Recommended: yes.** The alternative is extending
  our own postMessage envelope.
- [x] **D3. Converters as WebAssembly components** in addition to Python workers. **Recommended: yes,
  after one trial converter** (itk-wasm for a NIfTI or MetaImage variant).
- [x] **D4. Artifact storage.** Content-addressed in our object store now, OCI-compatible layout, OCI
  registry later. **Recommended.**
- [x] **D5. Signing.** cosign keyless for first-party CI; a KMS-held per-organisation key for generated
  plugins, plus attestations. **Recommended.**
- [x] **D6. Hosting.** Google Cloud for our hosted product (§6.4). Every piece keeps a portable
  equivalent (Postgres, S3-compatible, zot) so customers can self-host. **Recommended.**
- [x] **D7. Two projects and a VPC Service Controls perimeter** (§6.4). The agent lives in the build
  project and reaches data only through the summary routes. **Recommended: yes**, from the first
  deployment; retrofitting a perimeter is painful.
- [x] **D8. Model on Vertex AI** under Google's BAA instead of a direct provider. **Recommended: yes**,
  once the model we use is confirmed on the covered list.
- [x] **D9. Replace Daytona with GKE Sandbox / agent-sandbox** in the build project. **Recommended:
  trial first.** Keep Daytona behind `SandboxProvider` until the GKE runner matches it on start time
  and tooling.

---

## 9. Phases

### Phase 1: lockfile and canonical definition

1. Add `plugins.lock.json` to contracts (zod + JSON Schema): id, version, digest, signer, permissions,
   configRevision. Generate it from `workspace_plugins`.
2. Canonical JSON hashing (RFC 8785) for environments and lockfiles; store `content_hash` and
   `parent_hash` on every `workspace_environment_history` row.
3. Record the author kind (person or agent run id) and the agent run's prompt hash on each revision.
4. **Exit:**
   - the same environment always hashes the same;
   - every revision row has a parent;
   - the lockfile round-trips.

### Phase 2: Studio definitions in the project repository (D1)

1. `apps/versioning`: a `.studio/` tree convention. A commit writes the lockfile and each task's
   environment and README.
2. The API commits at the moments in §3.2. A dataset release records the `.studio/` tree hash.
3. Named refs: `last-known-good` (moved by a person or by passing checks).
4. A Versions page section: "Studio setup at this version" with a diff (jsondiffpatch).
5. **Exit:**
   - an e2e test checks that a release pins the environment and lockfile;
   - restoring an old version restores its Studio setup.

### Phase 3: content-addressed, signed artifacts (D4, D5)

1. Move `plugin-artifacts/<id>/<ver>/` to `artifacts/sha256/<digest>` with an OCI-style manifest.
2. Replace the development Ed25519 key with:
   - cosign (first-party CI);
   - a KMS-held per-organisation key for generated plugins;
   - attestations.
3. Verify digest and signature on every load: in the API, and in the browser through import-map
   integrity or fetch-and-hash.
4. **Exit:** a tampered byte is refused with a reason, and that refusal is in the audit log.

### Phase 4: safe mode and rollback

1. A `?safe` boot that uses `last-known-good`'s lockfile with non-first-party plugins off, plus a
   button on the environment error screen.
2. A one-transaction rollback to `last-known-good`; a hash-chained audit entry.
3. **Exit:** an e2e test installs a plugin that breaks the Studio, then recovers through safe mode and
   rollback in under a minute, with no model call.

### Phase 5: sandboxed viewers on MCP Apps (D2)

1. A host-side sandbox proxy on a separate origin, following the MCP Apps spec. Port `studio.sandbox-frame.v1`
   to it.
2. A viewer SDK: anywidget-shaped `render({ model, el, signal, host })`; `host` exposes item assets
   (read), runtime values, and annotation writes through typed geometries.
3. **Exit:**
   - one rung-4 viewer, for a format we don't support, built by the agent and approved by a person;
   - the same viewer renders in an MCP Apps host outside Inkling.

### Phase 6: converters (D3) and the agent ladder

1. A converter contract: a sample file in, a canonical shape out (Zarr, Arrow, assets). Implement it in
   the Python worker first, then as a WebAssembly component through jco and wasmtime.
2. The agent's builder prompt (`apps/agent/src/agent/prompts/builder.md`) follows the ladder:
   configuration first, then a converter, then a declarative panel, and a custom viewer only when the
   others fail. It reports the rung it chose and why.
3. **Exit:** the agent opens an unsupported format with only a converter and an environment, with no
   viewer code.

### Phase 7: build outside, verify inside (§6)

1. Stop uploading real samples into the sandbox. The agent's sample-upload path goes to our worker
   instead.
2. Worker job `fingerprint`: structure extraction plus scrubbing (DICOM Annex E first, then generic
   binary, CSV/Parquet, HDF5). Store the fingerprint next to the item.
3. Worker job `synthesize_fixtures`: fingerprint in, same-structure synthetic files out.
4. Worker job `verify_plugin`: the plugin source runs on the real sample with no network and
   read-only input, and returns a fixed-schema report (zod in contracts) with free text dropped.
5. Worker job `probe`: a small typed probe language (magic at offset, read int/float at offset, list
   field names, section sizes); text answers pass through a PHI detector; probes are budgeted and
   audited.
6. Worker job `build_plugin`: rebuilds from source with a pinned toolchain, hashes, signs with the KMS
   key. `build_plugin_artifact` in Daytona becomes a dev check only.
7. Agent tools: `get_fingerprint`, `get_fixtures`, `verify_on_sample`, `probe_sample` replace direct
   sample access. Policy (`apps/agent/src/tools/policy.ts`) forbids sending sample bytes to any sandbox.
8. Sandboxes: Daytona snapshot with pinned dependencies, network blocked on every tier, no secrets,
   short time limit. A `SandboxProvider` interface with Daytona cloud and a local-container runner.
9. **Exit:**
   - a canary string planted in a real sample's header and pixels never appears in Daytona's file
     system, the sandbox logs, or the model's context (asserted in an e2e test);
   - an unknown binary format is converted end to end using only fixtures, verify reports and probes;
   - the installed bundle's digest is our build's, not Daytona's;
   - switching provider is a config change.

### Phase 8: distribution (later)

1. Export and import through an OCI registry (ORAS, zot); `oras copy` for air-gapped mirrors.
2. Promotion tiers (generated → organisation → curated) with review.

### Phase 9: Google Cloud deployment (D6–D9, §6.3–6.4)

1. **Done 2026-10-31** (`infra/terraform/org`): BAA accepted; `prod`/`nonprod`/`shared` folders;
   organization policies; perimeter around `spurby-phi` in **dry-run**. The two-project text in §6.4
   is superseded by three projects (`docs/deployment-gcp.md`); `spurby-ai` stays outside the
   organization. Still to do here: the release egress rule to `spurby-data`, then enforcing the
   perimeter (`-var perimeter_enforced=true`) after a clean dry-run, before customer data.
2. Terraform, one stack per project under `infra/terraform/<stack>/` (state prefix `<stack>` in
   `gs://spurby-phi-tfstate`, same keyless deploy identity as `org`), for Cloud SQL, Cloud Storage (artifacts bucket with retention
   lock), Cloud KMS, Artifact Registry, GKE Autopilot with a GKE Sandbox node pool, Secret Manager,
   Cloud CDN, audit log sinks. A `gke` k8s overlay next to the existing ones.
3. A Cloud Storage `BlobStore` backend (or confirm the S3-compatible API covers multipart and ranged
   reads), and a Cloud KMS signer for Phase 3.
4. Fingerprint and free-text checks call the Healthcare API and Sensitive Data Protection.
5. The agent's data-facing routes (§6.3) are the only ingress from the build project; an annotation
   view for the agent that filters free text.
6. D8: switch the agent's model to Vertex AI. D9: a GKE Sandbox `SandboxProvider`, trialled against
   Daytona.
7. **Exit:**
   - from the build project, a direct read of a patient-data bucket or Cloud SQL is refused by the
     perimeter (asserted in a test);
   - the Phase 7 canary test passes on Google Cloud;
   - with D8 done, no prompt leaves Google's BAA.

---

## 10. Order and size

| Phase | Size | Depends on |
|---|---|---|
| 1 Lockfile and hashing | S | — |
| 2 Studio definitions in the repository | M | 1, D1 |
| 3 Signed artifacts | M | D4, D5 |
| 4 Safe mode and rollback | S–M | 1, 3 |
| 5 MCP Apps viewers | L | D2 |
| 6 Converters and the ladder | L | 5 for rung 4; D3 |
| 7 Build outside, verify inside | M–L | 3 for signing; otherwise parallel |
| 8 Distribution | M | 3 |
| 9 Google Cloud deployment | L | D6–D9; perimeter first, the rest alongside 3 and 7 |

Phases 1, 3 and 4 give recoverability soonest; 5 and 6 give adaptability.

---

## 11. Running this with agents

Five workstreams, one agent and one worktree each (`git worktree add .worktrees/<branch> -b <branch>`
per `AGENTS.md`). Empty worktrees with these names may already exist from a cancelled start; reuse or
recreate them. Reading list, setup, the data boundary and the hand-back format are in "Start here
(agents)" at the top.

| Branch | Phases | Owns | Must not touch |
|---|---|---|---|
| `todo10-studio-defs` | 1, 2, 4 | lockfile + canonical hashing in `packages/contracts` (new files), environment routes and history in `apps/api`, `.studio/` in `apps/versioning`, safe mode and Versions UI in `apps/web` | plugin signing, `apps/agent/src/sandbox/**`, `apps/agent/src/tools/**`, `apps/worker/**`, `infra/**` |
| `todo10-artifacts` | 3, 8 | `apps/api/src/studio_api/plugins/{artifacts,digest,installer}.py`, the `Signer`, bundle verification in `extension-host/contributions-loader.tsx`, CI signing under `.github/`, ORAS script under `tools/` | lockfile schema, `apps/versioning/**`, agent, worker, `infra/**` |
| `todo10-boundary` | 7 (+ §6.1–6.3) | `apps/agent/src/sandbox/**`, `apps/agent/src/tools/**` (incl. `policy.ts`), worker jobs `fingerprint`, `synthesize_fixtures`, `verify_plugin`, `probe`, `build_plugin`, the agent-scoped API routes and token scope, report schemas (new contracts files) | `builder.md`, environment routes, artifact storage, `infra/**` |
| `todo10-viewers` | 5, 6 | MCP Apps sandbox proxy and `studio.sandbox-frame.v1`, viewer SDK in `packages/plugin-ui-sdk`, converter contract (new contracts file) and runtime (own worker module), `apps/agent/src/agent/prompts/builder.md` | studio shell (`apps/web/src/studio/**`), the boundary agent's worker jobs, `infra/**` |
| `todo10-gcp` | 9 | `infra/terraform/<stack>/` (not `org` unless adding the release egress rule), the `gke` overlay, a Cloud Storage `BlobStore` backend, Vertex AI model config in `apps/agent/src/config.ts` | `apps/agent/src/sandbox/**`, `apps/agent/src/tools/**`, signing code, `apps/worker/**` jobs |

**Contracts between workstreams** (keep these names; the integrator wires them at merge):

- Lockfile entry: `{id, version, digest: "sha256:<hex>", signer, permissions, configRevision}`.
- `Signer`, owned by `todo10-artifacts`: `sign(digest) -> signature`, `verify(digest, signature)`,
  `key_id`; implementations `local` (Ed25519 dev key) and `gcpkms`, chosen by `INKLING_API_SIGNER`.
  `todo10-boundary`'s `build_plugin` calls a local interface with the same shape and a dev
  implementation until merge.
- Agent-scoped routes (`todo10-boundary`): `get_fingerprint`, `get_fixtures`, `verify_on_sample`,
  `probe_sample`, job start, job summary, filtered annotations. Any change updates the list in
  `docs/deployment-gcp.md`.
- Converter contract (`todo10-viewers`) and verify-report schema (`todo10-boundary`) are separate new
  files in `packages/contracts`; neither edits `environment.ts`.

**Rules for every agent:**

- Commit on your branch; never merge into `main`; never edit `todo/todo10.md` (report status instead;
  the integrator ticks it).
- Alembic migrations: put your branch slug in the filename and chain after `main`'s head; the
  integrator re-chains at merge.
- Don't rename anything to Spurby; names go through `NAMING` (`AGENTS.md`).
- Google Cloud: read-only by default. Agents may `terraform init/validate/plan` with a token from
  `gcloud auth print-access-token --impersonate-service-account=terraform@spurby-phi.iam.gserviceaccount.com --configuration=spurby-phi`.
  **`terraform apply`, enforcing the perimeter, IAM changes and enabling APIs need a person's
  go-ahead in chat.** Never create service-account keys (blocked anyway). Never commit account
  emails, organization, folder or billing IDs (they're in the git-ignored `secrets/gcp.local.md`;
  pass them as `-var`).
- Never put real customer data anywhere while building; fixtures are synthetic.
- Before handing back: the checks in `AGENTS.md` for every package touched, plus the phase's exit
  tests. Report: done per phase against its exit criteria, commits, migrations, env vars, contracts
  others need, checks run, what's left or blocked.

**Merge order** (one integrator, usually a person or a coordinating agent): `todo10-studio-defs` →
`todo10-artifacts` → `todo10-boundary` (wire the `Signer`) → `todo10-viewers` → `todo10-gcp`. Run the
full `AGENTS.md` check list on `main` after each merge.
