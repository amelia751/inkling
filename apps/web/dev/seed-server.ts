import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { AgentEvent, AgentStatus, ChatRequest } from "../src/lib/agent/protocol";
import { agentConfigured, agentModel, runAgent } from "./agent/runtime";

/**
 * Dev-only stand-in for the FastAPI backend (inkling.md §3.2):
 *   GET  /seed/*                      → files under seed-data/
 *   GET  /api/annotations/:projectId  → saved annotation document (or empty)
 *   PUT  /api/annotations/:projectId  → persist annotation document
 *   /api/agent/*                      → Inkling AI agent runtime (see agentMiddleware)
 * Annotations live in seed-data/.annotations/ so seed files are never modified.
 */
export function seedServer(seedRoot: string): Plugin {
  const annotationsDir = path.join(seedRoot, ".annotations");
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

      server.middlewares.use("/api/agent", agentMiddleware);
    },
  };
}

const MAX_BODY = 4 * 1024 * 1024;

/**
 *   GET  /api/agent/status  → AgentStatus
 *   POST /api/agent/chat    → SSE stream of AgentEvents (protocol.ts)
 */
function agentMiddleware(req: IncomingMessage, res: ServerResponse) {
  const route = (req.url ?? "").split("?")[0];
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" && route === "/status") {
    const status: AgentStatus = { configured: agentConfigured(), provider: "OpenAI", model: agentConfigured() ? agentModel() : null };
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(status));
  }
  if (req.method !== "POST" || route !== "/chat") {
    res.statusCode = 404;
    return res.end();
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) req.destroy();
  });
  req.on("end", async () => {
    let request: ChatRequest;
    try {
      request = JSON.parse(body);
      if (!Array.isArray(request.messages) || !request.context?.project) throw new Error();
    } catch {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "invalid chat request" }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const emit = (e: AgentEvent) => res.writableEnded || res.write(`data: ${JSON.stringify(e)}\n\n`);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    try {
      if (!agentConfigured()) throw new Error("No model is configured. Set OPENAI_API_KEY for the dev server and restart it.");
      await runAgent(request.messages, request.context, emit, abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearInterval(heartbeat);
      emit({ type: "done" });
      res.end();
    }
  });
}
