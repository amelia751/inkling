import { createHash } from "node:crypto";
import type { Sandbox } from "@daytona/sdk";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "./define.ts";
import { BuildResult, Fingerprint, FixtureSet, JobSummary, ProbeResult, Probe as ProbeSchema, VerifyReport } from "@studio/contracts/boundary";
import { Type } from "typebox";
import type { z } from "zod";
import { withRecovery } from "../sandbox/exec.ts";
import { filesDigest, readTarGz } from "../sandbox/tar.ts";
import { type KernelClient, KernelError } from "./kernel.ts";

/**
 * Build outside, verify inside (todo10 §6, Phase 7). The agent never touches a real sample: it
 * asks the kernel, whose worker runs the job inside the patient-data project, and gets back only
 * the fixed-schema results in `@studio/contracts/boundary`. Every response is parsed with those
 * schemas here too, so an unexpected field (where free text could hide) fails the tool instead
 * of reaching the model. Only synthetic fixtures are copied into the build sandbox, each checked
 * against the sha256 the kernel listed; sample bytes have no path into a sandbox at all.
 */

export const BOUNDARY_TOOL_NAMES = ["get_fingerprint", "get_fixtures", "verify_on_sample", "probe_sample"] as const;
export const FIXTURES_DIR = "fixtures";

export interface BoundaryDeps {
  /** The build sandbox (fixtures go in, plugin source comes out); tools that need it fail without it. */
  acquire?: () => Promise<Sandbox>;
  /** Where the plugin source lives in the sandbox (PLUGIN_DIR). */
  sourceDir: string;
  /** Packs `sourceDir` into a tarball (tools/kernel.ts packTarball). */
  pack?: (sb: Sandbox) => Promise<Uint8Array>;
  pollMs?: number;
  timeoutS?: number;
  sleep?: (ms: number) => Promise<void>;
}

const out = (value: unknown, summary: string) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { summary } });
const SAMPLE = Type.String({ minLength: 1, maxLength: 512, description: "The sample: an asset id or path of this project (from list_assets or the dataset's item assets)." });

interface JobView<T> {
  job: z.infer<typeof JobSummary>;
  result: T | null;
}

/** Poll a boundary job until it ends; the result is parsed with its contract or the tool fails. */
export async function awaitJob<S extends z.ZodType>(k: KernelClient, job: unknown, schema: S, deps: Pick<BoundaryDeps, "pollMs" | "timeoutS" | "sleep">, signal?: AbortSignal): Promise<JobView<z.infer<S>>> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let view = { job: JobSummary.parse(job), result: null as unknown };
  const deadline = Date.now() + (deps.timeoutS ?? 300) * 1000;
  while (view.job.state === "queued" || view.job.state === "running") {
    if (signal?.aborted) throw new Error("aborted");
    if (Date.now() > deadline) throw new Error(`job ${view.job.jobId} is still ${view.job.state}; check it later with the same call`);
    await sleep(deps.pollMs ?? 500);
    const r = await k.get<{ job: unknown; result: unknown }>(`/boundary/jobs/${encodeURIComponent(view.job.jobId)}`, signal);
    view = { job: JobSummary.parse(r.job), result: r.result };
  }
  return { job: view.job, result: view.job.state === "succeeded" && view.result != null ? (schema.parse(view.result) as z.infer<S>) : null };
}

function failed(v: { job: z.infer<typeof JobSummary> }): Error {
  const cls = v.job.errorClasses.map((e) => e.errorClass).join(", ") || v.job.state;
  return new Error(`The ${v.job.kind} job ${v.job.state} (${cls}). Only the error class comes back across the data boundary.`);
}

