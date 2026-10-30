import path from "node:path";

/**
 * Import aliases shared by vite.config.ts and vitest.config.ts (tsconfig.json `paths` mirror
 * them): `@/*` is this app, `@studio/<pkg>[/<file>]` a workspace package's `src/`, and
 * `@plugins/<name>/<file>` a first-party plugin's `ui/` folder.
 */
const repo = path.resolve(__dirname, "../..");

export const REPO_ROOT = repo;

export const aliases = [
  { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, "src") + "/$1" },
  { find: /^@studio\/([^/]+)$/, replacement: path.join(repo, "packages/$1/src/index.ts") },
  { find: /^@studio\/([^/]+)\/(.*)$/, replacement: path.join(repo, "packages/$1/src/$2") },
  { find: /^@plugins\/([^/]+)\/(.*)$/, replacement: path.join(repo, "plugins/$1/ui/$2") },
];
