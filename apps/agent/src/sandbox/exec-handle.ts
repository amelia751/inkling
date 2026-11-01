import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { SANDBOX_HOME } from "./defaults.ts";
import { shellQuote } from "./exec.ts";

/**
 * A sandbox handle over "run argv in the sandbox, with optional stdin" (the `local` container
 * and `gke` providers). It implements the part of Daytona's `Sandbox` the tools use: fs
 * (through `cat`/`stat`), `executeCommand`, non-streaming shell sessions, lifecycle. Paths
 * under the Daytona home are mapped to the provider's writable root, so tools keep one layout.
 */
export interface ExecResult {
  exitCode: number;
  stdout: Buffer;
}
export type Exec = (argv: string[], opts?: { stdin?: Buffer; timeoutS?: number }) => Promise<ExecResult>;

export class ExecSandboxHandle {
  state = "started";
  private readonly sessions = new Map<string, Map<string, Promise<{ exitCode: number; output: string }>>>();

  constructor(
    readonly id: string,
    readonly name: string,
    readonly labels: Record<string, string>,
    private readonly exec: Exec,
    private readonly lifecycle: { refresh: () => Promise<string>; start?: () => Promise<void>; stop?: () => Promise<void>; delete: () => Promise<void> },
    /** Where SANDBOX_HOME lives in this sandbox (e.g. /workspace when the root is read-only). */
    private readonly home = SANDBOX_HOME,
  ) {}

  /** A tool path → this sandbox's path. */
  map(p: string): string {
    const n = posix.normalize(p);
    return this.home !== SANDBOX_HOME && (n === SANDBOX_HOME || n.startsWith(`${SANDBOX_HOME}/`)) ? this.home + n.slice(SANDBOX_HOME.length) : n;
  }

  /** Command text with the home mapped (commands name paths too). */
  private mapCommand(cmd: string): string {
    return this.home === SANDBOX_HOME ? cmd : cmd.split(SANDBOX_HOME).join(this.home);
  }

  async refreshData() {
    this.state = await this.lifecycle.refresh();
  }
  async start() {
    await this.lifecycle.start?.();
    this.state = "started";
  }
  async stop() {
    await this.lifecycle.stop?.();
    this.state = "stopped";
  }
  async delete() {
    await this.lifecycle.delete();
    this.state = "destroyed";
  }
  async refreshActivity() {}
  async getSignedPreviewUrl(): Promise<never> {
    throw new Error("this sandbox provider serves no preview ports (no network)");
  }

  private async sh(script: string, opts: { stdin?: Buffer; timeoutS?: number; cwd?: string } = {}) {
    const body = opts.cwd ? `cd ${shellQuote(this.map(opts.cwd))} || exit 1\n${this.mapCommand(script)}` : this.mapCommand(script);
    return this.exec(["/bin/sh", "-c", body], { stdin: opts.stdin, timeoutS: opts.timeoutS });
  }

  fs = {
    uploadFile: async (data: Buffer, path: string) => {
      const p = this.map(path);
      const r = await this.exec(["/bin/sh", "-c", `mkdir -p ${shellQuote(posix.dirname(p))} && cat > ${shellQuote(p)}`], { stdin: Buffer.from(data) });
      if (r.exitCode !== 0) throw new Error(`upload to ${path} failed`);
    },
    downloadFile: async (path: string) => {
      const r = await this.exec(["cat", this.map(path)]);
      if (r.exitCode !== 0) throw new Error(`not found: ${path}`);
      return r.stdout;
    },
    getFileDetails: async (path: string) => {
      const r = await this.exec(["/bin/sh", "-c", `if [ -d ${shellQuote(this.map(path))} ]; then echo dir 0; else wc -c < ${shellQuote(this.map(path))} | sed 's/^/file /'; fi`]);
      if (r.exitCode !== 0) throw new Error(`not found: ${path}`);
      const [kind, size] = r.stdout.toString().trim().split(/\s+/);
      return { name: posix.basename(path), isDir: kind === "dir", size: Number(size) || 0 };
    },
    createFolder: async (path: string) => {
      const r = await this.exec(["mkdir", "-p", this.map(path)]);
      if (r.exitCode !== 0) throw new Error(`mkdir ${path} failed`);
    },
  };

  process = {
    executeCommand: async (command: string, cwd?: string, _env?: unknown, timeoutS?: number) => {
      const r = await this.sh(command, { cwd, timeoutS });
      return { exitCode: r.exitCode, result: r.stdout.toString("utf8") };
    },
    // Shell sessions without streaming: the command runs to the end, its output arrives at once.
    createSession: async (id: string) => {
      this.sessions.set(id, new Map());
    },
    executeSessionCommand: async (id: string, req: { command: string }) => {
      const cmdId = randomUUID();
      const p = this.sh(req.command).then((r) => ({ exitCode: r.exitCode, output: r.stdout.toString("utf8") }));
      this.sessions.get(id)?.set(cmdId, p);
      return { cmdId };
    },
    getSessionCommandLogs: async (id: string, cmdId: string, onStdout: (s: string) => void) => {
      const r = await this.sessions.get(id)?.get(cmdId);
      if (r?.output) onStdout(r.output);
    },
    getSessionCommand: async (id: string, cmdId: string) => {
      const r = await this.sessions.get(id)?.get(cmdId);
      return { exitCode: r?.exitCode };
    },
    deleteSession: async (id: string) => {
      this.sessions.delete(id);
    },
  };

  codeInterpreter = {
    createContext: async () => {
      throw new Error("run_python needs Daytona's code interpreter; use bash with python3 in this sandbox");
    },
  };
}
