# infra/k8s

Kustomize for every deployable app. How to run it on a local cluster is in
[`docs/running.md`](../../docs/running.md); this file covers secrets, the WorkOS runbook, scaling
and adding an app.

```text
base/
  web/ api/ agent/ worker/ versioning/   Deployment, Service, ServiceAccount, PDB, ConfigMap,
  pipeline/                              HPA (web, api, agent, pipeline) or KEDA ScaledObject (worker)
  ingress.yaml                           /api/agent → web, /api and /seed → api, / → web
  jobs/                                  api-migrate, versioning-migrate, pipeline-migrate, agent-migrate
                                         (Jobs), agent-sweeper (CronJob), db-bootstrap (suspended Job)
  deps/                                  dev-only Postgres, Redis, S3-compatible store (RustFS) + bucket Job
components/network-policies/             default deny + per-app allow rules (staging, prod)
overlays/
  dev/        one replica each, base/deps, local `studio-<app>:dev` images, dev placeholder Secrets
  staging/    managed endpoints, digests, 2+ replicas, NetworkPolicies, TLS host
  prod/       same as staging with more replicas; sign-in with WorkOS (auth.yaml, workos-egress.yaml)
  gke/        Google Cloud: phi/ (web, api, worker, versioning, pipeline in spurby-phi) and ai/
              (agent and its build sandboxes in spurby-ai); Workload Identity, External Secrets,
              GKE Sandbox; live/ renders them with real values from a git-ignored local.env
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
| `api-secrets` | `INKLING_API_DATABASE_URL`, `INKLING_API_SECRET_KEY`, `INKLING_API_WORKER_TOKEN`, `INKLING_API_PIPELINE_TOKEN`, `INKLING_API_APPROVAL_SECRET` (equals the agent's `INKLING_AGENT_APPROVAL_SECRET`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The pipeline token equals `INKLING_PIPELINE_API_TOKEN` in `pipeline-secrets` (principal `service:pipeline`). Add `INKLING_REDIS_URL` here if Redis needs a password (overrides the ConfigMap). Omit the AWS keys when the pod uses workload identity. |
| `worker-secrets` | `INKLING_API_WORKER_TOKEN`, `KEDA_REDIS_PASSWORD` (staging/prod) | The worker token equals the api's. `KEDA_REDIS_PASSWORD` is read only by KEDA's TriggerAuthentication. Plugin provider keys are brokered by api, never mounted here. |
| `agent-secrets` | `INKLING_AGENT_TOKEN`, `INKLING_AGENT_APPROVAL_SECRET`, `INKLING_AGENT_DATABASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DAYTONA_API_KEY` | The only Secret with model and Daytona keys. Add `INKLING_AGENT_REDIS_URL` if Redis needs a password. Optional: `DAYTONA_API_URL`, `DAYTONA_TARGET`. |
| `versioning-secrets` | `INKLING_VERSIONING_DATABASE_URL` (role `versioning_app`), `INKLING_VERSIONING_MIGRATE_DATABASE_URL` (role `versioning_owner`), `INKLING_VERSIONING_S3_ACCESS_KEY_ID`, `INKLING_VERSIONING_S3_SECRET_ACCESS_KEY` | S3 keys scoped to the two versioning buckets. Add `INKLING_VERSIONING_REDIS_URL` if Redis needs a password. |
| `pipeline-secrets` | `INKLING_PIPELINE_DATABASE_URL` (database `studio`, role `pipeline_app`, `search_path=pipeline`), `INKLING_PIPELINE_ENGINE_DATABASE_URL` (database `pipeline_engine`, same role), `INKLING_PIPELINE_API_TOKEN` | `sslmode=require` outside dev. Both URLs count against `pipeline_app`'s `CONNECTION LIMIT`. |
| `workos-secrets` | `INKLING_API_WORKOS_API_KEY`, `INKLING_API_WORKOS_COOKIE_PASSWORD`, `INKLING_API_WORKOS_CLIENT_ID` | Sign-in (todo9). Optional everywhere: absent means `dev` mode. api reads all three (`envFrom`, before `api-secrets`), for sign-in and the WorkOS event sync; the worker reads none. The cookie password is a Fernet key, the same on every replica. The client id isn't secret but belongs to the same WorkOS environment as the key. Runbook below. |
| `db-bootstrap-secrets` | `ADMIN_DATABASE_URL`, `API_APP_PASSWORD`, `PIPELINE_APP_PASSWORD`, `VERSIONING_OWNER_PASSWORD`, `VERSIONING_APP_PASSWORD` | Read by the db-bootstrap Job's psql only (no env prefix: not an app setting). Present only while bootstrapping; dev uses placeholders. |
| `versioning-bootstrap-secrets` | `INKLING_VERSIONING_ADMIN_DATABASE_URL`, `INKLING_VERSIONING_OWNER_PASSWORD`, `INKLING_VERSIONING_APP_PASSWORD` | dev only (init container of `versioning-migrate`). In staging/prod a DBA runs `migrate bootstrap` once. |
| `studio-tls` | (type `kubernetes.io/tls`) | Issued by cert-manager for the Ingress host. |

Service calls are signed with Ed25519 keys (PKCS8 PEM, key `jwt.key`):

| Signer | Secret (mounted at) | kid | Verified by |
|---|---|---|---|
| api → versioning, api → pipeline | `api-versioning-jwt` (`/etc/api/versioning`) | `api` (`INKLING_API_VERSIONING_JWT_KID`, `INKLING_API_PIPELINE_JWT_KID`) | versioning (`versioning-jwks`), pipeline (`api-jwks`) |
| pipeline → versioning | `pipeline-versioning-jwt` (`/etc/pipeline/versioning`) | `pipeline` (`INKLING_PIPELINE_VERSIONING_JWT_KID`) | versioning (`versioning-jwks`) |

The public halves are ConfigMaps (key `jwks.json`, not secret): `versioning-jwks` holds both
keys, `api-jwks` only the api's. None of them is in any overlay; `node tools/versioning-keys.mjs
--namespace <ns>` (`pnpm k8s:dev-keys` for `studio-dev`) creates the missing key pairs and both
ConfigMaps without printing a key. On GKE, add `--gcp-project spurby-phi --namespace studio
--context <phi>`: the private keys become Secret Manager versions (synced by External Secrets) and
the ConfigMaps are applied to the cluster. `--rotate <kid>` replaces one key; to rotate without
downtime, add the new public key to the JWKS first, then swap the Secret and restart the signer.

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

## WorkOS runbook (todo9)

Sign-in, WorkOS environments and modes: `docs/running.md` ("Signing in"). Here: the Secret and
what to do in production. `workos-secrets` keys are in the table above. Pods read it at start
(`envFrom` / `secretKeyRef`), so every change needs a restart of api (and worker for the key).
Below, `NS=studio`; on GKE the value lives in Secret Manager (`spurby-phi`, secret
`workos-secrets`, one JSON object) and External Secrets syncs it within an hour, or at once with
`kubectl -n $NS annotate externalsecret workos-secrets force-sync=$(date +%s) --overwrite`.
Elsewhere, replace the Secret with `kubectl create secret generic workos-secrets
--from-env-file=<(…) --dry-run=client -o yaml | kubectl apply -f -`. Never echo a value.

**Turn sign-in on (GKE, Phase 14).** Staging first, for a week with the team; then production.

1. WorkOS production environment: billing details added, `npx workos@0.24.0 seed
   --file=infra/workos/seed.yml` applied, then the dashboard steps in `infra/workos/README.md`
   (default role, API key permissions, JWT template, session lengths). Redirect URI exactly
   `https://<STUDIO_HOST>/api/auth/callback` (https only), sign-out URI `https://<STUDIO_HOST>/`,
   initiate login URI `https://<STUDIO_HOST>/api/auth/login`.
