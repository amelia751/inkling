/**
 * Adapted from @daytona/pi (src/grep-tool.ts, src/find-tool.ts).
 * Copyright Daytona Platforms Inc. SPDX-License-Identifier: Apache-2.0. See ../../NOTICE.
 *
 * pi's find/grep spawn fd/ripgrep on the HOST and Daytona's searchFiles only matches basenames, so
 * both run inside the sandbox. Inkling snapshots always have bash; ripgrep is preferred, with a GNU
 * grep / find fallback for the default Daytona image.
 */
import type { Sandbox } from "@daytona/sdk";
import { execCommand, shellQuote } from "./exec.ts";

export interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export interface FindParams {
  pattern: string;
  path?: string;
  limit?: number;
}

/** NaN, Infinity, negatives and fractions must never reach `head -n` or `--context`. */
export function sanitizeCount(value: number | undefined, fallback: number, min: number): number {
  const v = value ?? fallback;
  return Number.isFinite(v) ? Math.max(min, Math.floor(v)) : fallback;
}

/** ripgrep gives the LAST matching `-g` precedence, so excludes must come after any include glob. */
const excludeGlobs = () => ["!**/.git/**", "!**/node_modules/**"].flatMap((g) => ["-g", shellQuote(g)]);

/** Exit codes 0 (matches), 1 (no matches) and 141 (SIGPIPE from head) all mean success. */
export function buildGrepCommand(params: GrepParams): string {
  const max = sanitizeCount(params.limit, 100, 1);
  const ctx = sanitizeCount(params.context, 0, 0);
  const dir = shellQuote(params.path || ".");
  const pattern = shellQuote(params.pattern);

  const rg = ["rg", "--line-number", "--no-heading", "--color=never", "--hidden"];
  if (params.ignoreCase) rg.push("--ignore-case");
  if (params.literal) rg.push("--fixed-strings");
  if (ctx) rg.push("--context", String(ctx));
  if (params.glob) rg.push("--glob", shellQuote(params.glob));
  rg.push(...excludeGlobs(), "--", pattern, dir);

  const gp = ["grep", "-rnI", "--exclude-dir=.git", "--exclude-dir=node_modules"];
  if (params.ignoreCase) gp.push("-i");
  if (params.literal) gp.push("-F");
  if (ctx) gp.push("-C", String(ctx));
  if (params.glob) gp.push(`--include=${shellQuote(params.glob)}`);
  gp.push("--", pattern, dir);

  return bashPipeline(rg.join(" "), gp.join(" "), max, [0, 1, 141], [0, 1, 141]);
}

/** A path glob (containing `/`) matches at any depth, like pi's local find. */
export function buildFindCommand(params: FindParams): string {
  const max = sanitizeCount(params.limit, 1000, 1);
  const p = params.pattern;
  const effective = p.includes("/") && !p.startsWith("/") && !p.startsWith("**/") && p !== "**" ? `**/${p}` : p;
  const basename = effective.split("/").pop() || effective;

  const rg = ["rg", "--files", "--hidden", "-g", shellQuote(effective), ...excludeGlobs()];
  const find = ["find", ".", "-type", "f", "-name", shellQuote(basename), "!", "-path", "'*/.git/*'", "!", "-path", "'*/node_modules/*'"];
  return bashPipeline(rg.join(" "), find.join(" "), max, [0, 1, 141], [0, 141]);
}

function bashPipeline(primary: string, fallback: string, max: number, okPrimary: number[], okFallback: number[]): string {
  const script = [
    "set +e",
    "if command -v rg >/dev/null 2>&1; then",
    `  ${primary} 2>/dev/null | head -n ${max}`,
    "  rc=${PIPESTATUS[0]}",
    `  case "$rc" in ${okPrimary.join("|")}) exit 0 ;; esac`,
    "else",
    `  ${fallback} 2>/dev/null | head -n ${max}`,
    "  rc=${PIPESTATUS[0]}",
    `  case "$rc" in ${okFallback.join("|")}) exit 0 ;; esac`,
    "fi",
    'exit "$rc"',
  ].join("\n");
  return `bash -c ${shellQuote(script)}`;
}

export interface TextResult {
  content: { type: "text"; text: string }[];
  details: undefined;
}

const text = (t: string): TextResult => ({ content: [{ type: "text", text: t }], details: undefined });

export async function remoteGrep(sandbox: Sandbox, cwd: string, params: GrepParams): Promise<TextResult> {
  const res = await execCommand(sandbox, buildGrepCommand(params), { cwd, backgroundSafe: false });
  if (res.exitCode !== 0) throw new Error(`grep failed in ${params.path || "."} (exit ${res.exitCode})`);
  const out = res.output.replace(/\s+$/, "");
  return text(out || `No matches found for /${params.pattern}/ in ${params.path || "."}`);
}

export async function remoteFind(sandbox: Sandbox, cwd: string, params: FindParams): Promise<TextResult> {
  const dir = params.path ? (params.path.startsWith("/") ? params.path : `${cwd.replace(/\/+$/, "")}/${params.path}`) : cwd;
  const res = await execCommand(sandbox, buildFindCommand(params), { cwd: dir, backgroundSafe: false });
  if (res.exitCode !== 0) throw new Error(`find failed in ${dir} (exit ${res.exitCode})`);
  const lines = res.output
    .split("\n")
    .map((l) => l.replace(/^\.\//, "").replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  return text(lines.length ? lines.join("\n") : "No files found matching pattern");
}
