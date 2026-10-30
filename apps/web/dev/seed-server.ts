import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
// Loaded by vite.config.ts, which can't import workspace TS: read the emitted naming config.
import NAMING from "../../../schemas/naming.json";

const RES = NAMING.resourcePrefix;

/**
 * Dev-only stand-in for the FastAPI backend (docs/product.md §3.2):
 *   GET   /seed/*                       → files under seed-data/
 *   GET   /api/annotations/:projectId   → saved annotation document (or empty)
 *   PUT   /api/annotations/:projectId   → persist annotation document
 *   GET   /api/catalog                  → module / contribution catalogue (agent surface)
 *   GET   /api/catalog/schema           → environment JSON Schema with registered-id enums
 *   GET   /api/catalog/capabilities     → capabilities of active plugins (plugin.yaml)
 *   GET   /api/catalog/plugins/:id      → one plugin's manifest and declarative UI
 *   POST  /api/environments/validate    → resolve a spec; structured errors
 *   GET   /api/environments/:projectId  → saved environment edits ({ environment: null } if none)
 *   PUT   /api/environments/:projectId  → replace (validated); { revision, environment, author }
 *   PATCH /api/environments/:projectId  → RFC 6902 JSON Patch (validated); { revision?, patch, author }
 *   GET   /api/environments/:projectId/history → every saved revision with author and time
 *   GET   /api/v1/workspaces/:id/state → active plugins: seed-data/<id>/workspace.json, else every
 *                                         bundled plugin (the kernel serves this when it runs)
 *   /api/agent/*                        → not here: Vite proxies it to the agent service (apps/agent)
 * Annotations and environments live in seed-data/.annotations/ and .environments/ so seed
 * files are never modified (`annotationsDir` moves annotations elsewhere: e2e runs use a temp copy). Validation runs the app's own registry and resolver through
 * Vite's SSR loader (src/server-entry.ts).
 */
type ServerApi = typeof import("@/server-entry");

/** `kernel`: the Python kernel serves annotations and workspace state (vite.config.ts proxies /api). */
export function seedServer(seedRoot: string, { kernel = false, annotationsDir = path.join(seedRoot, ".annotations") }: { kernel?: boolean; annotationsDir?: string } = {}): Plugin {
  const environmentsDir = path.join(seedRoot, ".environments");
  const types: Record<string, string> = {
    ".json": "application/json",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".gz": "application/gzip",
    ".mp4": "video/mp4",
    ".dzi": "application/xml",
  };

  return {
    name: `${RES}-seed-server`,
    configureServer(server) {
      server.middlewares.use("/seed", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const file = path.resolve(seedRoot, "." + rel);
        if (!file.startsWith(seedRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return next();
        }
        res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
        res.setHeader("Accept-Ranges", "bytes");
        // Video seeking needs byte ranges.
        const size = fs.statSync(file).size;
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
        if (range) {
          const start = range[1] ? Number(range[1]) : size - Number(range[2]);
          const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start >= size || start > end) {
            res.statusCode = 416;
            res.setHeader("Content-Range", `bytes */${size}`);
            return res.end();
          }
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          res.setHeader("Content-Length", end - start + 1);
          return fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.setHeader("Content-Length", size);
        fs.createReadStream(file).pipe(res);
      });

      const api = () => server.ssrLoadModule("/src/server-entry.ts") as Promise<ServerApi>;
      server.middlewares.use("/api/catalog", (req, res) => handleCatalog(req, res, api));
      server.middlewares.use("/api/environments", (req, res) => handleEnvironments(req, res, api, environmentsDir, seedRoot));
      if (!kernel) server.middlewares.use("/api/v1/workspaces", async (req, res, next) => {
        const m = /^\/([a-z0-9-]+)\/state$/.exec((req.url ?? "").split("?")[0]);
        if (!m || req.method !== "GET") return next();
        const file = path.join(seedRoot, m[1], "workspace.json");
        if (!fs.existsSync(file)) return sendJson(res, 200, (await api()).allBundledState(m[1]));
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { plugins?: (string | { pluginId: string; version?: string })[] };
        const plugins = (raw.plugins ?? []).map((p) => (typeof p === "string" ? { pluginId: p, version: "0.0.0", state: "ACTIVATED" } : { version: "0.0.0", state: "ACTIVATED", ...p }));
        return sendJson(res, 200, { workspaceId: m[1], plugins });
      });

      if (!kernel) server.middlewares.use("/api/annotations", (req, res) => {
        const id = (req.url ?? "").replace(/^\//, "").split("?")[0];
        if (!/^[a-z0-9-]+$/.test(id)) {
          res.statusCode = 400;
          return res.end();
        }
        const file = path.join(annotationsDir, `${id}.json`);
        res.setHeader("Content-Type", "application/json");

        if (req.method === "GET") {
          return res.end(fs.existsSync(file) ? fs.readFileSync(file) : JSON.stringify({ revision: 0, annotations: [] }));
        }
        if (req.method === "PUT") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const doc = JSON.parse(body);
              fs.mkdirSync(annotationsDir, { recursive: true });
              const saved = { ...doc, revision: (doc.revision ?? 0) + 1, savedAt: new Date().toISOString() };
              fs.writeFileSync(file, JSON.stringify(saved, null, 2));
              res.end(JSON.stringify(saved));
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: "invalid annotation document" }));
            }
          });
          return;
        }
        res.statusCode = 405;
        res.end();
      });
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : undefined);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function handleCatalog(req: IncomingMessage, res: ServerResponse, api: () => Promise<ServerApi>) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  const m = await api();
  const sub = (req.url ?? "/").split("?")[0];
  if (sub === "/schema") return sendJson(res, 200, m.schema());
  if (sub === "/capabilities") return sendJson(res, 200, m.listCapabilities());
  const plugin = /^\/plugins\/(.+)$/.exec(sub);
  if (plugin) {
    const pkg = m.PLUGIN_PACKAGES.packages.find((p) => p.manifest.id === decodeURIComponent(plugin[1]));
    return pkg ? sendJson(res, 200, { manifest: pkg.manifest, declarativeUi: pkg.contributions }) : sendJson(res, 404, { error: "unknown plugin" });
  }
  if (sub === "/prompt") {
    res.setHeader("Content-Type", "text/markdown");
    return res.end(m.prompt());
  }
  return sendJson(res, 200, m.catalog());
}