2. Add the secret's first version (the production key is shown once; paste it at the prompt):

   ```sh
   python3 -c 'import getpass, json; from cryptography.fernet import Fernet; print(json.dumps({
     "INKLING_API_WORKOS_API_KEY": getpass.getpass("WorkOS API key: "),
     "INKLING_API_WORKOS_CLIENT_ID": input("Client id: "),
     "INKLING_API_WORKOS_COOKIE_PASSWORD": Fernet.generate_key().decode()}))' \
     | gcloud secrets versions add workos-secrets --project=spurby-phi --data-file=-
   kubectl -n $NS get externalsecret workos-secrets     # SecretSynced
   ```

3. Add `components/workos` to `overlays/gke/phi/kustomization.yaml` (before `values`), set
   `INKLING_API_WORKOS_ISSUER` in its `configmap.yaml` to the `iss` Phase 0 recorded, render from
   `live/phi`, apply. In `overlays/gke/ai`, set `INKLING_AGENT_AUTH_MODE=workos` and
   `INKLING_AGENT_WORKOS_CLIENT_ID` (and the issuer) in `agent-config`, apply.
4. **Keep the ingress allow-list (`STUDIO_ALLOW_CIDRS`).** From an allowed address: sign in,
   switch organization, invite someone, create and revoke an API key, sign out. Check that
   `GET /api/auth/session` without a cookie is 401, and that a request with only the dev headers
   is refused.
5. Only then remove the `whitelist-source-range` annotation (`overlays/gke/phi/patches`, its
   replacement in `values/` and `STUDIO_ALLOW_CIDRS` in `local.env*`) in a separate change.

Roll back by removing `components/workos` and applying: the api returns to `dev` mode, which is
only safe while the allow-list is still on, so never remove the allow-list and the component in
the same change.

