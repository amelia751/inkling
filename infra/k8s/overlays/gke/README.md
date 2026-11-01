# overlays/gke

Google Cloud (todo10 Phase 9, `docs/deployment-gcp.md`). Two clusters, one per project, made by
`infra/terraform/phi` and `infra/terraform/ai`:

| Overlay | Cluster | Runs |
|---|---|---|
| `phi/` | `studio` in `spurby-phi` (inside the perimeter) | web, api, worker (GKE Sandbox), versioning, pipeline, their Jobs, db-bootstrap (suspended) |
| `ai/app/` | `agent` in `spurby-ai` | agent, agent-migrate, agent-sweeper |
| `ai/sandboxes/` | `agent` in `spurby-ai` | build sandboxes (agent-sandbox on GKE Sandbox), no network at all |

```sh
kubectl kustomize infra/k8s/overlays/gke/phi        # placeholders: always renders (review, CI)
kubectl kustomize infra/k8s/overlays/gke/ai
kubectl kustomize infra/k8s/overlays/gke/live/phi   # real values from live/phi/local.env
kubectl kustomize infra/k8s/overlays/gke/live/ai    # real values from live/ai/local.env
```

Layout of each overlay: `patches/` (a Component with every change to base), `values/` (a
Component with the replacements from ConfigMap `gke-values`), `local.env.example` (the
placeholder values `gke-values` is generated from). `live/<overlay>` takes the rendered overlay,
regenerates `gke-values` from its git-ignored `local.env` and runs `values/` again, which
overwrites every placeholder. A key missing from `local.env` fails the render.

## How the two talk

Over HTTPS between fixed addresses, nothing else:

- browser → `studio.example.com` (phi ingress) → web, api. The agent's egress address is refused
  there (`denylist-source-range`).
- web's `/api/agent` proxy → `agent.example.com` (ai ingress, admits only phi's NAT address) →
  agent. web's NetworkPolicy allows only that address.
