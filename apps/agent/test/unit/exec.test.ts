import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxUnavailableError } from "../../src/sandbox/client.ts";
import { MARKER_VAR, backgroundSafe, killByMarkerScript, sessionCommand, shellQuote, truncateMiddle, withRecovery } from "../../src/sandbox/exec.ts";
import { HeadTail, teeCommand } from "../../src/tools/sandbox.ts";
import { FakeSandbox } from "./fake-sandbox.ts";

const sh = (script: string) => {
  try {
    return { out: execFileSync("bash", ["-c", script], { encoding: "utf8", timeout: 5000 }), code: 0 };
  } catch (e: any) {
    return { out: String(e.stdout ?? ""), code: e.status as number };
  }
};

describe("shellQuote", () => {
  it("survives quotes, $, backticks and globs", () => {
    const nasty = `it's $HOME \`id\` *.py "x"`;
    expect(sh(`printf %s ${shellQuote(nasty)}`).out).toBe(nasty);
  });
});

describe("backgroundSafe", () => {
  it("replays output and preserves the exit code", () => {
    const r = sh(backgroundSafe("echo out; echo err >&2; exit 7"));
    expect(r.code).toBe(7);
    expect(r.out).toContain("out");
    expect(r.out).toContain("err");
  });

  it("a user `exit` does not skip the replay; a trailing & is terminated", () => {
    expect(sh(backgroundSafe("echo a; exit 0")).out).toBe("a\n");
    const t0 = Date.now();
    expect(sh(backgroundSafe("sleep 3 &")).code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});

describe("withRecovery", () => {
  it("starts a stopped sandbox and retries once", async () => {
    const sb = new FakeSandbox();
    sb.state = "stopped";
    const out = await withRecovery(sb.asSandbox(), () => sb.process.executeCommand("echo hi"));
    expect(out.exitCode).toBe(0);
    expect(sb.starts).toBe(1);
  });

  it("turns a 404 into SandboxUnavailableError", async () => {
    const sb = new FakeSandbox();
    sb.gone = true;
    await expect(withRecovery(sb.asSandbox(), () => sb.process.executeCommand("x"))).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it("rethrows genuine errors from a running sandbox without retrying", async () => {
    const sb = new FakeSandbox();
    let n = 0;
    await expect(
      withRecovery(sb.asSandbox(), async () => {
        n++;
        throw new Error("real failure");
      }),
    ).rejects.toThrow("real failure");
    expect(n).toBe(1);
    expect(sb.starts).toBe(0);
  });
});

describe("sessionCommand", () => {
  const run = (script: string) => {
    const t0 = Date.now();
    // A pipe on stdout, like Daytona's session log stream: the call returns only when it closes.
    const out = execFileSync("bash", ["-c", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    return { out, ms: Date.now() - t0 };
  };

  it("a backgrounded command with a cwd doesn't hold the output pipe open", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const { out, ms } = run(sessionCommand("nohup sleep 5 >/dev/null 2>&1 & echo bg-ok; pwd", dir));
    expect(out).toContain("bg-ok");
    expect(realpathSync(out.trim().split("\n").at(-1)!)).toBe(realpathSync(dir));
    expect(ms).toBeLessThan(3000);
  });

  it("a missing cwd fails instead of running elsewhere", () => {
    expect(() => run(sessionCommand("echo should-not-run", "/definitely/missing"))).toThrow();
  });
});

describe("truncateMiddle", () => {
  it("keeps head and tail", () => {
    const t = truncateMiddle(`HEAD${"x".repeat(10_000)}TAIL`, 1000);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith("HEAD")).toBe(true);
    expect(t.text.endsWith("TAIL")).toBe(true);
    expect(Buffer.byteLength(t.text)).toBeLessThan(1100);
  });
  it("leaves short text alone", () => {
    expect(truncateMiddle("short", 1000)).toEqual({ text: "short", truncated: false });
  });
});

describe("bash tool plumbing", () => {
  it("teeCommand keeps the exit code, combines stderr and writes the full log", () => {
    const dir = mkdtempSync(join(tmpdir(), "tee-"));
    const log = join(dir, "logs", "call-1.log");
    const r = sh(teeCommand("echo out; echo err >&2; exit 3", log));
    expect(r.code).toBe(3);
    expect(r.out).toBe("out\nerr\n");
    expect(readFileSync(log, "utf8")).toBe("out\nerr\n");
    expect(sh(teeCommand("true", log)).code).toBe(0);
  });

  it("teeCommand inside sessionCommand doesn't wait for a redirected background child", () => {
    const t0 = Date.now();
    const out = execFileSync("bash", ["-c", sessionCommand(teeCommand("nohup sleep 5 >/dev/null 2>&1 & echo bg-ok", join(mkdtempSync(join(tmpdir(), "tee-")), "x.log")), undefined, "m-1")], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(out).toBe("bg-ok\n");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("sessionCommand exports the kill marker before the user's command", () => {
    expect(sh(sessionCommand(`echo "$${MARKER_VAR}"`, undefined, "ink-abc")).out).toBe("ink-abc\n");
    expect(killByMarkerScript("ink-abc")).toContain(`'${MARKER_VAR}=ink-abc'`);
  });

  it("HeadTail keeps the head and tail within the limit", () => {
    const acc = new HeadTail(1000);
    for (let i = 0; i < 500; i++) acc.push(`line ${i}\n`);
    expect(acc.truncated).toBe(true);
    const t = acc.text();
    expect(Buffer.byteLength(t)).toBeLessThanOrEqual(1100);
    expect(t.startsWith("line 0\n")).toBe(true);
    expect(t).toContain("line 499");
    expect(t).toMatch(/bytes omitted/);
    const small = new HeadTail(1000);
    small.push("hi\n");
    expect([small.truncated, small.text()]).toEqual([false, "hi\n"]);
  });
});
