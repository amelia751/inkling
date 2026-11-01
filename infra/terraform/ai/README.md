# spurby-ai stack

The agent, its model calls and its build sandboxes. Never customer data: the agent reaches
`spurby-phi` only over HTTPS through the api's agent routes (`docs/deployment-gcp.md`). The
Kubernetes side is `infra/k8s/overlays/gke/ai`.

| File | What |
|---|---|
| `network.tf` | VPC, private services access, Cloud NAT with a fixed address (`spurby-phi` admits the agent from it only) |
| `gke.tf` | GKE Autopilot `agent` (private nodes, DNS endpoint); sandboxes run with `runtimeClassName: gvisor`; Artifact Registry `images` |
| `agent.tf` | Cloud SQL 17 and Memorystore for the agent's own store and run-event bus; service account `studio-agent` with `roles/aiplatform.user` (Vertex AI, D8); secret `agent-secrets` |

`spurby-ai` is outside the organization, so the deploy identity has no role here until the
project owner grants one (once, by hand):

```sh
gcloud projects add-iam-policy-binding spurby-ai --configuration=spurby-ai \
  --member=serviceAccount:terraform@spurby-phi.iam.gserviceaccount.com --role=roles/owner
# Terraform enables the other APIs, but can't until these are on (a new project has none):
gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  iam.googleapis.com --project=spurby-ai --configuration=spurby-ai
```

Then, as in `../phi` (state prefix `ai` in the same bucket):

```sh
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=terraform@spurby-phi.iam.gserviceaccount.com --configuration=spurby-phi)
terraform init && terraform plan
```

Claude models on Vertex AI must be enabled once in Model Garden (console, accepts the model's
terms); Gemini needs nothing more. Confirm the chosen model is on Google's HIPAA covered list
and that the BAA covers this project's billing account before relying on D8.
