import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
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

export default defineConfig({
  // viteCommonjs: dicom-parser only ships a UMD build (Cornerstone3D framework guide).
  plugins: [
    react(),
    tailwindcss(),
    viteCommonjs(),
    seedServer(path.resolve(__dirname, "../../seed-data"), { kernel }),
    // index.html takes the display name from the naming config.
    { name: "display-name", transformIndexHtml: (html: string) => html.replaceAll("%DISPLAY_NAME%", NAMING.displayName) },
  ],
  // <envPrefix>E2E=1: a frozen dev server for Playwright runs, so edits elsewhere can't reload the page mid-test.
  server: {
    ...(process.env[envVar("E2E")] ? { hmr: false, watch: null } : {}),
    // Workspace packages and first-party plugins live outside apps/web.
    fs: { allow: [REPO_ROOT] },
    ...(kernel ? { proxy: { "/api": { target: kernelUrl, bypass: (req) => (STAYS_ON_VITE.test(req.url ?? "") ? req.url : undefined) } } } : {}),
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
