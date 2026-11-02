import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";
import { seedServer } from "./dev/seed-server";
import { aliases, REPO_ROOT } from "./aliases";
// The config is bundled by esbuild before aliases exist and can't import workspace TS, so it
// reads the emitted copy of packages/contracts/src/naming.ts.
import NAMING from "../../schemas/naming.json";

/** The one place the web build and dev server read the environment: `env("API_URL")` → `<envPrefix>API_URL`. */
const env = (key: string): string | undefined => process.env[`${NAMING.envPrefix}${key}`] || undefined;

// <envPrefix>API_URL: proxy /api to the API (apps/api) instead of the dev seed server, and
// tell the SPA (define below) that the kernel serves commands, jobs and assets. The catalogue,
// environment validation and the assistant stay here: they run the TS registry. Saved
// environments go to the kernel, as in production, so revisions, last-known-good and rollback
// (todo10) are one store.
const kernelUrl = env("API_URL");
const kernel = !!kernelUrl;
const STAYS_ON_VITE = /^\/api\/(agent|catalog|environments\/validate)(\/|$|\?)/;

// <envPrefix>E2E=1: a frozen dev server for Playwright runs (see `server` below). It keeps
// annotations in a fresh temp copy of e2e/fixtures/annotations/, so no test reads or writes the
// developer's seed-data/.annotations. <envPrefix>WEB_ANNOTATIONS_DIR picks the folder explicitly.
const e2e = !!env("E2E");
function e2eAnnotations(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${NAMING.resourcePrefix}-e2e-annotations-`));
  fs.cpSync(path.resolve(__dirname, "e2e/fixtures/annotations"), dir, { recursive: true });
  return dir;
}
const annotationsDir = env("WEB_ANNOTATIONS_DIR") ?? (e2e && !kernel ? e2eAnnotations() : undefined);
// Resume state (todo6 D9) without the kernel: a fresh temp folder per e2e run, like annotations.
const resumeDir = e2e && !kernel ? fs.mkdtempSync(path.join(os.tmpdir(), `${NAMING.resourcePrefix}-e2e-resume-`)) : undefined;

// dcmjs is a dependency of @cornerstonejs/adapters only (pnpm keeps it private); the DICOM
// SEG/SR exporters need its writer, so resolve the adapters' own copy (one instance).
const adaptersDir = fs.realpathSync(path.resolve(REPO_ROOT, "plugins/dicom-export/node_modules/@cornerstonejs/adapters"));
const dcmjsEntry = path.resolve(adaptersDir, "../../dcmjs/build/dcmjs.es.js");

/**
 * The agent service (apps/agent) on 127.0.0.1:8100. The browser calls /api/agent/*; the proxy maps it
 * to /v1/* and adds the service token from the real env or secrets/agent.env (written by the service
 * on first start), so the token never reaches the browser.
 */
const AGENT_URL = env("AGENT_URL") ?? "http://127.0.0.1:8100";
let agentToken = env("AGENT_TOKEN");
function serviceToken(): string | undefined {
  if (agentToken) return agentToken;
  const file = path.resolve(__dirname, "../../secrets/agent.env");
  if (!fs.existsSync(file)) return undefined;
  agentToken = new RegExp(`^${NAMING.envPrefix}AGENT_TOKEN=(.+)$`, "m").exec(fs.readFileSync(file, "utf8"))?.[1]?.trim();
  return agentToken;
}
/**
 * Dev identity (todo14 M0, src/studio/lib/dev-principal.ts): "Start as a new person" sends
 * `X-Dev-Principal: user:dev-<id>` on fetches; an EventSource can't, so its URL carries
 * `devPrincipal=`, which becomes the header here. Anything not shaped like a dev principal is dropped.
 */
const DEV_PRINCIPAL = /^user:dev-[a-z0-9]{4,32}$/;
function forwardDevPrincipal(proxyReq: { path: string; getHeader(n: string): unknown; setHeader(n: string, v: string): unknown; removeHeader(n: string): void }) {
  const url = new URL(proxyReq.path, "http://proxy");
  const fromQuery = url.searchParams.get("devPrincipal");
  if (fromQuery !== null) {
    url.searchParams.delete("devPrincipal");
    proxyReq.path = url.pathname + url.search;
    if (DEV_PRINCIPAL.test(fromQuery)) proxyReq.setHeader("x-dev-principal", fromQuery);
  }
  const header = proxyReq.getHeader("x-dev-principal");
  if (header !== undefined && !(typeof header === "string" && DEV_PRINCIPAL.test(header))) proxyReq.removeHeader("x-dev-principal");
}

/**
 * <envPrefix>WEB_AUTH_MODE=workos (todo9 Phase 5, as the web nginx does): before proxying, ask the API
 * (`/api/auth/verify` with the browser's cookie) for the person's WorkOS access token and forward it
 * as `Authorization: Bearer`; the service token then travels in `X-Agent-Service-Token`. In `dev`
 * mode the service token is sent in both headers, so an agent of either version accepts it.
 */
const agentAuthMode = env("WEB_AUTH_MODE") === "workos" ? "workos" : "dev";
if (agentAuthMode === "workos" && !kernelUrl) throw new Error(`${NAMING.envPrefix}WEB_AUTH_MODE=workos needs ${NAMING.envPrefix}API_URL (the API answers /api/auth/verify)`);
const AGENT_SERVICE_TOKEN_HEADER = "x-agent-service-token";
async function verifyForAgent(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | undefined> {
  if (agentAuthMode !== "workos") return undefined;
  const fail = (status: number, error: string) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error }));
    return req.url;
  };
  let verified: Response;
  try {
    verified = await fetch(`${kernelUrl}/api/auth/verify`, { headers: { cookie: req.headers.cookie ?? "" } });
  } catch {
    return fail(503, "the API is unreachable");
  }
  if (verified.status === 401) return fail(401, "sign in required");
  if (!verified.ok) return fail(503, `the API answered ${verified.status}`);
  const accessToken = verified.headers.get("x-access-token");
  // 200 without a token: the API runs in dev mode; the agent then needs only the service token.
  if (accessToken) req.headers.authorization = `Bearer ${accessToken}`;
  else delete req.headers.authorization;
  return undefined;
}
const agentProxy: Record<string, ProxyOptions> = {
  "/api/agent": {
    target: AGENT_URL,
    rewrite: (p: string) => p.replace(/^\/api\/agent/, "/v1"),
    // Runs (awaited) before the proxy: a string means "answered here" (401/503 already written).
    bypass: (req, res) => (res ? verifyForAgent(req, res) : undefined),
    configure: (proxy) => {
      proxy.on("proxyReq", (req) => {
        // A dev identity means nothing once the agent verifies WorkOS tokens.
        if (agentAuthMode === "dev") forwardDevPrincipal(req);
        else req.removeHeader("x-dev-principal");
        const token = serviceToken();
        if (!token) return;
        req.setHeader(AGENT_SERVICE_TOKEN_HEADER, token);
        if (agentAuthMode === "dev") req.setHeader("authorization", `Bearer ${token}`);
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

/**
 * The MCP Apps sandbox proxy (public/sandbox-proxy.html, todo10 Phase 5) is served with a CSP
 * header that blocks every network request; the View's srcdoc frame inherits it. Same value as
 * nginx/default.conf.template. In dev the Studio loads it from http://sandbox.localhost:<port>,
 * a separate origin served by this same server (Vite allows *.localhost hosts).
 */
export const SANDBOX_PROXY_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
const sandboxProxy: Plugin = {
  name: "sandbox-proxy-csp",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if ((req.url ?? "").split("?")[0] === "/sandbox-proxy.html") {
        res.setHeader("content-security-policy", SANDBOX_PROXY_CSP);
        res.setHeader("cache-control", "no-store");
      }
      next();
    });
  },
};

export default defineConfig({
  // viteCommonjs: dicom-parser only ships a UMD build (Cornerstone3D framework guide).
  plugins: [
    react(),
    tailwindcss(),
    viteCommonjs(),
    seedServer(path.resolve(__dirname, "../../seed-data"), { kernel, annotationsDir, resumeDir }),
    schemaFiles,
    sandboxProxy,
    // index.html takes the display name from the naming config.
    { name: "display-name", transformIndexHtml: (html: string) => html.replaceAll("%DISPLAY_NAME%", NAMING.displayName) },
  ],
  // E2E: frozen, so edits elsewhere can't reload the page mid-test.
  server: {
    ...(e2e ? { hmr: false, watch: null } : {}),
    // Workspace packages and first-party plugins live outside apps/web.
    fs: { allow: [REPO_ROOT] },
    // /api/agent goes to the agent service; with the API on, the rest of /api goes there (agentProxy is listed first).
    proxy: {
      ...agentProxy,
      ...(kernel ? { "/api": { target: kernelUrl, bypass: (req) => (STAYS_ON_VITE.test(req.url ?? "") ? req.url : undefined), configure: (proxy) => proxy.on("proxyReq", forwardDevPrincipal) } } : {}),
    },
  },
  // runtime-config.ts reads this as the dev default for `kernel` (/config.json decides in images).
  define: { "import.meta.env.DEV_API": JSON.stringify(kernel) },
  resolve: {
    alias: [
      ...aliases,
      // vtk.js (via Cornerstone) imports xmlbuilder2, which needs Node's `events`; we never parse VTK XML.
      { find: "xmlbuilder2", replacement: path.resolve(REPO_ROOT, "packages/renderers/src/cornerstone/xmlbuilder2-stub.ts") },
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