export function createBoundaryTools(k: KernelClient, deps: BoundaryDeps): ToolDefinition<any, any, any>[] {
  const fingerprint = async (sample: string, signal?: AbortSignal) => {
    const r = await k.post<{ fingerprint: unknown; job: unknown }>("/boundary/fingerprints", { sample }, signal);
    if (r.fingerprint) return Fingerprint.parse(r.fingerprint);
    const v = await awaitJob(k, r.job, Fingerprint, deps, signal);
    if (!v.result) throw failed(v);
    return v.result;
  };

  const getFingerprint = defineTool({
    name: "get_fingerprint",
    label: "Fingerprinting sample",
    pastLabel: "Fingerprinted the sample",
    description:
      "The structure of a real sample, computed in our worker with every value dropped: format and magic bytes, endianness, sections (offsets, lengths), header field names with dtypes, " +
      "array dtypes and shapes, table columns. DICOM follows the PS3.15 Annex E profile. Names that could identify someone come back as <redacted:N>. You never get the file itself.",
    promptSnippet: "Structure of a real sample (values dropped)",
    parameters: Type.Object({ sample: SAMPLE }),
    async execute(_id, args, signal) {
      const fp = await fingerprint(args.sample, signal);
      return out(fp, `${fp.format.kind} · ${fp.bytes} bytes · ${fp.fields.length} fields · ${fp.arrays.length} arrays`);
    },
  });

  const getFixtures = defineTool({
    name: "get_fixtures",
    label: "Making synthetic fixtures",
    pastLabel: "Made synthetic fixtures",
    description:
      `Synthetic files with the sample's structure (same format, shapes, dtypes; noise, a phantom, edge values; placeholder header values), made from the fingerprint alone. ` +
      `They are copied into the build sandbox under ${deps.sourceDir}/${FIXTURES_DIR}/ for your tests. Real samples never enter the sandbox: test there on these, then verify_on_sample.`,
    promptSnippet: "Synthetic fixtures of a sample, copied into the build sandbox",
    parameters: Type.Object({
      sample: SAMPLE,
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      generator: Type.Optional(Type.String({ description: "Fixture generator for a table (e.g. a plugin's; default profile-v1). You pick the generator; our worker picks the planted truth, which you never see." })),
    }),
    async execute(_id, args, signal) {
      try {
        await fingerprint(args.sample, signal);
      } catch (err) {
        if (!(err instanceof KernelError)) throw err;
      }
      const r = await k.post<{ job: unknown }>("/boundary/fixtures", { sample: args.sample, count: args.count ?? 3, ...(args.generator ? { generator: args.generator } : {}) }, signal);
      const v = await awaitJob(k, r.job, FixtureSet, deps, signal);
      if (!v.result) throw failed(v);
      const set = v.result;
      const copied: string[] = [];
      if (deps.acquire) {
        const sb = await deps.acquire();
        const dir = `${deps.sourceDir}/${FIXTURES_DIR}`;
        await withRecovery(sb, () => sb.fs.createFolder(dir, "755"));
        for (const f of set.fixtures) {
          const bytes = await k.request<ArrayBuffer>("GET", `/boundary/fixtures/${encodeURIComponent(set.fixtureSetId)}/${encodeURIComponent(f.name)}`, { signal, raw: true });
          const data = Buffer.from(bytes);
          // Only bytes the kernel listed for this synthetic set go in: checked by digest.
          if (`sha256:${createHash("sha256").update(data).digest("hex")}` !== f.sha256) throw new Error(`fixture ${f.name} doesn't match its listed digest; not copied`);
          await withRecovery(sb, () => sb.fs.uploadFile(data, `${dir}/${f.name}`));
          copied.push(`${dir}/${f.name}`);
        }
      }
      return out({ ...set, copiedTo: copied }, `${set.fixtures.length} synthetic fixture${set.fixtures.length === 1 ? "" : "s"}${copied.length ? ` in ${deps.sourceDir}/${FIXTURES_DIR}` : ""}`);
    },
  });

  const verify = defineTool({
    name: "verify_on_sample",
    label: "Verifying on the real sample",
    pastLabel: "Verified on the real sample",
    description:
      "Run your converter from the build sandbox on the real sample, in our worker (no network, read-only input). Returns a fixed-schema report only: pass/fail, the stage, the error class " +
      "(never the message), the file and line in YOUR source where it was raised, and each output's kind, dtype, shape, min/max/mean and NaN count. Fix and retry; use probe_sample when the layout is unclear.",
    promptSnippet: "Run the plugin's converter on the real sample (fixed-schema report)",
    parameters: Type.Object({
      sample: SAMPLE,
      entrypoint: Type.String({ pattern: "^[A-Za-z_][\\w.]*:[A-Za-z_]\\w*$", description: "module.path:function, called with the sample's file path; relative to the plugin dir (or its src/)." }),
    }),
    async execute(_id, args, signal) {
      if (!deps.acquire || !deps.pack) throw new Error("verify_on_sample needs the build sandbox (create_plugin_sandbox first)");
      const source = await deps.pack(await deps.acquire());
      const r = await k.request<{ job: unknown }>("POST", `/boundary/verify?${new URLSearchParams({ sample: args.sample, entrypoint: args.entrypoint })}`, { body: source, contentType: "application/gzip", signal });
      const v = await awaitJob(k, r.job, VerifyReport, deps, signal);
      if (!v.result) throw failed(v);
      const rep = v.result;
      const where = rep.errorFile ? ` at ${rep.errorFile}:${rep.errorLine}` : "";
      return out(rep, rep.pass ? `Passed · ${rep.outputs.map((o) => `${o.name} ${o.dtype}[${o.shape.join("×")}]`).join(", ")}` : `Failed in ${rep.stage}: ${rep.errorClass}${where}`);
    },
  });

  const probe = defineTool({
    name: "probe_sample",
    label: "Probing the real sample",
    pastLabel: "Probed the real sample",
    description:
      "Ask small typed questions of the real sample when its layout is unknown: magic {offset, hex}; read_int {offset, width 1|2|4|8, signed, endian}; read_float {offset, width 4|8, endian}; " +
      "find {hex ≤8 bytes, start?, limit?} → offsets; read_text {offset, length ≤32} (free text comes back as <redacted:N>); field_names; section_sizes; size. Budgeted per sample and audited: plan your probes.",
    promptSnippet: "Typed probes on the real sample (budgeted)",
    parameters: Type.Object({ sample: SAMPLE, probes: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1, maxItems: 32 }) }),
    async execute(_id, args, signal) {
      const probes = args.probes.map((p: unknown) => ProbeSchema.parse(p));
      const r = await k.post<{ job: unknown }>("/boundary/probes", { sample: args.sample, probes }, signal);
      const v = await awaitJob(k, r.job, ProbeResult, deps, signal);
      if (!v.result) throw failed(v);
      return out(v.result, `${v.result.answers.length} answer${v.result.answers.length === 1 ? "" : "s"} · ${v.result.budget.remaining} probes left`);
    },
  });

  return [getFingerprint, getFixtures, verify, probe];
}

