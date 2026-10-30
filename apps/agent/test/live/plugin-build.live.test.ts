import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Sandbox } from "@daytona/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NAMING, ns } from "../../src/naming.ts";
import { PACKAGE_INDEX_HOSTS } from "../../src/sandbox/defaults.ts";
import { execCommand } from "../../src/sandbox/exec.ts";
import { SandboxManager } from "../../src/sandbox/manager.ts";
import { KERNEL_SCOPES, KernelClient, PLUGIN_DIR, createBuilderTools, createPluginSandboxTools } from "../../src/tools/kernel.ts";
import { LIVE_LABELS, assertNoLeftovers, config, daytona, live, runId } from "./setup.ts";

/**
 * Phase 9 end to end on real Daytona and a real kernel (apps/api on a temp SQLite): scaffold in a
 * plugin-build sandbox → run_plugin_checks → build_plugin_artifact → plan → stage, which leaves the
 * request waiting for the user's approval. One labelled sandbox, always deleted.
 */
const sessionId = runId();
const owner = { sessionId, projectId: "live-test", owner: "ci", profile: "builder", labels: { ...LIVE_LABELS, purpose: "plugin-build" }, egressAllow: PACKAGE_INDEX_HOSTS };
const API_DIR = resolve(import.meta.dirname, "../../../api");

let manager: SandboxManager;
let sandbox: Sandbox;
let kernelProc: ChildProcess;
let kernelUrl: string;
let dataDir: string;

const freePort = () =>
  new Promise<number>((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });

describe.skipIf(!live)("plugin build (Daytona + kernel, live)", () => {
  beforeAll(async () => {
    await assertNoLeftovers(daytona!, config);
    dataDir = mkdtempSync(join(tmpdir(), "plugin-build-live-"));
    const port = await freePort();
    kernelUrl = `http://127.0.0.1:${port}`;
    kernelProc = spawn("uv", ["run", "uvicorn", "studio_api.app:app", "--port", String(port)], {
      cwd: API_DIR,
      env: { ...process.env, [`${NAMING.envPrefix}API_DATA_DIR`]: dataDir, [`${NAMING.envPrefix}API_DATABASE_URL`]: `sqlite:///${dataDir}/api.db` },
      stdio: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      if (await fetch(`${kernelUrl}/api/v1/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    manager = new SandboxManager(daytona!, config, { warn: (m) => console.warn(m) });
    sandbox = await manager.acquire(owner);
  }, 240_000);

  afterAll(async () => {
    await manager?.release(sessionId, "delete").catch((e) => console.error("cleanup failed", e));
    kernelProc?.kill();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it("scaffolds, checks, builds and stages a generated plugin; approval stays with the user", async () => {
    expect(sandbox.labels).toMatchObject({ purpose: "plugin-build", profile: "builder" });
    const mint = await fetch(`${kernelUrl}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Workspace-Id": "live-test" },
      body: JSON.stringify({ agent: "builder", profile: "builder", scopes: KERNEL_SCOPES.builder }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    const kernel = new KernelClient({ baseUrl: kernelUrl, workspaceId: "live-test", token: () => mint.token });
    const byName = new Map([...createPluginSandboxTools(kernel, { acquire: () => manager.acquire(owner), execTimeoutS: 120 }), ...createBuilderTools(kernel)].map((t) => [t.name, t]));
    const call = async (name: string, args: object) => JSON.parse(((await byName.get(name)!.execute(`c-${name}`, args, undefined, undefined, {} as never)).content[0] as { text: string }).text);

    const created = await call("create_plugin_sandbox", { slug: "live-counter", name: "Live counter" });
    expect(created.pluginId).toBe(ns("generated.live-counter"));
    const listed = await execCommand(sandbox, `cd ${PLUGIN_DIR} && find . -type f | sort`);
    expect(listed.output).toContain("./plugin.yaml");
    expect(listed.output).toContain("./ui/contributions.json");

    const checks = await call("run_plugin_checks", {});
    expect(checks.kernel.errors).toEqual([]);
    expect(checks).toMatchObject({ ok: true, sandbox: { dependencies: "none" } });

    const built = await call("build_plugin_artifact", {});
    expect(built).toMatchObject({ ok: true, registered: true, pluginId: created.pluginId });

    const plan = await call("plan_plugin_change", { pluginId: created.pluginId });
    expect(plan).toMatchObject({ state: "RESOLVED", risk: "high", install: [{ trustTier: "generated", codeDiff: { base: "template" } }] });
    const staged = await call("stage_plugin", { requestId: plan.requestId });
    expect(staged.state).toBe("AWAITING_APPROVAL");
    // The builder token can't approve: that's the user's call in the install review.
    const approve = await fetch(`${kernelUrl}/api/v1/workspaces/live-test/plugins/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${mint.token}`, "X-Workspace-Id": "live-test" },
      body: JSON.stringify({ requestId: plan.requestId }),
    });
    expect(approve.status).toBe(403);
  }, 300_000);
});
