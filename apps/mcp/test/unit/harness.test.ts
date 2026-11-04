import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { jobStatus, runHarness } from "../../src/harness.ts";
import { staticTools } from "../../src/server.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcp-jobs-test-"));

test("harness tools are offered over stdio only", () => {
  const names = (remote: boolean) => staticTools({ remote }).map((t) => t.name);
  assert.ok(names(false).includes("run_harness") && names(false).includes("get_job_status"));
  assert.ok(!names(true).includes("run_harness"));
});

test("run_harness refuses daytona and a missing env without starting anything", () => {
  const dir = tmp();
  assert.equal(runHarness({ mode: "daytona", env: {} }, dir).ok, false);
  assert.equal(runHarness({}, dir).ok, false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("get_job_status reads the job file: running, done with the report, failed without one", () => {
  const dir = tmp();
  const id = "00000000-0000-4000-8000-000000000001";
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, kind: "harness", status: "running", pid: process.pid, startedAt: "now" }));
  assert.equal((jobStatus(id, dir).data as any).status, "running");
  fs.writeFileSync(path.join(dir, `${id}.report.json`), JSON.stringify({ version: 1, passed: true, steps: [] }));
  const done = jobStatus(id, dir).data as any;
  assert.equal(done.status, "done");
  assert.equal(done.report.passed, true);
  const dead = "00000000-0000-4000-8000-000000000002";
  fs.writeFileSync(path.join(dir, `${dead}.json`), JSON.stringify({ id: dead, kind: "harness", status: "running", pid: 2 ** 22 + 7, startedAt: "now" }));
  assert.equal((jobStatus(dead, dir).data as any).status, "failed");
  assert.equal(jobStatus("../etc", dir).ok, false);
});
