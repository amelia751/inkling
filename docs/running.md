# Running the product

Three ways, from lightest to most production-like. All of them run from the repo root.

| | What runs where | Use it for |
|---|---|---|
| 1. `pnpm dev` + `pnpm infra:up` | apps on the host with hot reload; Postgres, Redis and S3 in Docker | daily work |
| 2. `pnpm stack:up` | every app from its image, behind one router on :8080 | reproducing production issues, cross-service e2e |
| 3. `kubectl apply -k infra/k8s/overlays/dev` | every app on a local kind/k3d cluster | Kubernetes manifests, scaling, probes |

Prerequisites: Node 24 (`.nvmrc`), pnpm (version pinned in `package.json`), uv, Docker. Then:

```sh
pnpm install && uv sync
pnpm seeds                  # sample datasets into seed-data/ (see seed-data/README.md)
```

Secrets for local work live in `secrets/*.env` (git-ignored; see `secrets/README.md`). None of
the three modes needs a real key: without a model or Daytona key the agent runs scripted or
with sandboxes off.

---

## 1. `pnpm dev` + `pnpm infra:up` (daily work)

```sh
pnpm infra:up       # docker compose -f infra/docker/compose.yaml --profile deps up -d --wait
pnpm dev            # web (Vite :5173), api (:8000), agent (:8100), worker
pnpm infra:down     # stop the deps (add `-v` to the compose command to drop their data)
```

`infra:up` starts, and waits until healthy:

| Service | Host port | Credentials (dev placeholders) |
|---|---|---|
| Postgres 17 | 5432 | user `studio`, password `dev-only-pg-password`, databases `studio` and `agent` |
| Redis 7 | 6379 | none |
| S3-compatible store (RustFS) | 9000 (API), 9001 (console) | access key `dev-only-s3-access`, secret `dev-only-s3-secret` |
| `s3-init` (one-shot) | | creates the buckets `assets`, `inkling-objects`, `inkling-manifests` |

MinIO's images are no longer published on Docker Hub, so the stack uses RustFS (already pinned
by `apps/versioning`'s integration tests). Any S3-compatible endpoint works.

Point the apps at the deps through env (prefix from `schemas/naming.json`), e.g. in
`secrets/api.env`:

```sh
INKLING_API_DATABASE_URL=postgresql+psycopg://studio:dev-only-pg-password@localhost:5432/studio
INKLING_REDIS_URL=redis://localhost:6379/0
INKLING_BLOB_STORE=s3
INKLING_S3_ENDPOINT=http://localhost:9000
AWS_ACCESS_KEY_ID=dev-only-s3-access
AWS_SECRET_ACCESS_KEY=dev-only-s3-secret
```

Without them each app keeps its zero-infra dev defaults (SQLite and local files for the api,
the file store for the agent, the Vite seed server for `/seed`).

**Seed assets in object storage.** Production serves `/seed/*` from the `assets` bucket. Upload
`seed-data/` once (same keys as `seed-data/manifest.json`); `pnpm seeds:upload` fetches and
uploads, `--upload-only` uploads what's already in `seed-data/`:

```sh
export INKLING_S3_ENDPOINT=http://localhost:9000 AWS_ACCESS_KEY_ID=dev-only-s3-access \
  AWS_SECRET_ACCESS_KEY=dev-only-s3-secret
pnpm seeds:upload                              # or: uv run tools/fetch-seeds.py --upload-only
```

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
| `agent` | `studio-agent:dev` | :8100; `AGENT_MODEL=scripted`, `AGENT_SANDBOX=off` by default |
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
| worker | `env/worker.env` |
| agent | `env/agent.env`, `secrets/agent.env`, `secrets/models.env`, `secrets/daytona.env` |
| web | `env/web.env`, `secrets/agent.env` (only `INTERNAL_AGENT_SERVICE_TOKEN`) |
| versioning, versioning-* | `env/versioning.env` |

To use a real model and sandboxes, set `AGENT_MODEL=<provider:model>` and
`AGENT_SANDBOX=daytona` in `secrets/agent.env` next to the keys in `secrets/models.env` and
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
for app in web api agent worker versioning; do
  docker build -f apps/$app/Dockerfile -t studio-$app:dev --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
  kind load docker-image studio-$app:dev --name studio
done

# Deploy (namespace studio-dev): apps, in-cluster Postgres/Redis/S3, migrations, Ingress
kubectl apply -k infra/k8s/overlays/dev
# Once per cluster: the api → versioning JWT key pair (api and versioning wait for it)
pnpm k8s:dev-keys
kubectl -n studio-dev get pods -w
open http://localhost:8081
```

With k3d: `k3d cluster create studio -p "8081:80@loadbalancer" --k3s-arg "--disable=traefik@server:0"`,
`k3d image import studio-<app>:dev -c studio`, then install ingress-nginx with its cloud
manifest and KEDA as above.

Notes:

- The dev overlay runs one replica of each app (HPAs removed), the worker from zero via KEDA,
  the agent scripted with sandboxes off, and fixed `dev-only-…` Secrets from a
  `secretGenerator`. For real model/Daytona keys, replace the agent's Secret after applying
  (the next `apply -k` restores the placeholders):

  ```sh
  kubectl -n studio-dev create secret generic agent-secrets \
    --from-literal=INTERNAL_AGENT_SERVICE_TOKEN=dev-only-agent-service-token \
    --from-literal=AGENT_DATABASE_URL=postgres://studio:dev-only-pg-password@postgres:5432/agent \
    --from-env-file=secrets/models.env --from-env-file=secrets/daytona.env \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n studio-dev set env deployment/agent AGENT_MODEL=openai:gpt-6.1-sol AGENT_SANDBOX=daytona
  ```

- Migration Jobs (`api-migrate`, `versioning-migrate`) are garbage-collected 5 minutes after
  they finish, so re-applying runs them again (they're idempotent). Under Argo CD they're
  PreSync hooks.
- Seeds: `kubectl -n studio-dev port-forward svc/s3 9000`, then upload as in mode 1.
- Try scaling: `kubectl -n studio-dev scale deployment/api --replicas=3`.
- Tear down: `kind delete cluster --name studio`.

Staging and prod overlays, Secrets, scaling knobs and adding an app: `infra/k8s/README.md`.
