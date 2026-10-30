// The api → versioning service-JWT key pair for a cluster (todo/done/todo4.md V4, infra/k8s/README.md).
//   node tools/versioning-keys.mjs [--namespace studio-dev] [--kid api] [--rotate]
// Creates Secret `api-versioning-jwt` (jwt.key: Ed25519 PKCS8 PEM, read by apps/api) and
// ConfigMap `versioning-jwks` (jwks.json: the public half, read by apps/versioning) through
// kubectl, so the private key never touches the repo or the terminal. Leaves an existing pair
// alone unless --rotate. The kid must match the api's <envPrefix>API_VERSIONING_JWT_KID.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const ns = opt("namespace", "studio-dev");
const kid = opt("kid", "api");
const rotate = args.includes("--rotate");

const kubectl = (argv, input) => execFileSync("kubectl", ["-n", ns, ...argv], { input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).toString();
const exists = (kind, name) => {
  try {
    kubectl(["get", kind, name, "-o", "name"]);
    return true;
  } catch {
    return false;
  }
};

if (!rotate && exists("secret", "api-versioning-jwt") && exists("configmap", "versioning-jwks")) {
  console.log(`api-versioning-jwt and versioning-jwks already exist in ${ns} (pass --rotate to replace them).`);
  process.exit(0);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const { x } = publicKey.export({ format: "jwk" });
const jwks = JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid, x, use: "sig", alg: "EdDSA" }] });

// The manifests go through stdin, so neither the key nor its base64 appears in argv.
const manifest = (kind, name, data) =>
  JSON.stringify({ apiVersion: "v1", kind, metadata: { name, labels: { "app.kubernetes.io/part-of": "studio" } }, ...data });
kubectl(["apply", "-f", "-"], manifest("ConfigMap", "versioning-jwks", { data: { "jwks.json": jwks } }));
kubectl(["apply", "-f", "-"], manifest("Secret", "api-versioning-jwt", { type: "Opaque", data: { "jwt.key": Buffer.from(pem).toString("base64") } }));
console.log(`Created api-versioning-jwt and versioning-jwks (kid ${kid}) in ${ns}.`);
if (rotate) console.log("Restart the api to pick up the new key: kubectl -n " + ns + " rollout restart deployment/api");
