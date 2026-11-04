// todo23 W10: `run_harness` (local mode: tools/harness/harness.mjs on this machine) and
// `get_job_status`. A harness run takes minutes, so it starts detached and returns a job id; the
// job's state lives in a temp-dir file (this is a local stdio tool, nothing is kept in memory).
// Daytona mode (the agent service's POST /v1/harness/runs) is a TODO: it lands with W5's sandbox.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NAMING } from "./config.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HARNESS = path.join(REPO, "tools/harness/harness.mjs");

type Result = { ok: boolean; data: unknown };

export interface Job {
  id: string;
  kind: "harness";
  status: "running" | "done" | "failed";
  pid?: number;
  startedAt: string;
  report?: unknown;
  error?: string;
}

export const jobsDir = (root = os.tmpdir()) => path.join(root, `${NAMING.resourcePrefix}-mcp-jobs`);
const JOB_ID = /^[0-9a-f-]{36}$/;

const alive = (pid: number | undefined) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function runHarness(args: Record<string, any>, dir = jobsDir()): Result {
  if (args.mode === "daytona") return { ok: false, data: { error: "Daytona mode isn't wired yet (todo23 W5): use mode \"local\"" } };
  if (!fs.existsSync(HARNESS)) return { ok: false, data: { error: "tools/harness/harness.mjs isn't in this checkout" } };
  if (!args.env && !args.envFile) return { ok: false, data: { error: "pass `env` (a spec) or `envFile` (a path)" } };
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const envFile = args.envFile ? path.resolve(String(args.envFile)) : path.join(dir, `${id}.env.json`);
  if (!args.envFile) fs.writeFileSync(envFile, JSON.stringify(args.env));
  const argv = [HARNESS, "--env", envFile, "--report", path.join(dir, `${id}.report.json`)];
  for (const [flag, key] of [["--plugins", "plugins"], ["--fixtures", "fixtures"], ["--hidden-tests", "hiddenTests"]] as const) if (args[key]) argv.push(flag, path.resolve(String(args[key])));
  const log = fs.openSync(path.join(dir, `${id}.log`), "w");
  const child = spawn(process.execPath, argv, { cwd: REPO, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const job: Job = { id, kind: "harness", status: "running", pid: child.pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(job));
  return { ok: true, data: { jobId: id, status: "running", poll: "get_job_status" } };
}

export function jobStatus(id: string, dir = jobsDir()): Result {
  if (!JOB_ID.test(id) || !fs.existsSync(path.join(dir, `${id}.json`))) return { ok: false, data: { error: `Unknown job "${id}"` } };
  const job = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf8")) as Job;
  const reportFile = path.join(dir, `${id}.report.json`);
  if (fs.existsSync(reportFile)) {
    try {
      return { ok: true, data: { ...job, pid: undefined, status: "done", report: JSON.parse(fs.readFileSync(reportFile, "utf8")) } };
    } catch {
      // being written
    }
  }
  if (alive(job.pid)) return { ok: true, data: { ...job, pid: undefined } };
  const log = fs.existsSync(path.join(dir, `${id}.log`)) ? fs.readFileSync(path.join(dir, `${id}.log`), "utf8").slice(-2000) : "";
  return { ok: true, data: { ...job, pid: undefined, status: "failed", error: `the harness exited without a report: ${log}` } };
}
