// node --test tools/check-deploy-auth.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkDeployAuth, terraformPairs, violation, yamlPairs } from "./check-deploy-auth.mjs";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "deploy-auth-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}
const keys = (root) => checkDeployAuth({ root, render: false }).found.map((f) => `${f.file}:${f.key}=${f.value}`).sort();

test("rules", () => {
  assert.equal(violation("STUDIO_API_AUTH_MODE", "workos"), null);
  assert.ok(violation("STUDIO_API_AUTH_MODE", "dev"));
  assert.ok(violation("STUDIO_AGENT_AUTH_MODE", '"dev"'));
  assert.equal(violation("STUDIO_API_DEV_TRUST_HEADERS", '"0"'), null);
  assert.ok(violation("STUDIO_API_DEV_TRUST_HEADERS", '"1"'));
  assert.ok(violation("STUDIO_API_DEV_TRUST_HEADERS", "true"));
  assert.ok(violation("STUDIO_AGENT_STORE", "file"));
  assert.equal(violation("STUDIO_AGENT_STORE", "postgres"), null);
  assert.ok(violation("STUDIO_API_DATABASE_URL", "sqlite:///tmp/api.db"));
});

test("yaml: ConfigMap data, env pairs, JSON patches, literals; comments ignored", () => {
  const pairs = yamlPairs(`
data:
  # STUDIO_API_AUTH_MODE: dev
  STUDIO_API_AUTH_MODE: dev
env:
  - name: STUDIO_WEB_AUTH_MODE
    value: dev
  - name: STUDIO_X
    valueFrom: { secretKeyRef: { name: s, key: k } }
patch: |-
  - op: replace
    path: /data/STUDIO_API_DEV_TRUST_HEADERS
    value: "1"
literals:
  - STUDIO_AGENT_STORE=file
`);
  const got = pairs.filter((p) => violation(p.key, p.value)).map((p) => `${p.key}@${p.line}`);
  assert.deepEqual(got, ["STUDIO_API_AUTH_MODE@4", "STUDIO_WEB_AUTH_MODE@7", "STUDIO_API_DEV_TRUST_HEADERS@13", "STUDIO_AGENT_STORE@15"]);
});

test("terraform: Cloud Run env blocks and map assignments", () => {
  const pairs = terraformPairs(`
resource "google_cloud_run_v2_service" "api" {
  template {
    containers {
      env {
        name  = "STUDIO_API_AUTH_MODE"
        value = "dev"
      }
      env {
        name = "STUDIO_API_DATABASE_URL"
        value_source {
          secret_key_ref { secret = "db" }
        }
      }
      env {
        name  = "STUDIO_API_DEV_TRUST_HEADERS"
        value = "0"
      }
    }
  }
}
locals { env = { STUDIO_AGENT_STORE = "file" } }
`);
  const got = pairs.filter((p) => violation(p.key, p.value)).map((p) => p.key);
  assert.deepEqual(got.sort(), ["STUDIO_AGENT_STORE", "STUDIO_API_AUTH_MODE"]);
});

test("clean repo passes, dirty repo names file and key", () => {
  const clean = repo({
    "infra/k8s/base/api/configmap.yaml": 'data:\n  STUDIO_API_AUTH_MODE: workos\n  STUDIO_API_DEV_TRUST_HEADERS: "0"\n',
    "infra/terraform/ai/run.tf": 'env {\n  name  = "STUDIO_AGENT_AUTH_MODE"\n  value = "workos"\n}\n',
  });
  const dirty = repo({
    "infra/k8s/overlays/dev/kustomization.yaml": "kind: Kustomization\nsecretGenerator:\n  - literals:\n      - STUDIO_API_DATABASE_URL=sqlite:///x.db\n",
    "infra/terraform/phi/run.tf": 'env {\n  name  = "STUDIO_API_AUTH_MODE"\n  value = "dev"\n}\n',
  });
  try {
    assert.deepEqual(keys(clean), []);
    assert.deepEqual(keys(dirty), [
      "infra/k8s/overlays/dev/kustomization.yaml:STUDIO_API_DATABASE_URL=sqlite:///x.db",
      "infra/terraform/phi/run.tf:STUDIO_API_AUTH_MODE=dev",
    ]);
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(dirty, { recursive: true, force: true });
  }
});
