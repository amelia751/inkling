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
import { SANDBOX_CWD, SANDBOX_HOME } from "../sandbox/defaults.ts";
import { truncateMiddle, withRecovery } from "../sandbox/exec.ts";
import { createBashOps, createEditOps, createLsOps, createReadOps, createWriteOps } from "../sandbox/ops.ts";
import { type FindParams, type GrepParams, remoteFind, remoteGrep } from "../sandbox/search.ts";

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
  maxArtifactBytes?: number;
  onArtifact?: (a: ArtifactInfo) => void;
}

export interface ArtifactInfo {
  id: string;
  name: string;
  sandboxPath: string;
  bytes: number;
  sha256: string;
  hostPath: string;
}

export const SANDBOX_TOOL_NAMES = ["bash", "read", "write", "edit", "ls", "find", "grep", "run_python", "preview_url", "export_artifact"] as const;

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

  const bash = remote(createBashToolDefinition(cwd), (sb) =>
    createBashToolDefinition(cwd, {
      operations: createBashOps(sb, { defaultTimeoutS: deps.execTimeoutS }),
      exposeSessionEnvironment: false,
    }),
  );
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

  const maxArtifact = deps.maxArtifactBytes ?? 50 * 1024 * 1024;
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
        const name = basename(abs);
        const hostPath = join(deps.artifactsDir, `${artifactId}-${name}`);
        await writeFile(hostPath, data);
        const artifact: ArtifactInfo = { id: artifactId, name, sandboxPath: abs, bytes: data.length, sha256, hostPath };
        deps.onArtifact?.(artifact);
        return {
          content: text(`Exported ${name} (${data.length} bytes, sha256 ${sha256.slice(0, 12)}…) as artifact ${artifactId}.`),
          details: { id: artifactId, name, bytes: data.length, sha256 },
        };
      });
    },
  });

  return [bash, read, write, edit, ls, find, grep, runPython, previewUrl, exportArtifact];
}