- agent → `agent-api.example.com` (phi ingress, admits only ai's NAT address) → api, where the
  agent token's scope decides the routes. `/seed` and web aren't routed on that host.
- The agent holds no Google credentials for `spurby-phi`; the perimeter refuses its identities on
  Google APIs there (`tests/gcp/test_perimeter.py`).

Both ingress-nginx controllers need `controller.service.externalTrafficPolicy=Local` (so source
ranges see client addresses) and `controller.service.loadBalancerIP=<terraform output ingress_ip>`.

## Values from `terraform output`

Not secret, but per environment, so they live in git-ignored files (todo12 A7):

```sh
cp infra/k8s/overlays/gke/phi/local.env.example    infra/k8s/overlays/gke/live/phi/local.env
cp infra/k8s/overlays/gke/ai/app/local.env.example infra/k8s/overlays/gke/live/ai/local.env
for s in phi data ai; do terraform -chdir=infra/terraform/$s output -json > /tmp/tf-$s.json; done
# fill each local.env (every key's comment names its output), then render live/phi and live/ai
```

| File | Keys |
|---|---|
| `live/phi/local.env` | `DATA_SERVICES_CIDR`, `REDIS_HOST`, `OBJECTS_BUCKET`, `VERSIONING_OBJECTS_BUCKET`, `VERSIONING_MANIFESTS_BUCKET`, `PLUGIN_SIGNING_KEY`, `API_SERVICE_ACCOUNT`, `VERSIONING_SERVICE_ACCOUNT`, `PIPELINE_SERVICE_ACCOUNT` and `PIPELINE_CONNECTOR_SUBSCRIPTION` (Milestone 3) from phi; `AGENT_EGRESS_CIDR`, `AGENT_INGRESS_CIDR` from ai; `STUDIO_HOST`, `AGENT_API_HOST`, `AGENT_URL` |
| `live/ai/local.env` | `DATA_SERVICES_CIDR`, `CONTROL_PLANE_CIDR`, `REDIS_HOST`, `AGENT_SERVICE_ACCOUNT` from ai; `PHI_EGRESS_CIDR` from phi; `AGENT_HOST`, `AGENT_API_URL` |

Image digests are not in `local.env`: CI pushes to each project's `images` registry and bumps the
`images:` digests in `phi/kustomization.yaml` and `ai/app/kustomization.yaml` (GitOps). The
`postgres` image (db-bootstrap) is mirrored by hand, like the add-ons below.

## Pipeline milestones (todo12 A10)

| Milestone | Where | Turn on |
|---|---|---|
| 1 | in base: `base/pipeline/`, `base/jobs/pipeline-migrate.yaml`, `components/network-policies/pipeline.yaml`; here: ExternalSecrets `pipeline-secrets`, `pipeline-versioning-jwt` | always on (pods wait for their Secrets) |
| 3 | `phi/components/pipeline-connectors`: Workload Identity for the pipeline, its Pub/Sub settings, `pipeline` in the `google-apis` policy | apply phi with `pipeline_connectors_enabled=true`, then add the component to `phi/kustomization.yaml` before `values` |
| 4 | `phi/components/gpu-worker`: `worker-gpu` on L4 + gVisor + Spot, its ScaledObject, PDB and policies | L4 quota granted (`gpu_workers_enabled=true` files the request; a person's step), then add the component |

## Installed once per cluster (Helm, not in this repo)

- ingress-nginx (settings above), cert-manager with a `letsencrypt` ClusterIssuer.
- External Secrets Operator in namespace `external-secrets`, its service account annotated
  `iam.gke.io/gcp-service-account=external-secrets@<project>.iam.gserviceaccount.com`. Secret
  values live in Secret Manager as one JSON object per `<app>-secrets` (key names:
  `infra/k8s/README.md`); `worker-secrets` adds `KEDA_REDIS_PASSWORD`, `KEDA_REDIS_TLS`
  (`enable`) and `KEDA_REDIS_CA` (PEM).
- KEDA (phi only).
- agent-sandbox controller and extensions (ai only), from the kubernetes-sigs/agent-sandbox
  release you pin.
- ConfigMap `redis-ca` (key `ca.crt`, from `terraform output -raw redis_ca`) in namespace
  `studio` of each cluster.
- The service-JWT keys: `node tools/versioning-keys.mjs --gcp-project spurby-phi --namespace
  studio --context <phi>` (private keys to Secret Manager, ConfigMaps `versioning-jwks` and
  `api-jwks` to the cluster; `infra/k8s/README.md`).

Images pulled from outside Google (ingress-nginx, cert-manager, ESO, KEDA, agent-sandbox) should
be mirrored into the project's Artifact Registry; phi nodes otherwise pull through Cloud NAT.

## GKE Sandbox provider (D9): what the `SandboxProvider` needs

The provider itself is todo10-boundary's (`apps/agent/src/sandbox/**`). The infrastructure here
gives it:

| Setting (proposed) | Value | What |
|---|---|---|
| `INKLING_AGENT_SANDBOX` | `gke` | choose the provider (Daytona stays the default during the trial) |
| `INKLING_AGENT_GKE_NAMESPACE` | `sandboxes` | where `SandboxClaim`s go |
| `INKLING_AGENT_GKE_TEMPLATE` | `plugin-build` | the `SandboxTemplate` (warm pool of the same name) |

- Auth: the pod's own service account token (in-cluster config; the ai overlay mounts it for the
  agent only). RBAC allows `sandboxes`, `sandboxclaims`, `pods/exec`, `pods/log` in `sandboxes`
  and nothing else.
- Lifecycle: create a `SandboxClaim` for `plugin-build`, wait for its `Sandbox` to be ready, use
  the pod it names; delete the claim when done. `activeDeadlineSeconds` (1 h) is the backstop.
- Commands and files: `pods/exec` (stream stdin/stdout; tar for copying files in and out). The
  pod network is closed in both directions, so no HTTP to the sandbox.
- No secrets and no egress: there's nothing to pass via env, and package installs can't work;
  the image (`studio-sandbox`) carries the pinned toolchain, like the Daytona snapshot.
- The trial compares start time with Daytona (warm pool hit vs cold Autopilot node).
