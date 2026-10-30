/**
 * Portions adapted from @daytona/pi (src/sandbox.ts, src/ops.ts, src/util.ts).
 * Copyright Daytona Platforms Inc. SPDX-License-Identifier: Apache-2.0. See ../../NOTICE.
 */
import { randomUUID } from "node:crypto";
import { DaytonaNotFoundError, type Sandbox } from "@daytona/sdk";
import { SandboxUnavailableError } from "./client.ts";

/** Single-quote for one shell argument; `$`, backticks and globs are not expanded. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * `executeCommand` resolves only when stdout/stderr reach EOF, and a backgrounded child (`server &`)
 * inherits those pipes. Running the command in a subshell redirected to a temp file lets the call
 * return when the foreground finishes. A subshell (not a brace group) keeps a user `exit` from
 * skipping the replay; the newline before `)` terminates a trailing `&`.
 */
export function backgroundSafe(command: string): string {
  return [
    '__ink_out=$(mktemp 2>/dev/null || echo "/tmp/inkling-$$.out")',
    `( ${command}`,
    ') >"$__ink_out" 2>&1',
    "__ink_rc=$?",
    'cat "$__ink_out"',
    'rm -f "$__ink_out"',
    "exit $__ink_rc",
  ].join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RECOVERABLE = new Set(["stopped", "archived", "stopping", "archiving", "starting", "restoring"]);

/** Bring a stopped/archived sandbox back to `started`. Throws SandboxUnavailableError if it's gone. */
export async function ensureStarted(sandbox: Sandbox, timeoutS = 120): Promise<"already" | "resumed"> {
  const deadline = Date.now() + timeoutS * 1000;
  for (;;) {
    try {
      await sandbox.refreshData();
    } catch (err) {
      if (err instanceof DaytonaNotFoundError) throw new SandboxUnavailableError(sandbox.id);
      throw err;
    }
    const state = sandbox.state;
    if (state === "started") return "already";
    if (state === "stopped" || state === "archived") {
      await sandbox.start(timeoutS);
      return "resumed";
    }
    if (!state || !RECOVERABLE.has(state) || Date.now() > deadline) throw new SandboxUnavailableError(sandbox.id);
    await sleep(1000);
  }
}

/**
 * Run a sandbox operation; on failure inspect the real sandbox state (not error strings). Stopped or
 * archived: start and retry once. 404: SandboxUnavailableError. Running: the error was genuine.
 * Never falls back to the host.
 */
export async function withRecovery<T>(sandbox: Sandbox, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    let state: string | undefined;
    try {
      await sandbox.refreshData();
      state = sandbox.state;
    } catch (refreshErr) {
      if (refreshErr instanceof DaytonaNotFoundError) throw new SandboxUnavailableError(sandbox.id);
      throw err;
    }
    if (state === "destroyed" || state === "destroying") throw new SandboxUnavailableError(sandbox.id);
    if (state !== undefined && state !== "started") {
      try {
        await ensureStarted(sandbox);
      } catch {
        throw new SandboxUnavailableError(sandbox.id);
      }
      return await fn();
    }
    throw err;
  }
}

export interface ExecResult {
  exitCode: number;
  output: string;
}

/** One blocking call; cannot be cancelled once running, `timeoutS` bounds it. */
export async function execCommand(
  sandbox: Sandbox,
  command: string,
  opts: { cwd?: string; timeoutS?: number; backgroundSafe?: boolean } = {},
): Promise<ExecResult> {
  const cmd = opts.backgroundSafe === false ? command : backgroundSafe(command);
  const res = await withRecovery(sandbox, () =>
    sandbox.process.executeCommand(cmd, opts.cwd, undefined, opts.timeoutS),
  );
  return { exitCode: res.exitCode ?? 0, output: res.result ?? res.artifacts?.stdout ?? "" };
}

export class ExecAbortedError extends Error {
  override name = "ExecAbortedError";
  constructor(readonly reason: "aborted" | "timeout") {
    super(reason === "timeout" ? "command timed out and was killed" : "command aborted");
  }
}

/**
 * Streaming exec through a Daytona session: output arrives via `onData` as it's produced, and
 * abort/timeout kill the command by deleting the session (Daytona has no per-command kill).
 */