**Rotate the cookie password.** Every session ends: everyone signs in again. Do it off-hours, or
at once if the key leaked. Replace only `INKLING_API_WORKOS_COOKIE_PASSWORD`, then restart api:

```sh
gcloud secrets versions access latest --secret=workos-secrets --project=spurby-phi \
  | python3 -c 'import json, sys; from cryptography.fernet import Fernet; d = json.load(sys.stdin)
d["INKLING_API_WORKOS_COOKIE_PASSWORD"] = Fernet.generate_key().decode(); print(json.dumps(d))' \
  | gcloud secrets versions add workos-secrets --project=spurby-phi --data-file=-
# force-sync (above), then:
kubectl -n $NS rollout restart deployment/api && kubectl -n $NS rollout status deployment/api
```

During the rollout old and new pods disagree, so a person may be signed out twice. Disable the
previous secret version afterwards (`gcloud secrets versions disable`).

**Rotate the WorkOS API key.** No downtime: WorkOS keeps both keys valid until you revoke one.
Create a new key in the dashboard (API Keys), put it in `INKLING_API_WORKOS_API_KEY` the same way,
force-sync, `kubectl rollout restart deployment/api deployment/worker`, check `/readyz`, a
sign-in and the worker's event sync log, then revoke the old key in the dashboard and disable the
old secret version. A leaked key: revoke first (sign-in and member management fail until the new
key is rolled out; signed-in people keep working until their next refresh fails).

**WorkOS outage.** People already signed in keep working: access tokens are verified locally
against the cached JWKS, and a refresh that fails with 408, 429, 5xx or a network error keeps the
session and is retried (never a sign-out). New sign-ins, sign-out, switching organization,
invitations, member, role and key changes, the Admin Portal and the security page fail with a
WorkOS error. API keys keep working while their validation is cached, then fail closed. The
api's event sync stops and catches up from its Postgres cursor afterwards (WorkOS keeps 90
days of events). Nothing to do but watch the refresh-error and sync-lag dashboards and
status.workos.com; don't restart pods (a restart drops the JWKS and key caches).

**Revoke a person everywhere.** In the organization's Members page (or the WorkOS dashboard:
Users → the person), remove their membership, or for every organization delete or block the user;
then revoke their sessions (dashboard: the user's Sessions → revoke, or `revoke_session` for each
`sid`). Their access token stays valid until it expires (≤ 5 min, D10); the next refresh fails
and the cookie is cleared. Also revoke organization API keys they created (Settings → API keys)
and, for a leaked laptop, any MCP key on it. Annotations, revisions and audit rows keep their
principal (`user:<workos id>`).

## Scaling knobs

| App | Mechanism | Base | staging | prod | Notes |
|---|---|---|---|---|---|
| web | HPA, CPU 70 % | 2–6 | 2–4 | 3–10 | Static files and the agent proxy; cheap. |
| api | HPA, CPU 70 % | 2–10 | 2–6 | 3–20 | Stateless (Postgres, S3, Redis). |
| agent | HPA, CPU 70 % | 2–10 | 2–6 | 3–20 | Scale-down stabilization 600 s and 1 pod/min, so long SSE runs aren't cut often; `terminationGracePeriodSeconds: 120` with `INKLING_AGENT_SHUTDOWN_GRACE_S=100`. |
| worker | KEDA `redis` scaler on list `inkling:jobs:ready` | 1–10, 1 pod per 5 queued jobs | 1–6 | 1–30 | `pollingInterval` 10 s, `cooldownPeriod` 300 s before scaling back to one; grace 300 s. Never zero: the event subscriptions (inspection, unpack, item probes) and scheduled tasks put nothing on the job lists. |
| versioning | fixed replicas | 2 | 2 | 3 | River jobs run in-process; add an HPA when load needs it. |
| pipeline | HPA, CPU 70 % | 2–4 | 2–4 | 2–4 | The maximum is the connection budget: pods × `INKLING_PIPELINE_DB_POOL_MAX` (4) must stay under `pipeline_app`'s `CONNECTION LIMIT` (20). DBOS resumes a lost pod's workflows on another replica. |
| worker-gpu (gke, Milestone 4) | KEDA on `inkling:jobs:ready:gpu` | — | — | 0–4 | `overlays/gke/phi/components/gpu-worker`; bounded by the L4 quota. |

Where to change them: `minReplicas`/`maxReplicas`/`averageUtilization` in `base/<app>/hpa.yaml`
(and the overlay patches), `listLength`/`maxReplicaCount`/`cooldownPeriod` in
`base/worker/scaledobject.yaml`, requests/limits in each `deployment.yaml`. The HPAs use CPU
only; requests are what utilization is measured against, so keep them realistic.

PodDisruptionBudgets are `minAvailable: 1` except the worker (`maxUnavailable: 1`: one busy
pod must not block node drains forever).

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
