# Inkling

**One labelling studio for every kind of medical and scientific data.** Drop a folder of
X-rays, CT series, ECGs, pathology slides or video. Inkling sorts the files by type, sets up a
Studio for each, and an AI assistant prelabels them with Meta's SAM 3.1 and Muse models. Every
suggestion arrives as a preview that a person accepts or rejects.

Live: [app.inklinglabs.io](https://app.inklinglabs.io) · Site: [inklinglabs.io](https://inklinglabs.io)

## Meta models

Both models are called through the [Meta Model API](https://dev.meta.ai/docs/sam/overview)
(`https://api.meta.ai/v1/responses`, an OpenAI-style Responses API). Keys are only ever env
vars or Secret Manager entries; none is in the repo.

| Model | Used for | Wired in | Key |
|---|---|---|---|
| `muse-spark-1.3` (default), `muse-wonder-1.0` | the assistant: planning, tool calls, Studio setup | [`apps/agent/src/agent/providers/muse.ts`](apps/agent/src/agent/providers/muse.ts), default in [`providers/index.ts`](apps/agent/src/agent/providers/index.ts) | `STUDIO_AGENT_MUSE_API_KEY` |
| `sam-3.1` | mask proposals ("prelabel the lungs") | [`plugins/segmentation/.../providers/meta_sam.py`](plugins/segmentation/src/studio_plugin_segmentation/providers/meta_sam.py) | `STUDIO_API_PROVIDER_KEY_META` |

On Cloud Run the model is chosen in
[`infra/terraform/ai/run-variables.tf`](infra/terraform/ai/run-variables.tf) (`agent_model`,
default `muse:muse-spark-1.3`) and the key is mounted from secret `run-agent-muse-api-key` in
[`infra/terraform/ai/run.tf`](infra/terraform/ai/run.tf). Locally, copy
[`secrets/models.env.example`](secrets/models.env.example) to `secrets/models.env`. OpenAI and
Anthropic models work too (`STUDIO_AGENT_MODEL=openai:<model>`).

SAM docs: [overview](https://dev.meta.ai/docs/sam/overview) ·
[segmenting](https://dev.meta.ai/docs/sam/segmenting) ·
[reading the output](https://dev.meta.ai/docs/sam/reading-segmentation) ·
[pricing and limits](https://dev.meta.ai/docs/pricing-rate-limits).

## Architecture

Three lanes. Customer data and the AI never share a cloud project.

**Studio.** The web app (`apps/web`) runs an **environment**: a JSON file that picks which
plugins a Studio shows and how they're laid out. A chest X-ray Studio and a pathology Studio
are two environments, not two apps. Each data type is a plugin under `plugins/`.

**Kernel.** The api (`apps/api`, FastAPI) owns projects, files, annotations, jobs and the audit
log. Uploads go to object storage; the worker (`apps/worker`) converts files (DICOM, slides,
video) and runs plugin jobs such as SAM 3.1 segmentation. Versioning (`apps/versioning`, Go)
gives datasets branches, commits, reviews and merges. All of it runs in the customer-data
project: Cloud Run, Cloud SQL, KMS-encrypted buckets.

**Assistant.** The agent (`apps/agent`, Node) runs Muse in a separate AI project. It sees
file names, counts and annotation summaries, never sample bytes. It acts only through the
kernel's tools (boot a Studio, start a job, propose labels), and every change is a preview a
person approves. Runs stream to the browser over SSE.

## Layout

```
.
├── README.md
├── AGENTS.md                 rules for AI coding agents in this repo
├── package.json              pnpm + Turborepo scripts (dev, test, regen, checks)
├── pyproject.toml            uv workspace (Python 3.12)
│
├── apps/                     deployables: one Dockerfile, one Cloud Run service each
│   ├── web/                  the Studio · React 19, Vite, zustand, Tailwind + shadcn
│   │   └── src/
│   │       ├── studio/       the shell: projects, Files, the assistant panel
│   │       └── extension-host/   loads plugins, turns an environment into a Studio
│   ├── api/                  the kernel · FastAPI, Postgres
│   │   └── src/studio_api/
│   │       ├── routes/       HTTP: projects, files, assets, commands, jobs, events (SSE)
│   │       └── kernel/       imports, boots, jobs, annotations, audit
│   ├── worker/               file conversion + plugin jobs from the queue
│   ├── agent/                the assistant · pi agent, Muse, SSE run streams
│   │   └── src/agent/providers/   muse, openai, anthropic
│   ├── versioning/           dataset versioning · Go
│   ├── pipeline/             durable ingest workflows · Go, DBOS
│   ├── mcp/                  MCP server, so Claude Desktop or Cursor can drive the Studio
│   └── site/                 the marketing site
│
├── plugins/                  one data type or tool each: plugin.yaml, ui/, optional worker
│   ├── image2d/              2-D images and DICOM: window/level, boxes, polygons
│   ├── volume/               CT and MRI: MPR views, 3-D, masks
│   ├── cine/                 cardiac cine loops
│   ├── cardiac-metrics/      volumes and ejection fraction on top of cine
│   ├── timeseries/           ECG and signals: intervals and events
│   ├── video/                frame-accurate video segments
│   ├── wsi/                  whole-slide pathology, GeoJSON import/export
│   ├── text-spans/           span labels in text
│   ├── table/, chart/        tabular and chart data
│   ├── segmentation/         SAM 3.1 mask proposals (Python worker)
│   ├── dicom-export/         DICOM SEG/SR export
│   └── _template/            starting point: node tools/new-plugin.mjs <name>
│
├── packages/                 shared libraries, never deployed alone
│   ├── contracts/            canonical types and zod schemas; naming.ts holds the product name
│   ├── plugin-ui-sdk/        all a plugin UI may import: defineModule, useHost
│   ├── plugin-sdk/           Python SDK for plugin workers
│   ├── ui/                   shadcn components and icons
│   ├── renderers/            Cornerstone, 2-D overlay, timeline, viewport chrome, IO
│   ├── studio-tools/         the Studio tools shared by agent and mcp
│   ├── agent-protocol/       wire types between web and agent
│   ├── environment-core/     environment validation shared by clients
│   ├── api-client/           typed client, generated from the OpenAPI spec
│   ├── signing/              Ed25519 dev key, Cloud KMS in production
│   └── observability-*/      JSON logs and OpenTelemetry (TS and Python)
│
├── registry/
│   ├── presets/              ready-made environments: image-2d, ecg, pathology, volume-3d…
│   ├── recipes/              multi-step recipes the assistant can run
│   └── index.json            plugin index (generated)
│
├── schemas/                  generated JSON Schemas + OpenAPI; source of truth for TS, Python, Go
│
├── infra/
│   ├── terraform/
│   │   ├── org/              folders, org policies, VPC Service Controls perimeter
│   │   ├── phi/              customer data: Cloud Run, Cloud SQL, KMS, buckets, LB
│   │   ├── ai/               the agent's project: Cloud Run, model keys, sandboxes
│   │   └── data/             curated data: public sets, synthetic fixtures, de-identified releases
│   ├── docker/               compose stack: the whole product on :8080
│   ├── k8s/                  Kustomize base + dev/staging/prod overlays
│   └── workos/               sign-in emulator config for local dev
│
├── .github/workflows/
│   ├── images.yml            build and push every image
│   ├── ci.yml                typecheck, lint, test, boundary and generated-file checks
│   └── deploy.yml            migrations, then Cloud Run
│
├── secrets/                  *.env.example templates; real *.env are git-ignored
├── tools/                    dev runner, seeds, codegen, boundary and naming checks
└── tests/e2e/                end-to-end tests across services
```

## Spin-up Instructions

Judges can use the [live app](https://app.inklinglabs.io) without installing anything. The
steps below run the same product locally.

### Prerequisites

- Node 24 (`.nvmrc`) and pnpm
- Python 3.12 and [uv](https://docs.astral.sh/uv/)
- ffmpeg, for video (`brew install ffmpeg`)
- Docker, only for the compose stack

### Local

1. Install and fetch the sample data (public and synthetic, into `seed-data/`, git-ignored).

```bash
pnpm install && uv sync
pnpm seeds
```

2. Add a Meta Model API key. Without one the assistant runs a free scripted model and SAM is off.

```bash
cp secrets/models.env.example secrets/models.env
#   STUDIO_AGENT_MUSE_API_KEY=...        the assistant
echo 'STUDIO_API_PROVIDER_KEY_META=...' > secrets/api.env   # SAM 3.1
```

3. Start everything with hot reload: web on :5173, api on :8000, agent on :8100, and the worker.
The api falls back to SQLite and local files, so no database is needed.

```bash
pnpm dev                  # dev sign-in
pnpm dev:signin           # real WorkOS sign-in (secrets/workos.env)
```

4. Open http://localhost:5173, create a project, drop the `seed-data/` folder into the
assistant panel and ask: *"Prelabel the lungs in these chest X-rays."*

To run the product from its images behind one router, like production:

```bash
pnpm stack:up             # http://localhost:8080
pnpm stack:down
```

### Cloud

Every push to `main` builds the images (`images.yml`), runs CI and deploys to Cloud Run
(`deploy.yml`), running the api, versioning and pipeline migrations first. Infrastructure is
Terraform: apply `infra/terraform/org`, then `phi` and `ai`; each folder's README lists its
variables. Secret values go into Secret Manager by hand, never through Terraform state.

### Checks

```bash
pnpm affected             # typecheck, lint and test only what changed vs origin/main
pnpm typecheck && pnpm test && pnpm lint
pnpm check:boundaries && pnpm check:names && pnpm check:generated
uv run pytest apps/api    # kernel tests
```
