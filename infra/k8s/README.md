# infra/k8s

Kustomize for every deployable app. How to run it on a local cluster is in
[`docs/running.md`](../../docs/running.md); this file covers secrets, scaling and adding an app.

```text
base/
  web/ api/ agent/ worker/ versioning/   Deployment, Service, ServiceAccount, PDB, ConfigMap,
                                         HPA (web, api, agent) or KEDA ScaledObject (worker)
  ingress.yaml                           /api/agent → web, /api and /seed → api, / → web
  jobs/                                  api-migrate, versioning-migrate (Jobs), agent-sweeper (CronJob)
  deps/                                  dev-only Postgres, Redis, S3-compatible store (RustFS) + bucket Job
components/network-policies/             default deny + per-app allow rules (staging, prod)
overlays/
  dev/        one replica each, base/deps, local `studio-<app>:dev` images, dev placeholder Secrets
  staging/    managed endpoints, digests, 2+ replicas, NetworkPolicies, TLS host
  prod/       same as staging with more replicas
check-no-secrets.mjs                     CI: fails on a committed Secret with data
```

Render or validate an overlay:

```sh
kubectl kustomize infra/k8s/overlays/dev          # or: pnpm k8s:build
kubectl kustomize infra/k8s/overlays/prod | docker run --rm -i ghcr.io/yannh/kubeconform:v0.7.0-alpine \
  -strict -summary -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
node infra/k8s/check-no-secrets.mjs
```

The cluster needs ingress-nginx, KEDA (for the worker's ScaledObject, and in staging/prod its
TriggerAuthentication), metrics-server (for the HPAs) and, in staging/prod, a CNI that enforces
NetworkPolicy and cert-manager (the Ingress asks for a `letsencrypt` ClusterIssuer).

## Secrets

Every app reads one Secret, `<app>-secrets`, through `envFrom` (listed after its ConfigMap, so a
key in the Secret wins). **No Secret is ever committed.** `node infra/k8s/check-no-secrets.mjs`
(run in CI) fails on any `kind: Secret` with `data`/`stringData` under `infra/`, and on a
`secretGenerator` literal that looks sensitive but isn't a marked `dev-only-…` placeholder.

- **dev overlay:** a `secretGenerator` with fixed, clearly marked local placeholders for the
  in-cluster deps. To use real model or Daytona keys on a dev cluster, replace `agent-secrets`
  after applying (see `docs/running.md`).
- **staging/prod:** create the Secrets out of band, for now by hand (below); move to the
  External Secrets Operator backed by the cloud secret manager once staging exists.

Key names per Secret (names only; env prefix `INKLING_` from `schemas/naming.json`):

| Secret | Keys | Notes |
|---|---|---|
| `web-secrets` | `INKLING_AGENT_TOKEN` | Same value as in `agent-secrets`: nginx adds it as the bearer on `/api/agent/*`. |
| `api-secrets` | `INKLING_API_DATABASE_URL`, `INKLING_API_SECRET_KEY`, `INKLING_API_WORKER_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Add `INKLING_REDIS_URL` here if Redis needs a password (overrides the ConfigMap). Omit the AWS keys when the pod uses workload identity. |
| `worker-secrets` | `INKLING_API_WORKER_TOKEN`, `KEDA_REDIS_PASSWORD` (staging/prod) | The worker token equals the api's. `KEDA_REDIS_PASSWORD` is read only by KEDA's TriggerAuthentication. Plugin provider keys are brokered by api, never mounted here. |
| `agent-secrets` | `INKLING_AGENT_TOKEN`, `INKLING_AGENT_DATABASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DAYTONA_API_KEY` | The only Secret with model and Daytona keys. Add `INKLING_AGENT_REDIS_URL` if Redis needs a password. Optional: `DAYTONA_API_URL`, `DAYTONA_TARGET`. |
| `versioning-secrets` | `INKLING_VERSIONING_DATABASE_URL` (role `versioning_app`), `INKLING_VERSIONING_MIGRATE_DATABASE_URL` (role `versioning_owner`), `INKLING_VERSIONING_S3_ACCESS_KEY_ID`, `INKLING_VERSIONING_S3_SECRET_ACCESS_KEY` | S3 keys scoped to the two versioning buckets. Add `INKLING_VERSIONING_REDIS_URL` if Redis needs a password. |
| `versioning-bootstrap-secrets` | `INKLING_VERSIONING_ADMIN_DATABASE_URL`, `INKLING_VERSIONING_OWNER_PASSWORD`, `INKLING_VERSIONING_APP_PASSWORD` | dev only (init container of `versioning-migrate`). In staging/prod a DBA runs `migrate bootstrap` once. |
| `studio-tls` | (type `kubernetes.io/tls`) | Issued by cert-manager for the Ingress host. |

The api signs every call to apps/versioning with an Ed25519 key: Secret `api-versioning-jwt`
(key `jwt.key`, PKCS8 PEM, mounted at `/etc/api/versioning`), with the public half in ConfigMap
`versioning-jwks` (key `jwks.json`, not secret). The JWKS `kid` must equal the api's
`INKLING_API_VERSIONING_JWT_KID` (`api` in `base/api/configmap.yaml`). Neither is in any
overlay; `node tools/versioning-keys.mjs --namespace <ns>` (`pnpm k8s:dev-keys` for
`studio-dev`) generates a pair and creates both without printing the key. To rotate without
downtime, add the new public key to `jwks.json` first, then swap the Secret and restart the api.

Creating them by hand (staging shown; values come from your secret manager, never a file in
the repo):

```sh
NS=studio-staging
TOKEN=$(openssl rand -base64 32)
kubectl -n $NS create secret generic agent-secrets \
  --from-literal=INKLING_AGENT_TOKEN="$TOKEN" \
  --from-literal=INKLING_AGENT_DATABASE_URL=… --from-literal=OPENAI_API_KEY=… \
  --from-literal=ANTHROPIC_API_KEY=… --from-literal=DAYTONA_API_KEY=…
