import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, withPrefix } from "../../src/config.ts";
import { SANDBOX_HOME } from "../../src/sandbox/defaults.ts";
import { FakeProvider, type FakeSandboxHandle, shellWords } from "../../src/sandbox/fake.ts";
import { GkeSandboxProvider, type K8sClient, execExitCode } from "../../src/sandbox/gke.ts";
import { LocalContainerProvider, runArgs } from "../../src/sandbox/local.ts";
import { SandboxManager } from "../../src/sandbox/manager.ts";
import { createProvider } from "../../src/sandbox/providers.ts";
import { filesDigest, readTarGz, writeTarGz } from "../../src/sandbox/tar.ts";
import { createBoundaryTools } from "../../src/tools/boundary.ts";
import { KernelClient, PLUGIN_DIR, packTarball } from "../../src/tools/kernel.ts";

const cfg = (vars: Record<string, string> = {}) => loadConfig(withPrefix({ ENV: "test", AGENT_SANDBOX: "fake", ...vars })).config;
const owner = { sessionId: "s1", projectId: "p", owner: "me", profile: "builder", labels: { purpose: "plugin-build" } };

describe("sandbox providers (todo10 Phase 7.8): switching is a config change", () => {
  it("each AGENT_SANDBOX value builds its provider; fake is refused in production", () => {
    expect(createProvider(cfg())?.kind).toBe("fake");
    expect(createProvider(cfg({ AGENT_SANDBOX: "local", AGENT_SANDBOX_LOCAL_IMAGE: "img@sha256:00" }))?.kind).toBe("local");
    const fakeK8s: K8sClient = { get: async () => undefined, create: async () => ({}), delete: async () => {}, exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(0) }) };
    expect(createProvider(cfg({ AGENT_SANDBOX: "gke" }), { k8s: fakeK8s })?.kind).toBe("gke");
    expect(createProvider(cfg({ AGENT_SANDBOX: "daytona", DAYTONA_API_KEY: "k" }))?.kind).toBe("daytona");
    expect(createProvider(cfg({ AGENT_SANDBOX: "off" }))).toBeUndefined();
    expect(() => loadConfig(withPrefix({ ENV: "production", AGENT_TOKEN: "t", OPENAI_API_KEY: "k", AGENT_SANDBOX: "fake" }))).toThrow(/development and tests only/);
  });

  it("the fake records what entered it; created with no network and no env from us", async () => {
    const p = new FakeProvider();
    const m = new SandboxManager(p, cfg());
    const sb = (await m.acquire(owner)) as unknown as FakeSandboxHandle;
    expect(sb.network.blockAll).toBe(true);
    expect(sb.env).toEqual({ PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg" });
    await sb.fs.uploadFile(Buffer.from("id: x\n"), `${PLUGIN_DIR}/plugin.yaml`);
    await sb.fs.uploadFile(Buffer.from("synthetic"), `${PLUGIN_DIR}/fixtures/fixture-00-noise.bin`);
    const tgz = await packTarball(sb as never, 10);
    // Fixtures stay in the sandbox: they're not source.
    expect([...readTarGz(tgz).keys()]).toEqual(["plugin.yaml"]);
    expect(shellWords("test -f 'a b' && echo 'it'\\''s'")).toEqual(["test", "-f", "a b", "&&", "echo", "it's"]);
  });

  it("local containers: no network, gVisor, read-only root, nothing from the host's env", async () => {
    const argv = runArgs({ image: "img@sha256:00", runtime: "runsc" }, "n", { app: "x" });
    expect(argv.join(" ")).toMatch(/--network none/);
    expect(argv).toEqual(expect.arrayContaining(["--runtime", "runsc", "--read-only", "--cap-drop", "ALL", "no-new-privileges"]));
    expect(argv.some((a) => a === "-e" || a.startsWith("--env"))).toBe(false);
    const calls: string[][] = [];
    const run = async (a: string[], o?: { stdin?: Buffer }) => {
      calls.push(a);
      if (a[1] === "inspect") return { exitCode: 0, stdout: Buffer.from(a.includes("{{.State.Status}}") ? "running" : "{}") };
      if (a.includes("cat") && a.length === 6) return { exitCode: 0, stdout: Buffer.from("hello") };
      return { exitCode: 0, stdout: o?.stdin ?? Buffer.alloc(0) };
    };
    const p = new LocalContainerProvider({ image: "img@sha256:00", runtime: "runsc", run });
    const sb = await p.create({ name: "n", labels: {} });
    await sb.fs.uploadFile(Buffer.from("x"), `${SANDBOX_HOME}/plugin/a.py`);
    expect(calls.at(-1)!.slice(0, 4)).toEqual(["docker", "exec", "-i", "n"]);
    expect(String(await sb.fs.downloadFile(`${SANDBOX_HOME}/plugin/a.py`))).toBe("hello");
  });

  it("gke: a SandboxClaim from the template, pods/exec only, paths mapped to /workspace", async () => {
    const created: any[] = [];
    const execs: { pod: string; argv: string[] }[] = [];
    let ready = false;
    const k8s: K8sClient = {
      get: async (path) => {
        if (path.includes("/sandboxclaims/")) return created.length ? { metadata: { labels: {} }, status: ready ? { sandbox: { Name: "warm-1" } } : {} } : undefined;
        if (path.endsWith("/pods/warm-1")) return { status: { phase: "Running" } };
        return { status: { phase: "Pending" } };
      },
      create: async (_p, body) => {
        created.push(body);
        ready = true;
        return body;
      },
      delete: async () => {
        created.length = 0;
      },
      exec: async (_ns, pod, _c, argv) => {
        execs.push({ pod, argv });
        return { exitCode: 0, stdout: Buffer.from("") };
      },
    };
    const p = new GkeSandboxProvider({ namespace: "sandboxes", template: "plugin-build", client: k8s, sleep: async () => {} });
    const m = new SandboxManager(p, cfg({ AGENT_SANDBOX: "gke" }));
    const sb = await m.acquire(owner);
    expect(created[0]).toMatchObject({ kind: "SandboxClaim", spec: { sandboxTemplateRef: { name: "plugin-build" } } });
    expect(JSON.stringify(created[0])).not.toMatch(/envVars|secret|networkBlock|domainAllow/i);
    await sb.fs.uploadFile(Buffer.from("x"), `${PLUGIN_DIR}/plugin.yaml`);
    const up = execs.at(-1)!;
    expect(up.pod).toBe("warm-1");
    expect(up.argv.join(" ")).toContain("/workspace/plugin/plugin.yaml");
    expect(up.argv.join(" ")).not.toContain(SANDBOX_HOME);
    expect(execExitCode({ status: "Success" })).toBe(0);
    expect(execExitCode({ status: "Failure", details: { causes: [{ reason: "ExitCode", message: "3" }] } })).toBe(3);
  });

  it("tar round-trips and digests like the kernel", () => {
    const files = new Map([["plugin.yaml", Buffer.from("a")], ["src/x.py", Buffer.from("b")], ["__pycache__/x.pyc", Buffer.from("c")]]);
    const back = readTarGz(writeTarGz(files));
    expect([...back.keys()].sort()).toEqual(["__pycache__/x.pyc", "plugin.yaml", "src/x.py"]);
    expect(filesDigest(back)).toBe(filesDigest(new Map([["plugin.yaml", Buffer.from("a")], ["src/x.py", Buffer.from("b")]])));
    expect(writeTarGz(files).equals(writeTarGz(files))).toBe(true);
  });
});

