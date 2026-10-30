import type { Sandbox } from "@daytona/sdk";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxUnavailableError } from "../../src/sandbox/client.ts";
import { SANDBOX_CWD, SANDBOX_LOG_DIR } from "../../src/sandbox/defaults.ts";
import { ExecAbortedError, execCommand, streamCommand, withRecovery } from "../../src/sandbox/exec.ts";
import { SandboxManager } from "../../src/sandbox/manager.ts";
import { createSandboxTools } from "../../src/tools/sandbox.ts";
import { LIVE_LABELS, assertNoLeftovers, config, daytona, live, runId } from "./setup.ts";
import { NAMING } from "../../src/naming.ts";

const RES = NAMING.resourcePrefix;

const sessionId = runId();
const owner = { sessionId, projectId: "live-test", owner: "ci", profile: "coder", labels: LIVE_LABELS };
const events: string[] = [];

let manager: SandboxManager;
let sandbox: Sandbox;
let tools: Map<string, ToolDefinition<any, any, any>>;

const hostCtx = { cwd: "/definitely/not/in/the/sandbox" } as any;
async function call(name: string, params: Record<string, unknown>, onUpdate?: (r: any) => void) {
  const res = await tools.get(name)!.execute(`call-${name}-${Date.now()}`, params, undefined, onUpdate, hostCtx);
  return res.content.map((c: any) => c.text ?? "").join("");
}

