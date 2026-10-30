import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { SandboxUnavailableError } from "../../src/sandbox/client.ts";
import { backgroundSafe, shellQuote, truncateMiddle, withRecovery } from "../../src/sandbox/exec.ts";
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