kubectl -n $NS create secret generic web-secrets --from-literal=INKLING_AGENT_TOKEN="$TOKEN"
kubectl -n $NS create secret generic api-secrets --from-env-file=<(your-secret-manager export api)
# …and so on per the table. Rotate with `kubectl create … --dry-run=client -o yaml | kubectl apply -f -`,
# then `kubectl rollout restart deployment/<app>`.
```

## Scaling knobs

| App | Mechanism | Base | staging | prod | Notes |
|---|---|---|---|---|---|
| web | HPA, CPU 70 % | 2–6 | 2–4 | 3–10 | Static files and the agent proxy; cheap. |
| api | HPA, CPU 70 % | 2–10 | 2–6 | 3–20 | Stateless (Postgres, S3, Redis). |
| agent | HPA, CPU 70 % | 2–10 | 2–6 | 3–20 | Scale-down stabilization 600 s and 1 pod/min, so long SSE runs aren't cut often; `terminationGracePeriodSeconds: 120` with `INKLING_AGENT_SHUTDOWN_GRACE_S=100`. |
| worker | KEDA `redis` scaler on list `inkling:jobs:ready` | 0–10, 1 pod per 5 queued jobs | 0–6 | 0–30 | `pollingInterval` 10 s, `cooldownPeriod` 300 s before scaling to zero; grace 300 s. |
| versioning | fixed replicas | 2 | 2 | 3 | River jobs run in-process; add an HPA when load needs it. |

Where to change them: `minReplicas`/`maxReplicas`/`averageUtilization` in `base/<app>/hpa.yaml`
(and the overlay patches), `listLength`/`maxReplicaCount`/`cooldownPeriod` in
`base/worker/scaledobject.yaml`, requests/limits in each `deployment.yaml`. The HPAs use CPU
only; requests are what utilization is measured against, so keep them realistic.

PodDisruptionBudgets are `minAvailable: 1` except the worker (`maxUnavailable: 1`: it scales
to zero, and one busy pod must not block node drains forever).

## Adding an app

1. Give it a Dockerfile at `apps/<app>/Dockerfile` (build context = repo root, non-root,
   read-only root filesystem with `/tmp` writable, `GIT_SHA` build arg, `/healthz`,
   `/readyz`, `/version`).
2. Copy the closest `base/<app>/` (an HTTP service: `api`; a queue consumer: `worker`), rename
   every `name`, label and ConfigMap/Secret reference, and add the folder to
   `base/kustomization.yaml`.
3. If it takes traffic from outside, add a path to `base/ingress.yaml`.
4. Add its image to `images:` in each overlay (`newTag: dev` in dev, `newName`/`digest` in
   staging and prod), and replica or HPA patches if the defaults don't fit.
5. Add a NetworkPolicy in `components/network-policies/` (who may call it, what it may reach;
   if it reaches managed data services, add its rule to the `replacements` in the overlays).
6. Document `<app>-secrets` key names in the table above.
7. Add it to `infra/docker/compose.yaml` (profile `full`) and, if the router should expose it,
   `infra/docker/router/Caddyfile`; and to the app list in `.github/workflows/images.yml`.

## Renaming the product

Kubernetes, compose and CI config can't read the naming config at run time, so they spell out
its env prefix (`INKLING_…`) and resource prefix (`inkling-objects` buckets, the
`inkling:jobs:ready` Redis list). `node tools/rename-namespace.mjs --from <old> --to <new>`
(with `--dry-run` to preview) rewrites both in `infra/**`, `.github/**`, `apps/*/Dockerfile`
and `apps/web/nginx/*`, along with the stored documents it already covers. Resource names
themselves (`web`, `api`, `studio-<app>` images, the `studio*` namespaces) are brand-free.
