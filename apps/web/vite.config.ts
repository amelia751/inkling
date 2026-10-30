import fs from "node:fs";
import path from "node:path";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";
import { seedServer } from "./dev/seed-server";

// dcmjs is a dependency of @cornerstonejs/adapters only (pnpm keeps it private); the DICOM
// SEG/SR exporters need its writer, so resolve the adapters' own copy (one instance).
const adaptersDir = fs.realpathSync(path.resolve(__dirname, "node_modules/@cornerstonejs/adapters"));
const dcmjsEntry = path.resolve(adaptersDir, "../../dcmjs/build/dcmjs.es.js");

/**
 * The agent service (apps/agent) on 127.0.0.1:8100. The browser calls /api/agent/*; the proxy maps it
 * to /v1/* and adds the service token from the real env or secrets/agent.env (written by the service
 * on first start), so the token never reaches the browser.
 */
const AGENT_URL = process.env.INKLING_AGENT_URL ?? "http://127.0.0.1:8100";
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

export default defineConfig({
  // viteCommonjs: dicom-parser only ships a UMD build (Cornerstone3D framework guide).
  plugins: [react(), tailwindcss(), viteCommonjs(), seedServer(path.resolve(__dirname, "../../seed-data"))],
  // INKLING_E2E=1: a frozen dev server for Playwright runs, so edits elsewhere can't reload the page mid-test.
  server: process.env.INKLING_E2E ? { hmr: false, watch: null, proxy: agentProxy } : { proxy: agentProxy },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // vtk.js (via Cornerstone) imports xmlbuilder2, which needs Node's `events`; we never parse VTK XML.
      xmlbuilder2: path.resolve(__dirname, "src/kits/cornerstone/xmlbuilder2-stub.ts"),
      dcmjs: dcmjsEntry,
    },
  },
  optimizeDeps: {
    // Cornerstone's loaders resolve their codec WASM and workers via import.meta.url, which pre-bundling breaks.
    exclude: ["@cornerstonejs/dicom-image-loader"],
    include: ["dicom-parser"],
  },
  worker: { format: "es" },
  assetsInclude: ["**/*.wasm"],
});
