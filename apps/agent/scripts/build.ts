/**
 * Production build: `dist/main.js` (and `dist/scripts/{migrate,sweep}.js`), runnable with plain node.
 *
 * Our TS and the workspace packages (`@studio/*`, TS source) are bundled; third-party packages stay
 * external and resolve from node_modules at runtime. Files read at runtime via `import.meta.dirname`
 * (prompts, sandbox-image/requirements.txt, ../../secrets in dev) are resolved from their source
 * location, so the bundle behaves exactly like `tsx src/main.ts`. schemas/naming.json and
 * package.json are inlined.
 */
import { rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { build, type Plugin } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "dist");

/** Bundle relative imports and @studio/*; leave every other bare import to node. */
const externals: Plugin = {
  name: "externals",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@studio/") || args.path.startsWith("node:") ? undefined : { path: args.path, external: true }));
  },
};

/** Rewrite `import.meta.dirname` in each source file to that file's own directory, relative to the output file. */
const sourceDirname = (outDir: string): Plugin => ({
  name: "source-dirname",
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, async (args) => {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(args.path, "utf8");
      if (!text.includes("import.meta.dirname")) return undefined;
      const rel = relative(outDir, dirname(args.path)).split("\\").join("/");
      return { contents: text.replaceAll("import.meta.dirname", `(import.meta.dirname + ${JSON.stringify(`/${rel}`)})`), loader: "ts" };
    });
  },
});

rmSync(out, { recursive: true, force: true });
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  // Some bundled deps may use require(); give ESM output a real one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
} as const;
await build({ ...common, entryPoints: [resolve(root, "src/main.ts")], outfile: resolve(out, "main.js"), plugins: [externals, sourceDirname(out)] });
for (const name of ["migrate", "sweep"])
  await build({
    ...common,
    entryPoints: [resolve(root, `scripts/${name}.ts`)],
    outfile: resolve(out, `scripts/${name}.js`),
    plugins: [externals, sourceDirname(resolve(out, "scripts"))],
  });
