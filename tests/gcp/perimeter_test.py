"""The VPC Service Controls perimeter refuses the build project (todo10 Phase 9 exit).

From an identity of the build project (spurby-ai), try to read the patient-data project
(spurby-phi) directly through Google APIs: list a Cloud Storage bucket, read a Cloud SQL
instance's connect settings (what the Cloud SQL connectors call before connecting), fetch a KMS
key. Every call must be refused by the perimeter (403 naming VPC_SERVICE_CONTROLS), not merely by
IAM: the point is that a stolen credential with IAM access still can't get through.

Read-only: list/get calls only, nothing is written. Needs the person's gcloud sign-in on this
machine; without it the test is skipped (exit 0, "SKIP").

    python3 tests/gcp/perimeter_test.py                         # as the spurby-ai gcloud profile
    python3 tests/gcp/perimeter_test.py --impersonate studio-agent@spurby-ai.iam.gserviceaccount.com
    python3 tests/gcp/perimeter_test.py --expect dry-run        # before enforcement: report only,
        # then confirm the would-be refusals in the dry-run audit log (--check-log, as the deploy identity)

Cloud SQL has no public IP (sql.restrictPublicIp; infra/terraform/phi), so there is no network
path to the database from spurby-ai either; the connectSettings call covers the API path.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

DEPLOY = "terraform@spurby-phi.iam.gserviceaccount.com"


def token(configuration: str, impersonate: str | None) -> str | None:
    if not shutil.which("gcloud"):
        return None
    cmd = ["gcloud", "auth", "print-access-token", f"--configuration={configuration}"]
    if impersonate:
        cmd.append(f"--impersonate-service-account={impersonate}")
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout.strip() or None if r.returncode == 0 else None


def call(tok: str, url: str, body: dict | None = None) -> tuple[int, str]:
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def classify(status: int, body: str) -> str:
    if status == 403 and ("VPC_SERVICE_CONTROLS" in body or "vpcServiceControlsUniqueIdentifier" in body):
        return "refused by perimeter"
    if 200 <= status < 300:
        return "ALLOWED"
    return {403: "refused by IAM", 404: "not found", 401: "unauthenticated"}.get(status, f"HTTP {status}")


def probes(project: str, region: str, buckets: list[str], sql: str) -> list[tuple[str, str]]:
    out = [(f"storage: list gs://{b}", f"https://storage.googleapis.com/storage/v1/b/{b}/o?maxResults=1") for b in buckets]
    out.append((f"sql: connectSettings {sql}", f"https://sqladmin.googleapis.com/v1/projects/{project}/instances/{sql}/connectSettings"))
    out.append(("kms: get plugin-signing key", f"https://cloudkms.googleapis.com/v1/projects/{project}/locations/{region}/keyRings/studio/cryptoKeys/plugin-signing"))
    out.append(("storage: list buckets", f"https://storage.googleapis.com/storage/v1/b?project={project}&maxResults=1"))
    return out


def dry_run_log(project: str, configuration: str, since: dt.datetime) -> list[dict]:
    """Dry-run violations recorded since `since`, read as the deploy identity (logging.entries.list)."""
    tok = token(configuration, DEPLOY)
    if not tok:
        return []
    flt = (
        'protoPayload.metadata.@type="type.googleapis.com/google.cloud.audit.VpcServiceControlAuditMetadata" '
        f'AND protoPayload.metadata.dryRun=true AND timestamp>="{since.isoformat()}"'
    )
    status, body = call(tok, "https://logging.googleapis.com/v2/entries:list", {"resourceNames": [f"projects/{project}"], "filter": flt, "pageSize": 50, "orderBy": "timestamp desc"})
    if status != 200:
        print(f"  (dry-run log not readable: HTTP {status})")
        return []
    return json.loads(body).get("entries", [])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--configuration", default="spurby-ai", help="gcloud configuration of a build-project identity")
    ap.add_argument("--impersonate", help="a build-project service account to act as (e.g. studio-agent@spurby-ai)")
    ap.add_argument("--project", default="spurby-phi")
    ap.add_argument("--region", default="us-central1")
    ap.add_argument("--bucket", action="append", help="patient-data bucket(s) to try (default: tfstate and objects)")
    ap.add_argument("--sql-instance", default="studio")
    ap.add_argument("--expect", choices=["enforced", "dry-run"], default="enforced")
    ap.add_argument("--check-log", action="store_true", help="dry-run: also list the perimeter's dry-run violations since the probes")
    ap.add_argument("--deploy-configuration", default="spurby-phi", help="gcloud configuration that may impersonate the deploy identity (--check-log)")
    a = ap.parse_args()

    tok = token(a.configuration, a.impersonate)
    if not tok:
        print(f"SKIP: no access token for gcloud configuration {a.configuration!r} (needs the person's sign-in)")
        return 0
    buckets = a.bucket or [f"{a.project}-tfstate", f"{a.project}-objects"]
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=5)
    who = a.impersonate or f"gcloud configuration {a.configuration}"
    print(f"as {who} → {a.project} (expect {a.expect}):")
    results = []
    for name, url in probes(a.project, a.region, buckets, a.sql_instance):
        status, body = call(tok, url)
        verdict = classify(status, body)
        results.append(verdict)
        print(f"  {verdict:22} {name}")

    if a.expect == "enforced":
        ok = all(v == "refused by perimeter" for v in results)
        print("PASS: every direct read refused by the perimeter" if ok else "FAIL: a direct read was not refused by the perimeter")
        return 0 if ok else 1

    # Dry-run: nothing is blocked yet. IAM must still refuse (no ALLOWED), and the log shows what
    # the perimeter would have refused.
    ok = "ALLOWED" not in results
    if a.check_log:
        import time

        time.sleep(20)  # audit log latency
        entries = dry_run_log(a.project, a.deploy_configuration, since)
        print(f"  dry-run violations logged since the probes: {len(entries)}")
        for e in entries[:10]:
            p = e.get("protoPayload", {})
            print(f"    {p.get('serviceName')} {p.get('methodName')} {p.get('metadata', {}).get('violationReason', '')}")
    print("PASS (dry-run): no direct read allowed; enforce the perimeter to make the refusal structural" if ok else "FAIL: a direct read was allowed")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
