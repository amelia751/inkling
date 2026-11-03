# Running the product

Three ways, from lightest to most production-like. All of them run from the repo root.

| | What runs where | Use it for |
|---|---|---|
| 1. `pnpm dev` + `pnpm infra:up` | apps on the host with hot reload; Postgres, Redis and S3 in Docker | daily work |
| 2. `pnpm stack:up` | every app from its image, behind one router on :8080 | reproducing production issues, cross-service e2e |
| 3. `kubectl apply -k infra/k8s/overlays/dev` | every app on a local kind/k3d cluster | Kubernetes manifests, scaling, probes |

Prerequisites: Node 24 (`.nvmrc`), pnpm (version pinned in `package.json`), uv, and Docker for
modes 2 and 3 and `infra:up`. Then:

```sh
pnpm install && uv sync
pnpm seeds                  # sample datasets into seed-data/ (see seed-data/README.md)
pnpm doctor                 # checks the converters, the database and the seeds; prints each fix
```

The worker's converters are capabilities it reports to the api at start
(`POST /api/v1/workers/capabilities`, kept in the database with a TTL; its `/readyz` lists them).
A file whose converter no worker has stays **Waiting for a converter** (not failed) and converts
by itself once a worker that has it starts. `pnpm dev` prints what's missing.

| Converter | For | Install | Required |
|---|---|---|---|
| ffmpeg + ffprobe | AVI/MOV/MKV → MP4 (constant frame rate at the source fps) | `brew install ffmpeg` / `apt-get install ffmpeg` (in the worker image) | for video |
| OpenSlide (`openslide-python` + `openslide-bin`) | slide header (mpp, levels), fallback tiling | `uv sync` (wheels bundle libopenslide) | for slides |
| libvips (`pyvips` + `pyvips-binary`) | slide → DZI with `dzsave` (fast path) | `uv sync` (wheels bundle libvips) | no (OpenSlide tiles without it, slower) |
| dciodvfy (dicom3tools) | DICOM conformance checks | [dicom3tools](https://www.dclunie.com/dicom3tools.html) | no (checks are skipped) |

Secrets for local work live in `secrets/*.env` (git-ignored; see `secrets/README.md`). None of
the three modes needs a real key: without a model or Daytona key the agent runs scripted or
with sandboxes off. For a real model see [Real model](#real-model); for the real sign-in, [Sign in
locally](#sign-in-locally).

---

## 1. `pnpm dev` + `pnpm infra:up` (daily work)

```sh
pnpm infra:up       # docker compose -f infra/docker/compose.yaml --profile deps up -d --wait
pnpm dev            # web (Vite :5173), api (:8000), agent (:8100), worker; dev auth, scripted model
pnpm dev:signin     # the same with the real WorkOS sign-in (see "Sign in locally")
pnpm infra:down     # stop the deps (add `-v` to the compose command to drop their data)
```

`infra:up` starts, and waits until healthy:

| Service | Host port | Credentials (dev placeholders) |
|---|---|---|
| Postgres 17 | 5432 | user `studio`, password `dev-only-pg-password`, databases `studio` and `agent` |
| Redis 7 | 6379 | none |
| S3-compatible store (RustFS) | 9000 (API), 9001 (console) | access key `dev-only-s3-access`, secret `dev-only-s3-secret` |
| `s3-init` (one-shot) | | creates the buckets `assets`, `studio-objects`, `studio-manifests` |
| WorkOS Emulate (`workos-emulate`) | 4100 | key `sk_test_default`, any client id; users and orgs from `infra/workos/emulate.yaml` ([Signing in](#signing-in)) |

MinIO's images are no longer published on Docker Hub, so the stack uses RustFS (already pinned
by `apps/versioning`'s integration tests). Any S3-compatible endpoint works.

Point the apps at the deps through env (prefix from `schemas/naming.json`), e.g. in
`secrets/api.env`:

```sh
STUDIO_API_DATABASE_URL=postgresql+psycopg://studio:dev-only-pg-password@localhost:5432/studio
STUDIO_REDIS_URL=redis://localhost:6379/0
STUDIO_BLOB_STORE=s3
STUDIO_S3_ENDPOINT=http://localhost:9000
AWS_ACCESS_KEY_ID=dev-only-s3-access
AWS_SECRET_ACCESS_KEY=dev-only-s3-secret
```

Without them each app keeps its zero-infra dev defaults (SQLite and local files for the api,
the file store for the agent, the Vite seed server for `/seed`).

**Seed assets in object storage.** Production serves `/seed/*` from the `assets` bucket. Upload
`seed-data/` once (same keys as `seed-data/manifest.json`); `pnpm seeds:upload` fetches and
uploads, `--upload-only` uploads what's already in `seed-data/`:

```sh
export STUDIO_S3_ENDPOINT=http://localhost:9000 AWS_ACCESS_KEY_ID=dev-only-s3-access \
  AWS_SECRET_ACCESS_KEY=dev-only-s3-secret
pnpm seeds:upload                              # or: uv run tools/fetch-seeds.py --upload-only
```

Google Cloud takes the target as a URL and gets public templates only
(`--upload-only=gs://<bucket>/samples/`, `--dry-run` to preview); see "Sample templates" in
`docs/deployment-gcp.md`.

### Real model

`pnpm dev` runs the agent on `STUDIO_AGENT_MODEL` if set; otherwise on the agent's default model
when a provider key (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) is in your shell or `secrets/`, and on
the `scripted` model (free, deterministic) when there's no key. `pnpm dev` also points the web at
the api it starts (`STUDIO_API_URL=http://127.0.0.1:8000`), not the seed server. To pick a model, copy `secrets/models.env.example` to
`secrets/models.env` and set one provider key and the model:

```sh
ANTHROPIC_API_KEY=sk-ant-…                       # or OPENAI_API_KEY=… with an openai: model
STUDIO_AGENT_MODEL=anthropic:claude-sonnet-5-5  # provider:model from STUDIO_AGENT_MODEL_ALLOWLIST
```

`pnpm dev` (`tools/dev.mjs`) sees the model in the file and stops defaulting to `scripted`; the
agent reads the key and model from `secrets/*.env` itself and refuses a model outside its allowlist
(`apps/agent/src/config.ts`). It prints which model it runs (never the key). `GET
/api/agent/status` says `provider` and `model`. A value exported in your shell wins over the file;
`STUDIO_AGENT_MODEL=scripted pnpm dev` goes back to scripted without editing it. Real-model runs
cost money: keep them few (`AGENTS.md`, "Testing the product"); tests and e2e always use
`scripted`.

### Seed mode, or the API and worker

The web app runs in one of two modes. Which one depends on whether the Vite dev server knows
where the API is (`STUDIO_API_URL`).

**Seed mode** (`pnpm --filter @studio/web dev`, or `pnpm exec vite` in `apps/web`). Vite's seed
server stands in for the API, read-only (`apps/web/dev/project-stand-in.ts`). Each seed in
`seed-data/manifest.json` becomes one project, one source, one dataset and one task, all with
the seed's id. These work:

- Home and All projects;
- Overview, including the resume card (resume state is kept in `seed-data/.resume/`);
- Sources browsing: the tree, listing, inspector, Quick Look and search;
- the Studio, with annotations saved to `seed-data/.annotations/`;
- Datasets, Review and Activity, read-only.

Every other write answers `501 needs the API`, and the page says so: creating or editing a
project, adding data, creating datasets or tasks, clearing a privacy hold, and confirming or
dismissing a proposal. `apps/web/e2e` runs in this mode.

**With the API and worker.** These need the API: creating projects, uploads and import
sessions, Explore and its proposals, confirming, and new datasets and tasks.
Inspection of uploaded files (kinds, facts, thumbnails, privacy flags and the proposals built
from them) also needs the worker. Without a worker, uploads stay "Checking…" and never reach a
task.

`pnpm dev` starts all four apps, but Vite only proxies to the API when told where it is:

```sh
STUDIO_API_URL=http://127.0.0.1:8000 pnpm dev
```

None of this needs Docker: without the env above, the API uses SQLite and local files under
`apps/api/.data/`, and the worker reaches a loopback API with the dev worker token. To run the
three by hand (as the `tests/e2e/` docstrings do, each on its own ports and data dir), from the
repo root:

```sh
STUDIO_API_DATA_DIR=/tmp/studio-dev uv run --package studio-api uvicorn studio_api.app:app --port 8205
uv run --package studio-worker studio-worker --kernel http://127.0.0.1:8205
cd apps/web && STUDIO_API_URL=http://127.0.0.1:8205 pnpm exec vite --port 5205 --strictPort
```

Add `STUDIO_E2E=1` to the Vite line for a frozen dev server, and `STUDIO_AGENT_URL` (with
`STUDIO_AGENT_TOKEN`) to reach an agent elsewhere than :8100. `tests/e2e/sources_test.py`,
`mixed_import_test.py`, `review_activity_test.py` and the project part of `agent_test.py` run
against this setup; their docstrings give the exact commands.

Versions (branches, reviews and releases on Datasets › Versions) also need the API, plus the
versioning service: `pnpm infra:up` runs `apps/versioning`, and without Docker or Go,
`STUDIO_API_VERSIONING_URL=memory:` on the API line gives it an in-process stand-in whose state
is lost on restart (`tests/e2e/versioning/README.md`). Without either, the Versions tab says
versions aren't turned on; saving still works.

The worker's inspection reads DICOM, NIfTI, images and spreadsheets with its own Python
dependencies; it probes video only when `ffprobe` is on the `PATH`.

**Emptying the Trash (todo7).** Files moved to Trash stay 30 days; the worker's
`files.empty_trash` job purges older items, deleting bytes only when no other file, version,
dataset or annotation uses them (the kept ones are listed in the job's result). In the stacks it
runs daily on its own (the worker asks the kernel hourly; the kernel runs it at most once a day).
To run it now, with the worker token:

```sh
curl -X POST $API/api/v1/worker/scheduled/files.empty_trash -H "X-Worker-Token: $TOKEN" \
  -H 'Content-Type: application/json' -d '{"force": true, "days": 0}'
```

**Empty Trash** in the Data section (Trash view) does the same for one project straight away,
after a confirmation naming any bytes that are kept.

Upload limits, read by the API (`apps/api/src/studio_api/config.py`):

| Env var | Default | Meaning |
|---|---|---|
| `STUDIO_API_UPLOAD_MAX_FILE_BYTES` | 2147483648 (2 GB) | largest file an import session accepts |
| `STUDIO_API_URL_IMPORT_MAX_BYTES` | 5368709120 (5 GB) | largest file an import from a link (`POST …/imports/url`) accepts |
| `STUDIO_API_UPLOAD_MAX_SESSION_FILES` | 20000 | most files in one import session |

Uploaded bytes go to the API's data BlobStore (`STUDIO_API_DATA_DIR` locally, the `assets`
bucket under its data prefix with `STUDIO_BLOB_STORE=s3`), never to `/seed`.

## 2. `pnpm stack:up` (prod-like, local)

```sh
pnpm stack:up       # builds the images, starts deps + apps, waits until healthy
open http://localhost:8080
pnpm stack:down     # (docker compose -f infra/docker/compose.yaml --profile full down -v to drop data)
```

Profile `full` of `infra/docker/compose.yaml`: the deps above plus

| Service | Image | Notes |
|---|---|---|
| `api-migrate` | `studio-api:dev` | `alembic upgrade head`, then exits |
| `api` | `studio-api:dev` | :8000 inside the network |
| `worker` | `studio-worker:dev` | health on :8081; prebuilt plugin environments |
| `agent` | `studio-agent:dev` | :8100; `STUDIO_AGENT_MODEL=scripted`, `STUDIO_AGENT_SANDBOX=off` by default |
| `web` | `studio-web:dev` | nginx: the SPA, `/config.json` (from `infra/docker/web/config.json`), `/api/agent` proxy |
| `versioning-keys`, `versioning-bootstrap`, `versioning-migrate` | `studio-versioning:dev` | dev JWT key pair, roles + schema, migrations |
| `versioning` | `studio-versioning:dev` | :8090 inside the network (called by api only) |
| `router` | `caddy` | **:8080 on the host**, same paths as the Ingress |

The router's paths match the Kubernetes Ingress: `/api/agent` → web (whose nginx adds the
agent's bearer token and maps to the agent's `/v1`), `/api` and `/seed` → api, `/` → web.

Every app container runs with a read-only root filesystem, a tmpfs `/tmp`, no capabilities and
`no-new-privileges`, like in Kubernetes.

Env comes from `infra/docker/env/<app>.env` (committed, non-secret `dev-only-…` defaults), then
from the git-ignored `secrets/*.env` files when present (a later file wins):

| Service | Loads |
|---|---|
| api, api-migrate | `env/api.env`, `secrets/api.env` |
| worker | `env/worker.env`, `secrets/worker.env` |
| agent | `env/agent.env`, `secrets/agent.env`, `secrets/models.env`, `secrets/daytona.env` |
| web | `env/web.env`, `secrets/agent.env` (only `STUDIO_AGENT_TOKEN`) |
| versioning, versioning-* | `env/versioning.env` |

To use a real model and sandboxes, set `STUDIO_AGENT_MODEL=<provider:model>` and
`STUDIO_AGENT_SANDBOX=daytona` in `secrets/agent.env` next to the keys in `secrets/models.env` and
`secrets/daytona.env`. Seeds: run `pnpm seeds:upload` as in mode 1 (the stack's S3 is on the
same host port).

Useful: `GIT_SHA=$(git rev-parse --short HEAD) pnpm stack:up` stamps `/version`;
`STACK_PORT`, `POSTGRES_PORT`, `REDIS_PORT`, `S3_PORT` move host ports; `docker compose -f
infra/docker/compose.yaml --profile full logs -f api` follows one service. Build one image by
hand with `docker build -f apps/<app>/Dockerfile -t studio-<app>:dev --build-arg GIT_SHA=$(git
rev-parse --short HEAD) .` (context is always the repo root).

## 3. `kubectl apply -k infra/k8s/overlays/dev` (kind or k3d)

Needs `kind` (or k3d), `kubectl` and `helm`.

```sh
# Cluster with the ingress ports on the host
cat <<'EOF' | kind create cluster --name studio --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - { containerPort: 80, hostPort: 8081, protocol: TCP }
EOF

# ingress-nginx (kind flavour) and KEDA (the worker's ScaledObject)
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=ready pod -l app.kubernetes.io/component=controller --timeout=180s
helm repo add kedacore https://kedacore.github.io/charts && helm repo update
helm install keda kedacore/keda --namespace keda --create-namespace --wait

# Images: build locally, then load them into the cluster's nodes
for app in web api agent worker versioning pipeline; do
  docker build -f apps/$app/Dockerfile -t studio-$app:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
  kind load docker-image studio-$app:dev --name studio
done

# Deploy (namespace studio-dev): apps, in-cluster Postgres/Redis/S3, migrations, Ingress
kubectl apply -k infra/k8s/overlays/dev
# Once per cluster: the service-JWT key pairs (api and pipeline signers; versioning-jwks and
# api-jwks). api, versioning and pipeline wait for them.
pnpm k8s:dev-keys
kubectl -n studio-dev get pods -w
open http://localhost:8081
```

With k3d: `k3d cluster create studio -p "8081:80@loadbalancer" --k3s-arg "--disable=traefik@server:0"`,
`k3d image import studio-<app>:dev -c studio`, then install ingress-nginx with its cloud
manifest and KEDA as above.

Notes:

- The dev overlay runs one replica of each app (HPAs removed), one worker scaled up by KEDA,
  the agent scripted with sandboxes off, and fixed `dev-only-…` Secrets from a
  `secretGenerator`. For real model/Daytona keys, replace the agent's Secret after applying
  (the next `apply -k` restores the placeholders):

  ```sh
  kubectl -n studio-dev create secret generic agent-secrets \
    --from-literal=STUDIO_AGENT_TOKEN=dev-only-agent-service-token \
    --from-literal=STUDIO_AGENT_DATABASE_URL=postgres://studio:dev-only-pg-password@postgres:5432/agent \
    --from-env-file=secrets/models.env --from-env-file=secrets/daytona.env \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n studio-dev set env deployment/agent STUDIO_AGENT_MODEL=openai:gpt-6.1-sol STUDIO_AGENT_SANDBOX=daytona
  ```

- Migration Jobs (`api-migrate`, `versioning-migrate`, `pipeline-migrate`) are garbage-collected
  5 minutes after they finish, so re-applying runs them again (they're idempotent). Under Argo CD
  they're PreSync hooks.
- The pipeline (`apps/pipeline`, :8095, called by the api only) runs one replica in dev. Its
  database roles come from the `db-bootstrap` Job, which the dev overlay runs on apply (in
  staging and on Google Cloud it is suspended until a person starts it): `pipeline_app`, schema
  `pipeline` in `studio`, owner of `pipeline_engine` (created by the dev Postgres's `init.sql`,
  so a Postgres volume from before the pipeline needs `CREATE DATABASE pipeline_engine` once).
  `pipeline-migrate` retries until the roles exist. Check it with
  `kubectl -n studio-dev port-forward svc/pipeline 8095` and `curl localhost:8095/readyz`.
- Seeds: `kubectl -n studio-dev port-forward svc/s3 9000`, then upload as in mode 1.
- Try scaling: `kubectl -n studio-dev scale deployment/api --replicas=3`.
- Tear down: `kind delete cluster --name studio`.

Staging and prod overlays, Secrets, scaling knobs and adding an app: `infra/k8s/README.md`.

## Dev mode and signed-in stages

There are two modes and nothing in between (todo/todo22.md D1). `pnpm dev:signin` is the one
crossover: the real sign-in, still with local data.

| | `pnpm dev` | `pnpm dev:signin` | `workos` (every deployed stage: staging, production) |
|---|---|---|---|
| Runs on | a laptop only | a laptop only | Cloud Run (`docs/deployment-gcp.md`) |
| Sign-in | none: trusted dev headers (`STUDIO_API_AUTH_MODE=dev`) | WorkOS **staging** AuthKit (or Emulate), `AUTH_MODE=workos` | WorkOS AuthKit (staging or production environment) |
| Who you are | `user:local-expert`, or a per-tab `user:dev-<id>` ("Start as a new person") | the person who signed in, in their organization | the person who signed in, in their organization |
| api database | SQLite in `apps/api/.data/` (or Postgres from `pnpm infra:up`) | the same local database | Cloud SQL Postgres (`JOB_QUEUE=sql`, `EVENT_BUS=sql`) |
| Blobs | local folder under `apps/api/.data/` (or the `infra:up` S3) | the same | Cloud Storage |
| Agent store | file store in `apps/agent/.data/` | the same | Postgres (`STUDIO_AGENT_STORE=postgres`) |
| Annotations without the kernel | `seed-data/.annotations` (Vite's file store, `STUDIO_WEB_ANNOTATIONS_DIR`) | the kernel | the kernel |
| Where the data lives | git-ignored folders on the laptop (`**/.data/`, `seed-data/`) | git-ignored folders on the laptop | the stage's own cloud project; never on a laptop |

- **A deployed stage refuses dev mode.** With `STUDIO_ENV=production` the api won't start with
  dev auth, trusted dev headers, a `sqlite:` database or the local blob store, and the agent
  won't start without `STUDIO_AGENT_AUTH_MODE=workos` and `STUDIO_AGENT_STORE=postgres`
  (todo22 W1). The error names the keys, never their values.
- **Dev data never meets cloud data** (D7). Local config never points at a deployed database,
  bucket or a WorkOS production key: `secrets/workos.env` holds **staging** keys only. Local data
  is never imported into a deployed stage; demo projects there are recreated from synthetic files.
- **Start over:** stop `pnpm dev`, then `pnpm dev:reset`. It asks first (`--yes` skips the
  question, `--dry-run` only lists) and removes `apps/api/.data`, `apps/agent/.data` and the dev
  annotations folder (`seed-data/.annotations`, or `STUDIO_WEB_ANNOTATIONS_DIR` when it is inside
  the repo). It never touches `secrets/` or the `seed-data/` samples, and refuses any path that
  resolves outside the repo. With Postgres from `pnpm infra:up`, `pnpm infra:down` and a volume
  removal reset that database too.

## Signing in

People sign in with WorkOS AuthKit (todo/todo9.md). The api has two modes,
`STUDIO_API_AUTH_MODE`:

| Mode | Who you are | Where |
|---|---|---|
| `dev` (default) | the dev principal, from trusted dev headers (`STUDIO_API_DEV_TRUST_HEADERS=1`); no sign-in page, `GET /api/auth/session` answers with every permission | `pnpm dev`, the seed-mode e2e suite, `stack:up`, the k8s `dev` and `staging` overlays, GKE until the flip |
| `workos` | whoever signed in through AuthKit; organization roles and permissions come from WorkOS, project roles from the api | WorkOS Emulate locally and in CI, WorkOS staging by hand, the `prod` overlay |

`workos` mode refuses to start without `STUDIO_API_WORKOS_API_KEY`, `…_CLIENT_ID`,
`…_COOKIE_PASSWORD` (a Fernet key) and `…_REDIRECT_URI`, or with dev headers trusted. The web,
agent and api must agree: the SPA's mode is `STUDIO_WEB_AUTH_MODE` (Vite) or `/config.json`'s
`auth.mode` (images), the agent's `STUDIO_AGENT_AUTH_MODE`. Never set the SDKs' unprefixed
`WORKOS_*` variables. Key names: `secrets/workos.env.example`; roles and permissions:
`infra/workos/`.

In `workos` mode the api also pulls the WorkOS Events API every 5 s
(`STUDIO_API_WORKOS_SYNC_INTERVAL_S`, 0 = off) into its mirror of users, organizations,
memberships and invitations, on one replica at a time, and reconciles everything once a day
(`apps/api/src/studio_api/auth/sync.py`). By hand: `uv run python -m studio_api.auth.sync
status|once|reconcile` from `apps/api`.

### Dev mode

Nothing to do. Everything in sections 1 to 3 runs this way. What it keeps where, and how to
start over (`pnpm dev:reset`): [Dev mode and signed-in stages](#dev-mode-and-signed-in-stages).

### WorkOS Emulate (offline, no account)

`pnpm infra:up` starts Emulate on :4100 with `infra/workos/emulate.yaml`: `admin@example.com`,
`member@example.com` and `billing@example.com` (passwords in `infra/workos/README.md`) in two
organizations. Point the api at it (in `secrets/api.env`, or `secrets/workos.env`):

```sh
STUDIO_API_AUTH_MODE=workos
STUDIO_API_DEV_TRUST_HEADERS=0
STUDIO_API_WORKOS_BASE_URL=http://localhost:4100/
STUDIO_API_WORKOS_API_KEY=sk_test_default
STUDIO_API_WORKOS_CLIENT_ID=client_emulated
STUDIO_API_WORKOS_ISSUER=http://localhost:4100/user_management/client_emulated
STUDIO_API_WORKOS_REDIRECT_URI=http://localhost:5173/api/auth/callback
STUDIO_API_PUBLIC_URL=http://localhost:5173
STUDIO_API_WORKOS_COOKIE_PASSWORD=<python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())">
```

and start the web with `STUDIO_API_URL=http://localhost:8000 STUDIO_WEB_AUTH_MODE=workos pnpm
dev` (the callback reaches the api through Vite's `/api` proxy, so it is same-origin). For the
agent, add `STUDIO_AGENT_AUTH_MODE=workos`, `STUDIO_AGENT_WORKOS_CLIENT_ID=client_emulated`,
`STUDIO_AGENT_WORKOS_BASE_URL=http://localhost:4100` and the same issuer to `secrets/agent.env`.
In `stack:up`, use `http://workos-emulate:4100/` as the base URL and `localhost:8080` for the
redirect and public URLs (commented in `infra/docker/env/api.env`); the issuer stays
`localhost:4100`.

Emulate signs anyone in as any seeded user and keeps everything in memory: a restart forgets
invitations and keys made since, and rotates its signing key (restart the api and agent too).
Tests sign in by password through the api, never through a login page (todo9 Phase 13).

### Sign in locally

One command runs the whole journey with the real AuthKit sign-in:

```sh
cp secrets/workos.env.example secrets/workos.env   # once: staging key, client id, cookie password
pnpm infra:up                                      # only for WorkOS Emulate (base URL in the file)
pnpm dev:signin                                    # http://localhost:5173 → sign in
```

`pnpm dev:signin` is `pnpm dev` with api, web and agent in `workos` mode: it loads
`secrets/workos.env` into all three (Vite reads only its process env) and defaults what they must
agree on, unless set in the shell or the file:

| Key | Default |
|---|---|
| `STUDIO_API_AUTH_MODE`, `STUDIO_WEB_AUTH_MODE`, `STUDIO_AGENT_AUTH_MODE` | `workos` |
| `STUDIO_API_DEV_TRUST_HEADERS` | `0` |
| `STUDIO_API_PUBLIC_URL` | `http://localhost:5173` |
| `STUDIO_API_WORKOS_REDIRECT_URI` | `<public URL>/api/auth/callback` |
| `STUDIO_API_URL` (Vite's api) | `http://localhost:8000` |
| `STUDIO_AGENT_WORKOS_CLIENT_ID`, `…_ISSUER`, `…_BASE_URL` | the api's `STUDIO_API_WORKOS_*` values |

It stops with the missing key names if `secrets/workos.env` lacks the api key, client id or cookie
password. With `STUDIO_API_WORKOS_BASE_URL` unset it talks to WorkOS **staging** (redirect
`http://localhost:5173/api/auth/callback` is registered there); set it to
`http://localhost:4100/` (and the Emulate issuer) for Emulate. `pnpm dev` stays dev auth for
everyday work and the e2e suites.

### WorkOS staging (real AuthKit)

For checking hosted pages, emails, SSO and Radar by hand. Copy `secrets/workos.env.example` to
`secrets/workos.env` and fill in the **staging** key (`sk_test_…`) and client id; leave
`STUDIO_API_WORKOS_BASE_URL` unset. The staging environment's Redirects tab lists
`http://localhost:5173/api/auth/callback` (and `:5175`), so keep that redirect URI and port. Use
your own test users; staging is shared, so don't delete organizations you didn't create. Roles
and permissions come from `infra/workos/seed.yml`; change them there, not on the dashboard.
Production keys (`sk_live_…`) never go on a laptop.

### Production (runbook)

The `prod` overlay runs `workos` mode against the WorkOS production environment; on Google Cloud
it is `infra/k8s/overlays/gke/phi/components/workos`, on by default (todo22 D2). The steps are in
`infra/k8s/README.md` ("WorkOS runbook"), in short:

- **Turning it on:** staging for a week first; seed and configure the production environment,
  add the `workos-secrets` version, enable the component (and the agent's mode in `gke/ai`), and
  check sign-in, invitations and API keys **while the ingress allow-list (`STUDIO_ALLOW_CIDRS`)
  is still on**. Remove the allow-list only afterwards, in its own change.
- **Rotating the cookie password** ends every session; rolling restart of api.
- **Rotating the API key** has no downtime: new key in, restart api and worker, then revoke the
  old one in the dashboard.
- **When WorkOS is down,** signed-in people keep working (local JWT checks, transient refresh
  errors keep the session); new sign-ins and member, invitation and key changes fail; the event
  sync catches up later. Don't restart pods.
- **Revoking a person everywhere:** remove the membership (or block the user), revoke their
  sessions and their API keys; access ends at the next refresh (≤ 5 min).
