/**
 * Tool wrapping adapted from @daytona/pi (src/tools.ts).
 * Copyright Daytona Platforms Inc. SPDX-License-Identifier: Apache-2.0. See ../../NOTICE.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import type { Sandbox } from "@daytona/sdk";
import {
  type ToolDefinition,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { SandboxUnavailableError } from "../sandbox/client.ts";
import { SANDBOX_CWD, SANDBOX_DATA_DIR, SANDBOX_HOME, SANDBOX_LOG_DIR } from "../sandbox/defaults.ts";
import { ExecAbortedError, shellQuote, streamCommand, truncateMiddle, withRecovery } from "../sandbox/exec.ts";
import { createEditOps, createLsOps, createReadOps, createWriteOps } from "../sandbox/ops.ts";
import { type FindParams, type GrepParams, remoteFind, remoteGrep } from "../sandbox/search.ts";
import type { SampleSource } from "./dataset.ts";

export interface SandboxToolDeps {
  /** Resolve (lazily create/reattach) the session's sandbox. Must throw rather than fall back to the host. */
  acquire: () => Promise<Sandbox>;
  /** The sandbox is gone; drop it so the next call creates a fresh one. */
  onUnavailable?: () => void;
  cwd?: string;
  execTimeoutS: number;
  outputMax: number;
  /** Host directory for exported artifacts (dev); object storage later. */
  artifactsDir: string;
  /** Hard cap; exports above 50 MB also need approval (tools/policy.ts). */
  maxArtifactBytes?: number;
  onArtifact?: (a: ArtifactInfo) => void;
  /** A killed command may have left processes behind: quarantine (recreate) the sandbox. */
  onUncertain?: (detail: string) => void;
  /** Authorized seed files for upload_dataset_sample; the tool is omitted without it. */
  samples?: SampleSource;
  uploadLimits?: { maxFiles: number; maxBytes: number };
}

export interface ArtifactInfo {
  id: string;
  name: string;
  sandboxPath: string;
  bytes: number;
  sha256: string;
  hostPath: string;
  createdAt: number;
}

/** Host-side file name for an artifact: a basename only, never `.`/`..` or a path. */
export function safeArtifactName(sandboxPath: string): string {
  const name = basename(sandboxPath).replace(/[^\w.@()+=-]+/g, "_").replace(/^\.+/, "_").slice(0, 120);
  if (!name || name === "_") throw new Error(`"${sandboxPath}" has no usable file name`);
  return name;
}

/** Run `command` with its combined output also written to `logPath` (in the sandbox); keeps its exit code. */
export function teeCommand(command: string, logPath: string): string {
  const dir = logPath.slice(0, logPath.lastIndexOf("/"));
  return [`mkdir -p ${shellQuote(dir)}`, `{ ${command}`, `} 2>&1 | tee ${shellQuote(logPath)}`, "exit ${PIPESTATUS[0]}"].join("\n");
}

/** Keeps the first and last part of a stream within `max` bytes (UTF-8), however long it gets. */
export class HeadTail {
  private head = "";
  private tailBuf = "";
  private total = 0;
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    this.total += Buffer.byteLength(chunk);
    const half = Math.floor(this.max / 2);
    if (Buffer.byteLength(this.head) < half) {
      const room = half - Buffer.byteLength(this.head);
      const take = Buffer.from(chunk).subarray(0, room).toString("utf8");
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    if (!chunk) return;
    this.tailBuf += chunk;
    if (this.tailBuf.length > this.max * 2) this.tailBuf = this.tailBuf.slice(-this.max);
  }
  get truncated(): boolean {
    return this.total > this.max;
  }
  tail(n: number): string {
    const all = this.head + this.tailBuf;
    return all.length > n ? `…${all.slice(-n)}` : all;
  }
  text(): string {
    return truncateMiddle(this.head + this.tailBuf, this.max).text;
  }
}

export const SANDBOX_TOOL_NAMES = ["bash", "read", "write", "edit", "ls", "find", "grep", "run_python", "preview_url", "export_artifact", "upload_dataset_sample"] as const;

const text = (t: string) => [{ type: "text" as const, text: t }];

