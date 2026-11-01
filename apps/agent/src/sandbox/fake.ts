import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { CreateSandboxFromSnapshotParams, Sandbox } from "@daytona/sdk";
import type { SandboxProvider } from "./provider.ts";
import { writeTarGz } from "./tar.ts";

/**
 * `AGENT_SANDBOX=fake` (development and tests; refused in production): an in-memory sandbox that
 * records everything that enters it. No code runs: the few shell commands the builder's tools
 * send (test, mkdir, ls, rm, the check script, the source tarball) are answered by a small
 * interpreter; anything else exits 127. With `AGENT_SANDBOX_FAKE_DIR` set, every file written
 * and every command with its output also lands on disk (`<dir>/<sandbox name>/fs/…`,
 * `…/log.jsonl`), so an end-to-end test can search what a sandbox ever held (todo10 Phase 7 exit).
 */

/** Words of a shell line, honouring the single quotes `shellQuote` produces. */
export function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      cur += line.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? line.length : end;
      inWord = true;
    } else if (c === "\\" && line[i + 1] === "'") {
      cur += "'";
      i++;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

/** The command inside `backgroundSafe(...)`'s wrapper (exec.ts), or the command itself. */
function unwrap(cmd: string): string {
  const m = /^__ink_out=.*\n\( ([\s\S]*)\n\) >"\$__ink_out" 2>&1\n/.exec(cmd);
  return m ? m[1]! : cmd;
}

export class FakeSandboxHandle {
  readonly id: string;
  state = "started";
  readonly files = new Map<string, Buffer>();
  readonly commands: { command: string; cwd?: string; exitCode: number; output: string }[] = [];
  private gone = false;

  constructor(
    readonly name: string,
    readonly labels: Record<string, string>,
    readonly env: Record<string, string>,
    readonly network: { blockAll: boolean; allow?: string },
    private readonly recordDir?: string,
  ) {
    this.id = `fake-${name}`;
    this.record({ event: "create", labels, env: Object.keys(env), network });
  }

  private record(entry: Record<string, unknown>) {
    if (!this.recordDir) return;
    mkdirSync(join(this.recordDir, this.name), { recursive: true });
    appendFileSync(join(this.recordDir, this.name, "log.jsonl"), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  }

  private put(path: string, data: Buffer) {
    const p = posix.normalize(path);
    this.files.set(p, data);
    if (this.recordDir) {
      const f = join(this.recordDir, this.name, "fs", p);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, data);
    }
    this.record({ event: "write", path: p, bytes: data.length });
  }

  private check() {
    if (this.gone) throw new Error("fake sandbox deleted");
  }

  async refreshData() {
    this.check();
  }
  async start() {
    this.state = "started";
  }
  async stop() {
    this.state = "stopped";
  }
  async delete() {
    this.gone = true;
    this.state = "destroyed";
    this.record({ event: "delete" });
  }
  async refreshActivity() {}
  async getSignedPreviewUrl(): Promise<never> {
    throw new Error("the fake sandbox serves no ports");
  }

  fs = {
    uploadFile: async (data: Buffer, path: string) => {
      this.check();
      this.put(path, Buffer.from(data));
    },
    downloadFile: async (path: string) => {
      this.check();
      const f = this.files.get(posix.normalize(path));
      if (!f) throw new Error(`not found: ${path}`);
      return f;
    },
    getFileDetails: async (path: string) => {
      this.check();
      const p = posix.normalize(path);
      const f = this.files.get(p);
      if (f) return { name: posix.basename(p), isDir: false, size: f.length };
      if (this.isDir(p)) return { name: posix.basename(p), isDir: true, size: 0 };
      throw new Error(`not found: ${path}`);
    },
    createFolder: async (path: string) => {
      this.check();
      this.record({ event: "mkdir", path });
    },
  };

  private isDir(p: string) {
    return [...this.files.keys()].some((k) => k.startsWith(`${p.replace(/\/$/, "")}/`));
  }

  private under(dir: string) {
    const root = `${posix.normalize(dir).replace(/\/$/, "")}/`;
    return [...this.files.entries()].filter(([k]) => k.startsWith(root)).map(([k, v]) => [k.slice(root.length), v] as const);
  }

  process = {
    executeCommand: async (command: string, cwd?: string) => {
      this.check();
      const r = this.run(unwrap(command), cwd);
      this.commands.push({ command, cwd, ...r });
      this.record({ event: "exec", command, cwd, exitCode: r.exitCode, output: r.output });
      return { exitCode: r.exitCode, result: r.output };
    },
    createSession: async () => {
      throw new Error("the fake sandbox has no shell sessions (bash streaming)");
    },
  };

  codeInterpreter = {
    createContext: async () => {
      throw new Error("the fake sandbox runs no code");
    },
  };

  private abs(p: string, cwd?: string) {
    return posix.normalize(p.startsWith("/") ? p : posix.join(cwd ?? "/", p));
  }

  private run(cmd: string, cwd?: string): { exitCode: number; output: string } {
    const ok = (output = "") => ({ exitCode: 0, output });
    const no = (code = 1, output = "") => ({ exitCode: code, output });
    const exists = (p: string) => this.files.has(p) || this.isDir(p);
    if (cmd.startsWith("set -u")) {
      // SANDBOX_CHECK_SCRIPT: a declarative plugin has nothing to install; tests don't run here.
      const py = cwd ? this.files.has(this.abs("pyproject.toml", cwd)) : false;
      return py ? ok("::deps ok\n::tests none\n::licences []\n") : ok("::deps none\n");
    }
    if (cmd.includes("/proc/[0-9]*/environ")) return ok("left=0\n");
    const w = shellWords(cmd);
    const has = (...xs: string[]) => xs.every((x, i) => w[i] === x);
    if (has("mkdir", "-p")) return ok();
    if (has("rm", "-f")) {
      for (const p of w.slice(2)) this.files.delete(this.abs(p, cwd));
      return ok();
    }
    if (has("test", "-f") && w[3] === "&&" && w[4] === "tar") {
      // packTarball: `test -f plugin.yaml && tar -czf <tgz> --exclude=… .`
      if (!this.files.has(this.abs(w[2]!, cwd))) return no(1);
      const excludes = w.filter((x) => x.startsWith("--exclude=./")).map((x) => x.slice("--exclude=./".length));
      const files = new Map<string, Buffer>();
      for (const [rel, data] of this.under(cwd ?? "/")) if (!excludes.some((e) => rel === e || rel.startsWith(`${e}/`))) files.set(rel, data);
      this.put(this.abs(w[6]!, cwd), writeTarGz(files));
      return ok();
    }
    if (has("test", "-f") && w.includes("echo")) return ok(this.files.has(this.abs(w[2]!, cwd)) ? "yes\n" : "no\n");
    if (has("test", "-e") && w.includes("||") && w.includes("dir")) {
      const p = this.abs(w[2]!, cwd);
      return exists(p) ? ok(this.isDir(p) ? "dir\n" : "other\n") : no(1);
    }
    if (has("test") && (w[1] === "-e" || w[1] === "-r")) return exists(this.abs(w[2]!, cwd)) ? ok() : no(1);
    if (has("ls", "-1A")) {
      const p = this.abs(w[2]!, cwd);
      const names = new Set(this.under(p).map(([rel]) => rel.split("/")[0]!));
      return names.size || this.isDir(p) ? ok([...names].sort().join("\n")) : no(2);
    }
    if (has("file", "--mime-type", "-b")) return ok("application/octet-stream\n");
    return no(127, `fake sandbox: unsupported command ${w[0] ?? ""}\n`);
  }
}

export class FakeProvider implements SandboxProvider {
  readonly kind = "fake" as const;
  readonly sandboxes = new Map<string, FakeSandboxHandle>();
  constructor(private readonly recordDir?: string) {}

  canBlockNetwork(): boolean {
    return true;
  }

  async get(idOrName: string): Promise<Sandbox | undefined> {
    const sb = this.sandboxes.get(idOrName) ?? [...this.sandboxes.values()].find((s) => s.id === idOrName);
    return sb && sb.state !== "destroyed" ? (sb as unknown as Sandbox) : undefined;
  }

  async create(params: CreateSandboxFromSnapshotParams): Promise<Sandbox> {
    const name = params.name ?? `fake-${this.sandboxes.size}`;
    const sb = new FakeSandboxHandle(name, params.labels ?? {}, params.envVars ?? {}, { blockAll: !!params.networkBlockAll, allow: params.domainAllowList }, this.recordDir);
    this.sandboxes.set(name, sb);
    return sb as unknown as Sandbox;
  }
}