interface EnvDoc {
  revision: number;
  environment: unknown;
  savedAt?: string;
  author?: string;
}

async function handleEnvironments(req: IncomingMessage, res: ServerResponse, api: () => Promise<ServerApi>, dir: string, seedRoot: string) {
  const parts = (req.url ?? "").split("?")[0].split("/").filter(Boolean);
  try {
    const m = await api();
    if (parts[0] === "validate" && req.method === "POST") {
      const r = m.validate(await readBody(req));
      return sendJson(res, r.ok ? 200 : 422, r);
    }
    const id = parts[0] ?? "";
    if (!/^[a-z0-9-]+$/.test(id)) return sendJson(res, 400, { error: "bad project id" });
    const file = path.join(dir, `${id}.json`);
    const historyFile = path.join(dir, `${id}.history.jsonl`);
    const current = (): EnvDoc => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { revision: 0, environment: null });

    if (parts[1] === "history" && req.method === "GET") {
      const lines = fs.existsSync(historyFile) ? fs.readFileSync(historyFile, "utf8").trim().split("\n").filter(Boolean) : [];
      return sendJson(res, 200, lines.map((l) => JSON.parse(l)));
    }
    if (req.method === "GET") {
      // `effective`: what the Studio boots with (saved edits, else the manifest's environment).
      const cur = current();
      return sendJson(res, 200, { ...cur, effective: cur.environment ?? manifestEnvironment(seedRoot, id, m) });
    }

    const save = (environment: unknown, author: string) => {
      const doc: EnvDoc = { revision: current().revision + 1, environment, savedAt: new Date().toISOString(), author };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
      fs.appendFileSync(historyFile, JSON.stringify(doc) + "\n");
      return doc;
    };
    const body = (await readBody(req)) as { revision?: number; environment?: unknown; patch?: unknown; author?: string } | undefined;
    if (!body) return sendJson(res, 400, { error: "missing body" });
    const cur = current();
    // Same optimistic-concurrency rule for both verbs: a stale revision is a conflict.
    if (body.revision !== undefined && body.revision !== cur.revision) return sendJson(res, 409, { error: "revision conflict", current: cur });
    const author = body.author ?? "local-expert";

    if (req.method === "PUT") {
      const r = m.validate(body.environment);
      if (!r.ok) return sendJson(res, 422, r);
      return sendJson(res, 200, save(body.environment, author));
    }
    if (req.method === "PATCH") {
      const base = cur.environment ?? manifestEnvironment(seedRoot, id, m);
      if (!base) return sendJson(res, 404, { error: `no project "${id}"` });
      const r = m.patch(base as never, body.patch as never);
      if (!r.ok) return sendJson(res, 422, r);
      return sendJson(res, 200, save(r.spec, author));
    }
    return sendJson(res, 405, { error: "method not allowed" });
  } catch (e) {
    return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

function manifestEnvironment(seedRoot: string, id: string, m: ServerApi): unknown {
  const manifest = JSON.parse(fs.readFileSync(path.join(seedRoot, "manifest.json"), "utf8")) as { projects: { id: string }[] };
  const raw = manifest.projects.find((p) => p.id === id);
  return raw ? m.normalizeProject(raw as never).environment : null;
}