export function createSandboxTools(deps: SandboxToolDeps): ToolDefinition<any, any, any>[] {
  const cwd = deps.cwd ?? SANDBOX_CWD;

  const guard = async <T>(fn: (sb: Sandbox) => Promise<T>): Promise<T> => {
    const sb = await deps.acquire();
    try {
      return await fn(sb);
    } catch (err) {
      if (err instanceof SandboxUnavailableError) deps.onUnavailable?.();
      throw err;
    }
  };

  /** pi resolves paths against `ctx.cwd` (the host cwd); hand it the sandbox cwd without mutating pi's ctx. */
  function remote<P extends TSchema, D, S>(
    local: ToolDefinition<P, D, S>,
    make: (sb: Sandbox) => ToolDefinition<P, D, S>,
  ): ToolDefinition<P, D, S> {
    return {
      ...local,
      execute: (id, params, signal, onUpdate, ctx) =>
        guard((sb) => make(sb).execute(id, params, signal, onUpdate, Object.create(ctx, { cwd: { value: cwd } }))),
    };
  }

  // pi's bash schema, our execute: pi would spill long output to a temp file on the HOST and point
  // the model at a path it can't read. Here output streams from the sandbox, the model gets the head
  // and tail (AGENT_TOOL_OUTPUT_MAX), and the full log stays in the sandbox.
  const localBash = createBashToolDefinition(cwd, { exposeSessionEnvironment: false });
  const bash: typeof localBash = {
    ...localBash,
    description:
      `Execute a bash command in the sandbox (working directory ${cwd}). Returns combined stdout and stderr. ` +
      `Output over ${Math.round(deps.outputMax / 1024)} KB keeps the head and tail; the full log is saved in the sandbox under ${SANDBOX_LOG_DIR}/. ` +
      "Optionally provide a timeout in seconds. Start long-running servers in the background with nohup and redirected output.",
    execute: (id, params, signal, onUpdate) =>
      guard(async (sb) => {
        const logPath = `${SANDBOX_LOG_DIR}/${id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "call"}.log`;
        const acc = new HeadTail(deps.outputMax);
        let lastUpdate = 0;
        let exitCode: number;
        try {
          ({ exitCode } = await streamCommand(sb, teeCommand(params.command, logPath), {
            cwd,
            timeoutS: params.timeout ?? deps.execTimeoutS,
            signal,
            onUncertain: deps.onUncertain,
            onData: (chunk) => {
              acc.push(chunk);
              const now = Date.now();
              if (onUpdate && now - lastUpdate > 200) {
                lastUpdate = now;
                onUpdate({ content: text(acc.tail(4000)), details: undefined });
              }
            },
          }));
        } catch (err) {
          if (err instanceof ExecAbortedError) {
            const so_far = acc.text();
            throw new Error(`${so_far ? `${so_far}\n\n` : ""}${err.reason === "timeout" ? `Command timed out after ${params.timeout ?? deps.execTimeoutS}s and was killed` : "Command aborted"}`);
          }
          throw err;
        }
        const body = acc.text() || "(no output)";
        const note = acc.truncated ? `\n\n[Output truncated to the head and tail. Full log in the sandbox: ${logPath}]` : "";
        const details = { exitCode, truncated: acc.truncated, fullOutputPath: acc.truncated ? logPath : undefined } as never;
        // Like pi's bash: a non-zero exit is an error result for the model, not a thrown failure.
        if (exitCode !== 0) return { content: text(`${body}${note}\n\nCommand exited with code ${exitCode}`), details, isError: true };
        return { content: text(body + note), details };
      }),
  };
  const read = remote(createReadToolDefinition(cwd), (sb) => createReadToolDefinition(cwd, { operations: createReadOps(sb) }));
  const write = remote(createWriteToolDefinition(cwd), (sb) => createWriteToolDefinition(cwd, { operations: createWriteOps(sb) }));
  const edit = remote(createEditToolDefinition(cwd), (sb) => createEditToolDefinition(cwd, { operations: createEditOps(sb) }));
  const ls = remote(createLsToolDefinition(cwd), (sb) => createLsToolDefinition(cwd, { operations: createLsOps(sb) }));

  const localFind = createFindToolDefinition(cwd);
  const find: typeof localFind = {
    ...localFind,
    execute: async (_id, params, signal) => {
      if (signal?.aborted) throw new Error("aborted");
      return guard((sb) => remoteFind(sb, cwd, params satisfies FindParams));
    },
  };
  const localGrep = createGrepToolDefinition(cwd);
  const grep: typeof localGrep = {
    ...localGrep,
    execute: async (_id, params, signal) => {
      if (signal?.aborted) throw new Error("aborted");
      return guard((sb) => remoteGrep(sb, cwd, params satisfies GrepParams));
    },
  };

  const contexts = new Map<string, Promise<Awaited<ReturnType<Sandbox["codeInterpreter"]["createContext"]>>>>();
  const runPython = defineTool({
    name: "run_python",
    label: "Run Python",
    description:
      "Run Python in the sandbox's persistent interpreter (variables survive between calls). " +
      "numpy, scipy, pandas, pyarrow, pillow, scikit-image, opencv, matplotlib, pydicom, nibabel and SimpleITK are installed. " +
      `Save files under ${SANDBOX_HOME}/out and use export_artifact to hand them to the user.`,
    promptSnippet: "Run Python code in the sandbox (stateful interpreter)",
    parameters: Type.Object({
      code: Type.String({ description: "Python source to execute" }),
      timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Wall-clock limit in seconds" })),
      fresh: Type.Optional(Type.Boolean({ description: "Start a new interpreter context, discarding variables" })),
    }),
    async execute(_id, { code, timeout_s, fresh }, signal, onUpdate) {
      if (signal?.aborted) throw new Error("aborted");
      return guard(async (sb) => {
        if (fresh) contexts.delete(sb.id);
        let ctxP = contexts.get(sb.id);
        if (!ctxP) {
          ctxP = withRecovery(sb, () => sb.codeInterpreter.createContext(cwd));
          contexts.set(sb.id, ctxP);
          ctxP.catch(() => contexts.delete(sb.id));
        }
        const context = await ctxP;
        let streamed = "";
        const push = (chunk: string) => {
          streamed += chunk;
          onUpdate?.({ content: text(truncateMiddle(streamed, deps.outputMax).text), details: undefined });
        };
        const res = await sb.codeInterpreter.runCode(code, {
          context,
          timeout: timeout_s ?? deps.execTimeoutS,
          onStdout: (m) => push(m.output),
          onStderr: (m) => push(m.output),
        });
        const parts = [res.stdout && `stdout:\n${res.stdout}`, res.stderr && `stderr:\n${res.stderr}`];
        if (res.error) parts.push(`error: ${res.error.name}: ${res.error.value}\n${res.error.traceback ?? ""}`);
        const body = truncateMiddle(parts.filter(Boolean).join("\n\n") || "(no output)", deps.outputMax).text;
        if (res.error) throw new Error(body);
        return { content: text(body), details: { stdout: res.stdout, stderr: res.stderr } };
      });
    },
  });

  const previewUrl = defineTool({
    name: "preview_url",
    label: "Preview URL",
    description:
      "Get a signed, expiring URL for a port served inside the sandbox (e.g. after `python -m http.server 8000 &`). " +
      "The link only opens that one port.",
    promptSnippet: "Get a browser-openable signed URL for a port in the sandbox",
    parameters: Type.Object({
      port: Type.Integer({ minimum: 1024, maximum: 65535, description: "Port the server listens on" }),
      expires_s: Type.Optional(Type.Integer({ minimum: 60, maximum: 86_400 })),
    }),
    async execute(_id, { port, expires_s }) {
      return guard(async (sb) => {
        const link = await withRecovery(sb, () => sb.getSignedPreviewUrl(port, expires_s ?? 3600));
        return {
          content: text(`Preview URL for port ${port} (expires in ${expires_s ?? 3600}s): ${link.url}`),
          details: { url: link.url, port },
        };
      });
    },
  });

  const maxArtifact = deps.maxArtifactBytes ?? 500 * 1024 * 1024;
  const exportArtifact = defineTool({
    name: "export_artifact",
    label: "Export artifact",
    description: `Copy a file from the sandbox to the user's artifact list (max ${Math.round(maxArtifact / 1024 / 1024)} MB). Returns metadata, not contents.`,
    promptSnippet: "Hand a sandbox file (report, figure, CSV) to the user",
    parameters: Type.Object({ path: Type.String({ description: "Absolute or cwd-relative path in the sandbox" }) }),
    async execute(id, { path }) {
      return guard(async (sb) => {
        const abs = path.startsWith("/") ? posix.normalize(path) : posix.join(cwd, path);
        const info = await withRecovery(sb, () => sb.fs.getFileDetails(abs));
        if (info.isDir) throw new Error(`${abs} is a directory`);
        if (info.size > maxArtifact) throw new Error(`${abs} is ${info.size} bytes; the limit is ${maxArtifact}`);
        const data = await withRecovery(sb, () => sb.fs.downloadFile(abs));
        const sha256 = createHash("sha256").update(data).digest("hex");
        await mkdir(deps.artifactsDir, { recursive: true });
        const artifactId = `${id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "a"}-${sha256.slice(0, 8)}`;
        const name = safeArtifactName(abs);
        const hostPath = join(deps.artifactsDir, `${artifactId}-${name}`);
        await writeFile(hostPath, data);
        const artifact: ArtifactInfo = { id: artifactId, name, sandboxPath: abs, bytes: data.length, sha256, hostPath, createdAt: Date.now() };
        deps.onArtifact?.(artifact);
        return {
          content: text(`Exported ${name} (${data.length} bytes, sha256 ${sha256.slice(0, 12)}…) as artifact ${artifactId}.`),
          details: { id: artifactId, name, bytes: data.length, sha256, summary: `${name} · ${formatBytes(data.length)}` },
        };
      });
    },
  });

  const limits = deps.uploadLimits ?? { maxFiles: 20, maxBytes: 200 * 1024 * 1024 };
  const samples = deps.samples;
  const uploadSample = samples
    ? defineTool({
        name: "upload_dataset_sample",
        label: "Upload dataset sample",
        description:
          `Copy the files behind some dataset items (by item id or name) into ${SANDBOX_DATA_DIR}/ so code can read them. ` +
          `At most ${limits.maxFiles} files and ${formatBytes(limits.maxBytes)} per call. Only items of the open dataset are available.`,
        promptSnippet: "Copy dataset item files into the sandbox for analysis",
        parameters: Type.Object({ itemIds: Type.Array(Type.String(), { minItems: 1, maxItems: limits.maxFiles }) }),
        async execute(_id, { itemIds }, signal, onUpdate) {
          const files = await samples.resolve(itemIds, signal);
          if (files.length > limits.maxFiles) throw new Error(`${files.length} files requested; the limit is ${limits.maxFiles} per call`);
          return guard(async (sb) => {
            let total = 0;
            const written: string[] = [];
            for (const f of files) {
              if (signal?.aborted) throw new Error("aborted");
              const data = await samples.read(f.path, signal);
              total += data.length;
              if (total > limits.maxBytes) throw new Error(`upload exceeds ${formatBytes(limits.maxBytes)}; ask for fewer items`);
              const dest = posix.join(SANDBOX_DATA_DIR, f.path);
              if (!dest.startsWith(`${SANDBOX_DATA_DIR}/`)) throw new Error(`refusing to write outside ${SANDBOX_DATA_DIR}`);
              await withRecovery(sb, () => sb.fs.createFolder(posix.dirname(dest), "755"));
              await withRecovery(sb, () => sb.fs.uploadFile(data, dest));
              written.push(dest);
              onUpdate?.({ content: text(`${written.length}/${files.length} ${dest}`), details: undefined });
            }
            return {
              content: text(`Copied ${written.length} file(s), ${formatBytes(total)}:\n${written.join("\n")}`),
              details: { files: written, bytes: total, summary: `${written.length} file${written.length === 1 ? "" : "s"} · ${formatBytes(total)}` },
            };
          });
        },
      })
    : undefined;

  return [bash, read, write, edit, ls, find, grep, runPython, previewUrl, exportArtifact, ...(uploadSample ? [uploadSample] : [])];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}