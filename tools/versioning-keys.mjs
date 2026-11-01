// Service-JWT key pairs for a cluster (todo/done/todo4.md V4, todo12 A5; infra/k8s/README.md).
//   node tools/versioning-keys.mjs [--namespace studio-dev] [--rotate <kid>|all]
//                                  [--gcp-project <project>] [--context <kube-context>]
// Two signers, each with an Ed25519 key (PKCS8 PEM under key `jwt.key`):
//   kid `api`      → Secret api-versioning-jwt       (apps/api signs calls to versioning and the pipeline)
//   kid `pipeline` → Secret pipeline-versioning-jwt  (apps/pipeline signs calls to versioning)
// and two ConfigMaps of public keys (key `jwks.json`, not secret):
//   versioning-jwks  both keys (apps/versioning accepts either signer)
//   api-jwks         the api's key only (apps/pipeline accepts only the api)
// Without --gcp-project the Secrets are created in the namespace through kubectl. With it, they
// are new versions of the Secret Manager secrets of the same names (the External Secrets
// Operator syncs them; gke overlays), added through gcloud. Either way the private key goes
// through stdin only, never argv, a file or the terminal. Existing keys are kept (their public
// halves are recomputed) unless --rotate names them. The api's kid must match
// <envPrefix>API_VERSIONING_JWT_KID; the pipeline's <envPrefix>PIPELINE_VERSIONING_JWT_KID.
import { execFileSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const ns = opt("namespace", "studio-dev");
const rotate = opt("rotate", args.includes("--rotate") ? "all" : "");
const gcpProject = opt("gcp-project", "");
const context = opt("context", "");

const SIGNERS = [
  { kid: "api", secret: "api-versioning-jwt" },
  { kid: "pipeline", secret: "pipeline-versioning-jwt" },
];
const JWKS = [
  { name: "versioning-jwks", kids: ["api", "pipeline"] },
  { name: "api-jwks", kids: ["api"] },
];

const run = (cmd, argv, input) =>
  execFileSync(cmd, argv, { input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).toString();
const kubectl = (argv, input) => run("kubectl", [...(context ? ["--context", context] : []), "-n", ns, ...argv], input);
const gcloud = (argv, input) => run("gcloud", [...argv, `--project=${gcpProject}`], input);
const attempt = (fn) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

// The current private key of a signer, if there is one.
const readKey = (secret) =>
  gcpProject
    ? attempt(() => JSON.parse(gcloud(["secrets", "versions", "access", "latest", `--secret=${secret}`]))["jwt.key"])
    : attempt(() => Buffer.from(kubectl(["get", "secret", secret, "-o", "jsonpath={.data.jwt\\.key}"]), "base64").toString() || undefined);

const writeKey = (secret, pem) => {
  if (gcpProject) {
    gcloud(["secrets", "versions", "add", secret, "--data-file=-"], JSON.stringify({ "jwt.key": pem }));
    return;
  }
  const manifest = { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: { name: secret, labels: { "app.kubernetes.io/part-of": "studio" } }, data: { "jwt.key": Buffer.from(pem).toString("base64") } };
  kubectl(["apply", "-f", "-"], JSON.stringify(manifest));
};

const jwk = {};
for (const { kid, secret } of SIGNERS) {
  let pem = rotate === "all" || rotate === kid ? undefined : readKey(secret);
  if (pem) {
    console.log(`${secret}: kept (kid ${kid}).`);
  } else {
    pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    writeKey(secret, pem);
    console.log(`${secret}: ${gcpProject ? `new version in Secret Manager (${gcpProject})` : `created in ${ns}`} (kid ${kid}).`);
  }
  const { x } = createPublicKey(pem).export({ format: "jwk" });
  jwk[kid] = { kty: "OKP", crv: "Ed25519", kid, x, use: "sig", alg: "EdDSA" };
}

for (const { name, kids } of JWKS) {
  const manifest = { apiVersion: "v1", kind: "ConfigMap", metadata: { name, labels: { "app.kubernetes.io/part-of": "studio" } }, data: { "jwks.json": JSON.stringify({ keys: kids.map((k) => jwk[k]) }) } };
  kubectl(["apply", "-f", "-"], JSON.stringify(manifest));
  console.log(`${name}: ${kids.join(", ")} in ${ns}.`);
}
if (rotate) console.log(`Restart the signers to pick up new keys: kubectl -n ${ns} rollout restart deployment/api deployment/pipeline`);