/** `build_plugin_artifact`: our worker rebuilds the sandbox's *source*; the sandbox's own package is only compared. */
export function createBuildTool(k: KernelClient, deps: Required<Pick<BoundaryDeps, "acquire" | "pack">> & Pick<BoundaryDeps, "pollMs" | "timeoutS" | "sleep">): ToolDefinition<any, any, any> {
  return defineTool({
    name: "build_plugin_artifact",
    label: "Building plugin artifact",
    pastLabel: "Built the plugin artifact",
    description:
      "Send the sandbox plugin's source to our worker, which rebuilds it with a pinned toolchain (source files only; anything built in the sandbox is dropped), hashes it, signs it with the platform key " +
      "and registers it as a `generated` plugin visible only in this workspace. The digest it returns is the one that gets installed. It doesn't install anything: then plan_plugin_change → stage_plugin → request_install_approval.",
    promptSnippet: "Rebuild, sign and register the sandbox plugin (inside our boundary)",
    parameters: Type.Object({}),
    async execute(_id, _args, signal) {
      const source = await deps.pack(await deps.acquire());
      const sandboxDigest = filesDigest(readTarGz(source));
      const r = await k.request<{ job: unknown }>("POST", `/boundary/builds?sandboxDigest=${encodeURIComponent(sandboxDigest)}`, { body: source, contentType: "application/gzip", signal });
      const v = await awaitJob(k, r.job, BuildResult, deps, signal);
      if (!v.result) throw failed(v);
      const b = v.result;
      if (!b.pass) throw new Error(`The build was refused:\n- ${b.errors.join("\n- ") || "no details"}`);
      return out(b, `${b.pluginId}@${b.version}${b.duplicate ? " (unchanged)" : ""} · ${b.artifactDigest?.slice(0, 19)}…`);
    },
  });
}