export async function streamCommand(
  sandbox: Sandbox,
  command: string,
  opts: {
    cwd?: string;
    timeoutS?: number;
    signal?: AbortSignal;
    onData: (chunk: string) => void;
    /** After an abort/timeout, processes may have survived the kill; the sandbox should be recreated. */
    onUncertain?: (detail: string) => void;
  },
): Promise<{ exitCode: number }> {
  if (opts.signal?.aborted) throw new ExecAbortedError("aborted");
  const sessionId = `ink-${randomUUID()}`;
  await withRecovery(sandbox, () => sandbox.process.createSession(sessionId));

  let stopped: "aborted" | "timeout" | undefined;
  let deleted = false;
  let killing: Promise<void> | undefined;
  const kill = (why: "aborted" | "timeout") => {
    stopped ??= why;
    killing ??= killAll();
    return killing;
  };
  const killAll = async () => {
    if (deleted) return;
    deleted = true;
    await sandbox.process.deleteSession(sessionId).catch(() => {});
    // Deleting the session normally ends its processes; verify, and kill stragglers by marker.
    const survivors = await killByMarker(sandbox, sessionId).catch(() => -1);
    if (survivors !== 0) opts.onUncertain?.(survivors < 0 ? "kill probe failed" : `${survivors} process(es) survived the kill`);
  };
  const onAbort = () => void kill("aborted");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = opts.timeoutS ? setTimeout(() => void kill("timeout"), opts.timeoutS * 1000) : undefined;

  try {
    const { cmdId } = await sandbox.process.executeSessionCommand(sessionId, {
      command: sessionCommand(command, opts.cwd, sessionId),
      runAsync: true,
    });
    await sandbox.process
      .getSessionCommandLogs(sessionId, cmdId, opts.onData, opts.onData)
      .catch((err) => {
        if (!stopped) throw err;
      });
    if (stopped) throw new ExecAbortedError(stopped);
    for (let i = 0; i < 40; i++) {
      const cmd = await sandbox.process.getSessionCommand(sessionId, cmdId);
      if (cmd.exitCode !== undefined && cmd.exitCode !== null) return { exitCode: cmd.exitCode };
      if (stopped) throw new ExecAbortedError(stopped);
      await sleep(Math.min(100 * 2 ** i, 1000));
    }
    throw new Error("command finished streaming but reported no exit code");
  } catch (err) {
    // Report the abort only once the kill (and its survivor probe) has finished.
    if (stopped) {
      await killing;
      throw new ExecAbortedError(stopped);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    if (!deleted) {
      deleted = true;
      await sandbox.process.deleteSession(sessionId).catch(() => {});
    }
  }
}

/**
 * The shell text for a streamed command. `cd` goes on its own line: `cd X && cmd &` would background
 * the whole AND-list in a subshell whose stdout is the log pipe, so the stream would stay open until
 * the background child exits. stdin is /dev/null so nothing waits for input.
 */
export function sessionCommand(command: string, cwd?: string, marker?: string): string {
  const lines = [marker ? `export ${MARKER_VAR}=${shellQuote(marker)}` : "", cwd ? `cd ${shellQuote(cwd)} || exit 1` : "", command].filter(Boolean);
  return `( ${lines.join("\n")}\n) < /dev/null`;
}

/** Every streamed command's processes inherit this variable, so an abort can find all of them. */
export const MARKER_VAR = "INK_CMD";

/**
 * Shell that SIGKILLs every process whose environment carries `INK_CMD=<marker>`, then prints how
 * many are left. Runs in a separate shell (no marker), so it never matches itself.
 */
export function killByMarkerScript(marker: string): string {
  const want = shellQuote(`${MARKER_VAR}=${marker}`);
  const scan = `for f in /proc/[0-9]*/environ; do p=\${f#/proc/}; p=\${p%/environ}; tr '\\0' '\\n' < "$f" 2>/dev/null | grep -qxF ${want} && echo "$p"; done`;
  return [`pids=$(${scan})`, '[ -n "$pids" ] && kill -9 $pids 2>/dev/null', "sleep 0.3", `left=$(${scan} | wc -l)`, 'echo "left=$left"'].join("\n");
}

async function killByMarker(sandbox: Sandbox, marker: string): Promise<number> {
  const res = await sandbox.process.executeCommand(`bash -c ${shellQuote(killByMarkerScript(marker))}`, undefined, undefined, 20);
  const m = /left=(\d+)/.exec(res.result ?? "");
  if (!m) throw new Error("kill probe printed no count");
  return Number(m[1]);
}

/** Keep the head and tail of long output so errors at either end survive. */
export function truncateMiddle(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const half = Math.floor((maxBytes - 64) / 2);
  const head = buf.subarray(0, half).toString("utf8");
  const tail = buf.subarray(buf.length - half).toString("utf8");
  return { text: `${head}\n\n[… ${buf.length - 2 * half} bytes omitted …]\n\n${tail}`, truncated: true };
}
