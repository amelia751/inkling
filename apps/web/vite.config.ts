import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";
import { seedServer } from "./dev/seed-server";
import { aliases, REPO_ROOT } from "./aliases";
// The config is bundled by esbuild before aliases exist and can't import workspace TS, so it
// reads the emitted copy of packages/plugin-contracts/src/naming.ts.
import NAMING from "../../schemas/naming.json";

const envVar = (name: string) => `${NAMING.envPrefix}${name}`;

// <envPrefix>KERNEL=1: proxy /api to the Python kernel (apps/api) instead of the dev seed
// server. Catalogue, environments and the assistant stay here: they run the TS registry.
const kernel = process.env[envVar("KERNEL")] === "1";
const kernelUrl = process.env[envVar("KERNEL_URL")] ?? "http://127.0.0.1:8000";
if (kernel) process.env[`VITE_${NAMING.envPrefix}KERNEL`] = "1";
const STAYS_ON_VITE = /^\/api\/(agent|catalog|environments)(\/|$|\?)/;

// dcmjs is a dependency of @cornerstonejs/adapters only (pnpm keeps it private); the DICOM
// SEG/SR exporters need its writer, so resolve the adapters' own copy (one instance).
const adaptersDir = fs.realpathSync(path.resolve(REPO_ROOT, "plugins/export-dicom/node_modules/@cornerstonejs/adapters"));
const dcmjsEntry = path.resolve(adaptersDir, "../../dcmjs/build/dcmjs.es.js");

/**
 * The agent service (apps/agent) on 127.0.0.1:8100. The browser calls /api/agent/*; the proxy maps it
 * to /v1/* and adds the service token from the real env or secrets/agent.env (written by the service
 * on first start), so the token never reaches the browser.
 */
const AGENT_URL = process.env[envVar("AGENT_URL")] ?? "http://127.0.0.1:8100";
let agentToken = process.env.INTERNAL_AGENT_SERVICE_TOKEN;
function serviceToken(): string | undefined {
  if (agentToken) return agentToken;
  const file = path.resolve(__dirname, "../../secrets/agent.env");
  if (!fs.existsSync(file)) return undefined;
  agentToken = /^INTERNAL_AGENT_SERVICE_TOKEN=(.+)$/m.exec(fs.readFileSync(file, "utf8"))?.[1]?.trim();
  return agentToken;
}
const agentProxy: Record<string, ProxyOptions> = {
  "/api/agent": {
    target: AGENT_URL,
    rewrite: (p: string) => p.replace(/^\/api\/agent/, "/v1"),
    configure: (proxy) => {
      proxy.on("proxyReq", (req) => {
        const token = serviceToken();
        if (token) req.setHeader("authorization", `Bearer ${token}`);
      });
      // Event streams must not be buffered or compressed on the way through.
      proxy.on("proxyRes", (res) => {
        if (String(res.headers["content-type"]).startsWith("text/event-stream")) res.headers["cache-control"] = "no-cache, no-transform";
      });
    },
  },
};

/**
 * Generated agent-facing files in schemas/ (written by `pnpm emit:schemas`), served at fixed URLs
 * that agents and the MCP server read: a middleware in dev, emitted into dist/ by `vite build`.
 */
const SCHEMA_URLS: Record<string, string> = {
  "/catalog.json": "catalog.json",
  "/catalog.md": "catalog.md",
  "/schema/environment.v1.json": "environment.v1.json",
};
const schemaFile = (name: string) => path.resolve(REPO_ROOT, "schemas", name);
const schemaFiles: Plugin = {
  name: "schema-files",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const name = SCHEMA_URLS[(req.url ?? "").split("?")[0]];
      if (!name) return next();
      res.setHeader("content-type", name.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json");
      res.end(fs.readFileSync(schemaFile(name)));
    });
  },
  generateBundle() {
    for (const [url, name] of Object.entries(SCHEMA_URLS)) this.emitFile({ type: "asset", fileName: url.slice(1), source: fs.readFileSync(schemaFile(name)) });
  },
};

export default defineConfig({
  // viteCommonjs: dicom-parser only ships a UMD build (Cornerstone3D framework guide).
  plugins: [
    react(),
    tailwindcss(),
    viteCommonjs(),
    seedServer(path.resolve(__dirname, "../../seed-data"), { kernel }),
    schemaFiles,
    // index.html takes the display name from the naming config.
    { name: "display-name", transformIndexHtml: (html: string) => html.replaceAll("%DISPLAY_NAME%", NAMING.displayName) },
  ],
  // <envPrefix>E2E=1: a frozen dev server for Playwright runs, so edits elsewhere can't reload the page mid-test.
  server: {
    ...(process.env[envVar("E2E")] ? { hmr: false, watch: null } : {}),
    // Workspace packages and first-party plugins live outside apps/web.
    fs: { allow: [REPO_ROOT] },
    // /api/agent goes to the agent service; with the kernel on, the rest of /api goes there (agentProxy is listed first).
    proxy: {
      ...agentProxy,
      ...(kernel ? { "/api": { target: kernelUrl, bypass: (req) => (STAYS_ON_VITE.test(req.url ?? "") ? req.url : undefined) } } : {}),
    },
  },
  resolve: {
    alias: [
      ...aliases,
      // vtk.js (via Cornerstone) imports xmlbuilder2, which needs Node's `events`; we never parse VTK XML.
      { find: "xmlbuilder2", replacement: path.resolve(REPO_ROOT, "packages/studio-renderers/src/cornerstone/xmlbuilder2-stub.ts") },
      { find: "dcmjs", replacement: dcmjsEntry },
    ],
  },
  optimizeDeps: {
    // Cornerstone's loaders resolve their codec WASM and workers via import.meta.url, which pre-bundling breaks.
    exclude: ["@cornerstonejs/dicom-image-loader"],
    include: ["dicom-parser"],
  },
  worker: { format: "es" },
  assetsInclude: ["**/*.wasm"],
});
