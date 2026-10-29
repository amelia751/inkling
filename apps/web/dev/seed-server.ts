import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/**
 * Dev-only stand-in for the FastAPI backend (inkling.md §3.2):
 *   GET   /seed/*                       → files under seed-data/
 *   GET   /api/annotations/:projectId   → saved annotation document (or empty)
 *   PUT   /api/annotations/:projectId   → persist annotation document
 *   GET   /api/catalog                  → module / contribution catalogue (agent surface)
 *   GET   /api/catalog/schema           → environment JSON Schema with registered-id enums
 *   POST  /api/environments/validate    → resolve a spec; structured errors
 *   GET   /api/environments/:projectId  → saved environment edits ({ environment: null } if none)
 *   PUT   /api/environments/:projectId  → replace (validated); { revision, environment, author }
 *   PATCH /api/environments/:projectId  → RFC 6902 JSON Patch (validated); { revision?, patch, author }
 *   GET   /api/environments/:projectId/history → every saved revision with author and time
 *   GET   /api/agent/status             → whether Claude credentials are configured
 *   POST  /api/agent/messages           → one Messages API turn for the Studio assistant
 *                                         (the browser runs the tool loop; the key stays here)
 * Annotations and environments live in seed-data/.annotations/ and .environments/ so seed
 * files are never modified. Validation runs the app's own registry and resolver through
 * Vite's SSR loader (src/server-entry.ts).
 */
type ServerApi = typeof import("../src/server-entry");

export function seedServer(seedRoot: string): Plugin {
  const annotationsDir = path.join(seedRoot, ".annotations");
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
    name: "inkling-seed-server",
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
      server.middlewares.use("/api/agent", (req, res) => handleAgent(req, res));

      server.middlewares.use("/api/annotations", (req, res) => {
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
    if (req.method === "GET") return sendJson(res, 200, current());

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

// ---- Studio assistant ------------------------------------------------------------------

const AGENT_MODEL = "claude-opus-5-5";

/**
 * Relay one assistant turn to the Claude API. The browser owns the conversation and runs
 * the tools (they act on the live Studio); this side only holds the credentials. The SDK
 * resolves them from ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
 */
async function handleAgent(req: IncomingMessage, res: ServerResponse) {
  const sub = (req.url ?? "/").split("?")[0];
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  if (sub === "/status" && req.method === "GET") {
    const configured = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || fs.existsSync(path.join(process.env.HOME ?? "", ".config/anthropic")));
    return sendJson(res, 200, { available: configured, model: AGENT_MODEL });
  }
  if (sub !== "/messages" || req.method !== "POST") return sendJson(res, 404, { error: "not found" });
  const body = (await readBody(req)) as { system: string; messages: unknown[]; tools: unknown[] } | undefined;
  if (!body?.messages?.length) return sendJson(res, 400, { error: "messages required" });
  try {
    const client = new Anthropic();
    const message = await client.beta.messages.create({
      model: AGENT_MODEL,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // The catalogue is long and stable: cache system + tools across turns.
      system: [{ type: "text", text: body.system, cache_control: { type: "ephemeral" } }],
      tools: body.tools as never,
      messages: body.messages as never,
      // Refusals are re-run on a fallback model chosen by category.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as never);
    return sendJson(res, 200, message);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return sendJson(res, 401, { error: "Claude credentials were rejected. Set ANTHROPIC_API_KEY or run `ant auth login`, then restart the dev server." });
    if (e instanceof Anthropic.RateLimitError) return sendJson(res, 429, { error: "Rate limited by the Claude API; try again in a moment." });
    if (e instanceof Anthropic.APIError) return sendJson(res, e.status ?? 502, { error: e.message });
    return sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) });
  }
}