// ---- boundary tools against a scripted kernel ---------------------------------------------------

let server: Server | undefined;
afterEach(() => server?.close());

const summary = (state: string, kind = "fingerprint") => ({ schema: "boundary.job-summary/v1", jobId: "j1", kind, state, progress: state === "succeeded" ? 1 : 0, counts: { total: "<20", succeeded: state === "succeeded" ? "<20" : 0, failed: 0 }, errorClasses: [], createdAt: "2026-10-31T00:00:00+00:00", updatedAt: null });
const D = `sha256:${"0".repeat(64)}`;

async function kernel(routes: (path: string, body: string) => unknown) {
  const read = (req: IncomingMessage) => new Promise<string>((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
  server = createServer(async (req, res) => {
    const out = routes(req.url ?? "", await read(req));
    if (Buffer.isBuffer(out)) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(out);
    }
    res.writeHead(out === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out ?? { detail: "no route" }));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return new KernelClient({ baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, workspaceId: "demo", token: () => "t" });
}

describe("boundary tools", () => {
  it("results outside the contract fail the tool instead of reaching the model", async () => {
    const k = await kernel((path) => (path.startsWith("/api/v1/boundary/fingerprints") ? { fingerprint: { schema: "boundary.fingerprint/v1", note: "Patient Jane Doe" }, job: null } : undefined));
    const [fp] = createBoundaryTools(k, { sourceDir: PLUGIN_DIR });
    await expect(fp!.execute("c", { sample: "a.dcm" }, undefined, undefined, {} as never)).rejects.toThrow();
  });

  it("get_fixtures polls the job and copies only digest-checked synthetic files into the sandbox", async () => {
    const data = Buffer.from("synthetic fixture");
    const { createHash } = await import("node:crypto");
    const sha = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const p = new FakeProvider();
    const sb = (await p.create({ name: "x", networkBlockAll: true })) as unknown as FakeSandboxHandle;
    const fp = { schema: "boundary.fingerprint/v1", sampleId: "a1", sampleDigest: D, bytes: 1, format: { kind: "binary", magic: null, magicOffset: 0 }, endianness: "unknown", sections: [], fields: [], arrays: [], table: null, dicom: null, scrub: { profile: "generic-structure-v1", valuesDropped: 0, namesRedacted: 0, textCheck: "dev-vocab-v1" } };
    const set = { schema: "boundary.fixtures/v1", fixtureSetId: "fs1", sampleId: "a1", fingerprintDigest: D, generator: "synthetic-v1", seed: 1, fixtures: [{ name: "fixture-00-noise.bin", bytes: data.length, sha256: sha, mediaType: "application/octet-stream", variant: "noise" }] };
    const k2 = await kernel((path) => {
      if (path.startsWith("/api/v1/boundary/fingerprints")) return { fingerprint: fp, job: null };
      if (path.startsWith("/api/v1/boundary/jobs/j1")) return { job: summary("succeeded", "synthesize_fixtures"), result: set };
      if (path === "/api/v1/boundary/fixtures") return { job: summary("queued", "synthesize_fixtures") };
      if (path.startsWith("/api/v1/boundary/fixtures/fs1/")) return data;
    });
    const tools2 = createBoundaryTools(k2, { acquire: async () => sb as never, sourceDir: PLUGIN_DIR, pollMs: 1, sleep: async () => {} });
    const r = await tools2.find((t) => t.name === "get_fixtures")!.execute("c", { sample: "a1" }, undefined, undefined, {} as never);
    expect(JSON.parse((r.content[0] as { text: string }).text).copiedTo).toEqual([`${PLUGIN_DIR}/fixtures/fixture-00-noise.bin`]);
    expect(sb.files.get(`${PLUGIN_DIR}/fixtures/fixture-00-noise.bin`)?.toString()).toBe("synthetic fixture");
  });
});
