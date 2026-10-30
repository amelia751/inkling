#!/usr/bin/env node
// Fails when a real Secret could be committed under infra/ (todo/done/todo3.md D.4):
//   1. any YAML document with `kind: Secret` that carries `data:` or `stringData:`;
//   2. a kustomize secretGenerator literal whose key looks sensitive (password, secret, token,
//      key, or a URL with credentials) but whose value isn't a marked dev placeholder
//      (contains `dev-only`).
// Secrets are created out of band (infra/k8s/README.md). Usage: node infra/k8s/check-no-secrets.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const infra = join(root, "infra");

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.ya?ml$/.test(name) ? [p] : [];
  });

const errors = [];
for (const file of walk(infra)) {
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  // 1. Secret manifests with data.
  for (const doc of text.split(/^---\s*$/m)) {
    if (/^kind:\s*["']?Secret["']?\s*$/m.test(doc) && /^(data|stringData):/m.test(doc)) {
      errors.push(`${rel}: kind: Secret with data/stringData (create Secrets out of band; see infra/k8s/README.md)`);
    }
  }
  // 2. secretGenerator literals.
  if (!/^secretGenerator:/m.test(text)) continue;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const m = /^\s*-\s*["']?([A-Za-z_][A-Za-z0-9_]*)=(.*?)["']?\s*$/.exec(line);
    if (!m) return;
    const [, key, value] = m;
    const sensitive = /(PASSWORD|SECRET|TOKEN|_KEY|API_KEY|DATABASE_URL|REDIS_URL)/i.test(key) || /:\/\/[^/\s:@]+:[^@\s]+@/.test(value);
    if (sensitive && value && !value.includes("dev-only")) {
      errors.push(`${rel}:${i + 1}: secretGenerator literal ${key} is not a marked dev placeholder (value must contain "dev-only")`);
    }
  });
}

if (errors.length) {
  console.error(`Committed secrets under infra/ (${errors.length}):\n${errors.join("\n")}`);
  process.exit(1);
}
console.log("No committed Secrets under infra/.");
