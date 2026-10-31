# overlays/gke

Google Cloud (todo10 Phase 9, `docs/deployment-gcp.md`). Two clusters, one per project, made by
`infra/terraform/phi` and `infra/terraform/ai`:

| Overlay | Cluster | Runs |
|---|---|---|
| `phi/` | `studio` in `spurby-phi` (inside the perimeter) | web, api, worker (GKE Sandbox), versioning, their Jobs |
| `ai/app/` | `agent` in `spurby-ai` | agent, agent-migrate, agent-sweeper |
| `ai/sandboxes/` | `agent` in `spurby-ai` | build sandboxes (agent-sandbox on GKE Sandbox), no network at all |

```sh
kubectl kustomize infra/k8s/overlays/gke/phi
kubectl kustomize infra/k8s/overlays/gke/ai
```

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

## Placeholders to replace from `terraform output`

| Where | Value |
|---|---|
| `phi/network-config.yaml` | `DATA_SERVICES_CIDR` (phi `data_services_cidr`), `AGENT_EGRESS_CIDR` (ai `nat_egress_ip`/32), `AGENT_INGRESS_CIDR` (ai `ingress_ip`/32) |
| `phi/endpoints.yaml` | Redis host (phi `redis_host`), bucket names (`buckets`), `INKLING_API_SIGNER_KMS_KEY` (`plugin_signing_key`) |
| `phi/workload-identity.yaml` | phi `service_accounts` |
| `ai/app/network-config.yaml` | `DATA_SERVICES_CIDR` (ai), `CONTROL_PLANE_CIDR` (ai `master_ipv4_cidr`), `PHI_EGRESS_CIDR` (phi `nat_egress_ip`/32) |
| `ai/app/agent-config.yaml` | Redis host (ai `redis_host`) |
| hosts | `studio.example.com`, `agent-api.example.com` (phi), `agent.example.com` (ai) |
| images | digests (CI pushes to each project's `images` registry) |

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
