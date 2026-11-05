# Organization layer

Folders, organization policies and the VPC Service Controls perimeter around `spurby-phi`. The
projects themselves already exist and aren't managed here. Layout and reasons: `.agents/skills/data-boundary/deployment-gcp.md`.

Runs as the keyless deploy identity `terraform@spurby-phi.iam.gserviceaccount.com`. A person with
Token Creator on it (the Workspace super admin) mints a short-lived token; no key files:

```sh
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account=terraform@spurby-phi.iam.gserviceaccount.com --configuration=spurby-phi)
terraform init
terraform plan  -var org_id=<ORG_ID>
terraform apply -var org_id=<ORG_ID>
```

State lives in `gs://spurby-phi-tfstate` (versioned, uniform access, public access prevented).

The perimeter starts in **dry-run** (`perimeter_enforced = false`): violations are logged, nothing is
blocked. Watch them in Logs Explorer (`protoPayload.metadata.@type="type.googleapis.com/google.cloud.audit.VpcServiceControlAuditMetadata"`, dry-run entries carry `dryRun: true`),
then enforce with `-var perimeter_enforced=true` before customer data arrives.