describe.skipIf(!live)("Daytona live", () => {
  beforeAll(async () => {
    await assertNoLeftovers(daytona!, config);
    manager = new SandboxManager(daytona!, config, { warn: (m) => console.warn(m) });
    sandbox = await manager.acquire({ ...owner, onEvent: (e) => events.push(e.state) });
    tools = new Map(
      createSandboxTools({
        acquire: () => manager.acquire(owner),
        onUnavailable: () => manager.forget(sessionId),
        execTimeoutS: 60,
        outputMax: 64 * 1024,
        artifactsDir: `${import.meta.dirname}/../../.data/artifacts/${sessionId}`,
      }).map((t) => [t.name, t]),
    );
  }, 180_000);

  afterAll(async () => {
    if (!manager) return;
    await manager.release(sessionId, "delete").catch((e) => console.error("cleanup failed", e));
  }, 120_000);

  it("creates with labels, lifecycle and started state", async () => {
    expect(events).toEqual(["creating", "ready"]);
    expect(sandbox.state).toBe("started");
    expect(sandbox.labels).toMatchObject({ app: RES, env: config.env, session: sessionId, test: "live" });
    expect(sandbox.name).toBe(`${RES}-${config.env}-${sessionId}`);
    expect(sandbox.public).toBe(false);
  });

  it("bash echo and exit-code propagation", async () => {
    expect(await call("bash", { command: "echo hello-$((40+2)) && pwd" })).toContain(`hello-42\n${SANDBOX_CWD}`);
    const failed = await call("bash", { command: "echo before; exit 3" });
    expect(failed).toContain("before");
    expect(failed).toMatch(/exited with code 3/);
  });

  it("the sandbox environment holds no host credentials", async () => {
    const env = await call("bash", { command: "env" });
    expect(env).toContain(`${NAMING.envPrefix}SESSION=`);
    // Daytona injects its own sandbox metadata (DAYTONA_SANDBOX_ID, _REGION_ID, …); host credentials never get in.
    expect(env).not.toMatch(/^(DAYTONA_API_KEY|DAYTONA_API_URL|DAYTONA_TARGET|\w*AGENT_TOKEN|OPENAI_\w*|ANTHROPIC_\w*)=/m);
    for (const v of [config.daytona?.apiKey, ...Object.values(config.providerKeys)]) if (v) expect(env).not.toContain(v);
  });

  it("background-safe exec returns while a child keeps running", async () => {
    const t0 = Date.now();
    const res = await execCommand(sandbox, "sleep 30 & echo started");
    expect(res.output.trim()).toBe("started");
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it("streamed bash with a background child returns", async () => {
    const t0 = Date.now();
    const out = await call("bash", { command: "nohup sleep 30 >/dev/null 2>&1 & echo bg-ok" });
    expect(out).toContain("bg-ok");
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("streams output in chunks", async () => {
    const chunks: string[] = [];
    const { exitCode } = await streamCommand(sandbox, "for i in 1 2 3; do echo tick-$i; sleep 1; done", {
      onData: (c) => chunks.push(c),
    });
    expect(exitCode).toBe(0);
    expect(chunks.join("")).toMatch(/tick-1\s+tick-2\s+tick-3/);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("timeout kills a long command", async () => {
    const t0 = Date.now();
    await expect(streamCommand(sandbox, "sleep 999", { timeoutS: 3, onData: () => {} })).rejects.toBeInstanceOf(ExecAbortedError);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);

  it("abort kills the command", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    const p = streamCommand(sandbox, "echo go; sleep 999", { signal: ac.signal, onData: () => {} });
    await expect(p).rejects.toMatchObject({ reason: "aborted" });
    const ps = await execCommand(sandbox, "pgrep -f 'sleep 999' || true", { backgroundSafe: false });
    expect(ps.output.trim()).toBe("");
  }, 30_000);

  it("abort finds and kills children that ignore SIGTERM, without quarantining", async () => {
    const uncertain: string[] = [];
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 2000);
    const p = streamCommand(sandbox, "(trap '' TERM HUP; sleep 997) & (trap '' TERM HUP; sleep 998); echo never", {
      signal: ac.signal,
      onData: () => {},
      onUncertain: (d) => uncertain.push(d),
    });
    await expect(p).rejects.toMatchObject({ reason: "aborted" });
    const ps = await execCommand(sandbox, "pgrep -f 'sleep 99[78]' || true", { backgroundSafe: false });
    expect(ps.output.trim()).toBe("");
    expect(uncertain).toEqual([]);
  }, 30_000);

  it("long bash output keeps head and tail; the full log stays in the sandbox", async () => {
    const out = await call("bash", { command: "seq 1 40000" });
    expect(out.startsWith("1\n2\n")).toBe(true);
    expect(out).toContain("40000");
    expect(out).toMatch(/bytes omitted/);
    const log = /Full log in the sandbox: (\S+)\]/.exec(out)?.[1];
    expect(log?.startsWith(`${SANDBOX_LOG_DIR}/`)).toBe(true);
    const wc = await execCommand(sandbox, `wc -l < ${log}`, { backgroundSafe: false });
    expect(wc.output.trim()).toBe("40000");
  }, 60_000);

  it("write → read → edit → read, ls, find, grep", async () => {
    await call("write", { path: "pkg/hello.py", content: `print('${RES}-ok')\n# marker-abc\n` });
    expect(await call("read", { path: "pkg/hello.py" })).toContain(`${RES}-ok`);
    await call("edit", { path: "pkg/hello.py", edits: [{ oldText: `${RES}-ok`, newText: `${RES}-edited` }] });
    expect(await call("read", { path: `${SANDBOX_CWD}/pkg/hello.py` })).toContain(`${RES}-edited`);
    expect(await call("ls", { path: "pkg" })).toContain("hello.py");
    expect(await call("find", { pattern: "*.py" })).toContain("pkg/hello.py");
    expect(await call("grep", { pattern: "marker-abc" })).toMatch(/hello\.py:2:.*marker-abc/);
    expect(await call("grep", { pattern: "nope-not-here" })).toMatch(/No matches/);
    expect(await call("bash", { command: "python3 pkg/hello.py" })).toContain(`${RES}-edited`);
  }, 60_000);

  it("run_python keeps state across calls and reports errors", async () => {
    const updates: string[] = [];
    expect(await call("run_python", { code: "import math\nx = 6 * 7\nprint('x =', x)" }, (u) => updates.push(u.content[0].text))).toContain("x = 42");
    expect(await call("run_python", { code: "print(math.sqrt(x * x))" })).toContain("42.0");
    expect(updates.length).toBeGreaterThan(0);
    await expect(call("run_python", { code: "1/0" })).rejects.toThrow(/ZeroDivisionError/);
  }, 120_000);

  it("signed preview URL serves one port", async () => {
    await execCommand(sandbox, `cd ${SANDBOX_CWD} && echo preview-ok > index.html && nohup python3 -m http.server 8765 >/dev/null 2>&1 &`);
    await new Promise((r) => setTimeout(r, 1500));
    const out = await call("preview_url", { port: 8765, expires_s: 300 });
    const url = /https?:\/\/\S+/.exec(out)?.[0];
    expect(url).toBeTruthy();
    let body = "";
    for (let i = 0; i < 10 && !body.includes("preview-ok"); i++) {
      body = await fetch(url!).then((r) => r.text(), () => "");
      if (!body.includes("preview-ok")) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(body).toContain("preview-ok");
  }, 60_000);

  it("export_artifact copies a sandbox file to the host", async () => {
    await execCommand(sandbox, "mkdir -p /home/daytona/out && printf 'a,b\\n1,2\\n' > /home/daytona/out/t.csv");
    expect(await call("export_artifact", { path: "/home/daytona/out/t.csv" })).toMatch(/Exported t\.csv \(8 bytes/);
  });

  it("recovers a stopped sandbox, then reattaches by name", async () => {
    await sandbox.stop(60);
    await sandbox.refreshData();
    expect(sandbox.state).toBe("stopped");
    const res = await withRecovery(sandbox, () => sandbox.process.executeCommand("echo back"));
    expect(res.result.trim()).toBe("back");

    const fresh = new SandboxManager(daytona!, config);
    const seen: string[] = [];
    const again = await fresh.acquire({ ...owner, onEvent: (e) => seen.push(e.state) });
    expect(again.id).toBe(sandbox.id);
    expect(seen).toEqual(["ready"]);
  }, 180_000);

  it("a deleted sandbox surfaces SandboxUnavailableError (never the host)", async () => {
    const victim = await daytona!.create({ labels: { app: RES, env: config.env, test: "live", session: `${sessionId}-victim` }, autoDeleteInterval: 30 }, { timeout: 120 });
    await victim.delete(60, true);
    await expect(withRecovery(victim, () => victim.process.executeCommand("echo hi"))).rejects.toBeInstanceOf(SandboxUnavailableError);
  }, 180_000);
});
