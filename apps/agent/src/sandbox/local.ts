import { spawn } from "node:child_process";
import type { CreateSandboxFromSnapshotParams, Sandbox } from "@daytona/sdk";
import { SANDBOX_HOME } from "./defaults.ts";
import { type Exec, ExecSandboxHandle } from "./exec-handle.ts";
import type { SandboxProvider } from "./provider.ts";

/**
 * `AGENT_SANDBOX=local`: one container per sandbox on this host, for installations that won't
 * send even synthetic data to Daytona (todo10 §6.2). Always `--network none`, gVisor (`runsc`)
 * unless `AGENT_SANDBOX_LOCAL_RUNTIME` says otherwise, read-only root with tmpfs for the work
 * tree, every capability dropped, no new privileges, a pids/memory/cpu cap, no env from the host.
 * The image is the pinned build toolchain (`AGENT_SANDBOX_LOCAL_IMAGE`, by digest in production).
 */

export type Run = (argv: string[], opts?: { stdin?: Buffer; timeoutS?: number }) => Promise<{ exitCode: number; stdout: Buffer }>;

export const runProcess: Run = (argv, opts = {}) =>
  new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const chunks: Buffer[] = [];
    const timer = opts.timeoutS ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutS * 1000) : undefined;
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 137, stdout: Buffer.concat(chunks) });
    });
    child.stdin.end(opts.stdin ?? Buffer.alloc(0));
  });

export interface LocalOptions {
  image: string;
  runtime: string;
  /** `docker` or `podman`. */
  cli?: string;
  run?: Run;
}

/** The `docker run` argv for a sandbox: the security posture lives here, in one place. */
export function runArgs(o: LocalOptions, name: string, labels: Record<string, string>): string[] {
  return [
    "run", "-d", "--name", name,
    "--network", "none",
    ...(o.runtime ? ["--runtime", o.runtime] : []),
    "--read-only",
    "--tmpfs", `${SANDBOX_HOME}:rw,exec,size=4g,uid=1000,gid=1000`,
    "--tmpfs", "/tmp:rw,size=1g",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--memory", "4g",
    "--cpus", "2",
    "--user", "1000:1000",
    "--workdir", SANDBOX_HOME,
    ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    o.image,
    "sleep", "infinity",
  ];
}

export class LocalContainerProvider implements SandboxProvider {
  readonly kind = "local" as const;
  private readonly cli: string;
  private readonly run: Run;
  constructor(private readonly o: LocalOptions) {
    this.cli = o.cli ?? "docker";
    this.run = o.run ?? runProcess;
  }

  canBlockNetwork(): boolean {
    return true;
  }

  private handle(name: string, labels: Record<string, string>): Sandbox {
    const exec: Exec = (argv, opts) => this.run([this.cli, "exec", "-i", name, ...argv], opts);
    return new ExecSandboxHandle(name, name, labels, exec, {
      refresh: async () => {
        const r = await this.run([this.cli, "inspect", "-f", "{{.State.Status}}", name]);
        if (r.exitCode !== 0) return "destroyed";
        const s = r.stdout.toString().trim();
        return s === "running" ? "started" : s === "exited" || s === "created" ? "stopped" : s;
      },
      start: async () => void (await this.run([this.cli, "start", name])),
      stop: async () => void (await this.run([this.cli, "stop", "-t", "5", name])),
      delete: async () => void (await this.run([this.cli, "rm", "-f", name])),
    }) as unknown as Sandbox;
  }

  async get(idOrName: string): Promise<Sandbox | undefined> {
    const r = await this.run([this.cli, "inspect", "-f", "{{json .Config.Labels}}", idOrName]);
    if (r.exitCode !== 0) return undefined;
    let labels: Record<string, string> = {};
    try {
      labels = JSON.parse(r.stdout.toString()) ?? {};
    } catch {}
    const sb = this.handle(idOrName, labels);
    await sb.refreshData();
    return sb.state === "destroyed" ? undefined : sb;
  }

  async create(params: CreateSandboxFromSnapshotParams): Promise<Sandbox> {
    const name = params.name ?? `sandbox-${Date.now()}`;
    // envVars are never passed: nothing from the host or the session enters the container.
    const r = await this.run([this.cli, ...runArgs(this.o, name, params.labels ?? {})], { timeoutS: 120 });
    if (r.exitCode !== 0) throw new Error(`couldn't start the local sandbox container (exit ${r.exitCode}); is ${this.cli} running and ${this.o.runtime || "the default runtime"} installed?`);
    return this.handle(name, params.labels ?? {});
  }
}
