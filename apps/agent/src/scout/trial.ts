import { randomUUID } from "node:crypto";
import type { CreateSandboxFromSnapshotParams, Sandbox } from "@daytona/sdk";
import type { OssEcosystem, OssEvaluation, OssTrialResult, OssTrialStep } from "@studio/contracts/oss-evaluation";
import { type EgressPolicy, INSTALL_ALLOW_DOMAINS, SANDBOX_HOME, sandboxLabels } from "../sandbox/defaults.ts";
import { shellQuote } from "../sandbox/exec.ts";
import type { SandboxProvider } from "../sandbox/provider.ts";

/**
 * `trial_oss` (todo23 D6, D7, §2.2): try vetted packages in a quarantined scout sandbox.
 *
 * - The sandbox has no fixtures, no project data and no credentials (fixed env only), and it
 *   reaches only the package registries (`INSTALL_ALLOW_DOMAINS`), which needs per-sandbox egress
 *   rules (Daytona tier 3+). Without them the trial is refused: never the org's open network.
 * - Only exact pins that passed `vet_oss` are installed (every package is re-vetted here), from
 *   published wheels (`--only-binary :all:`) or npm packages with `--ignore-scripts`: never a repo.
 * - Each install step is recorded; a failed step is rolled back (Repo2Run) and the trial stops.
 *   A step budget caps the whole run; "couldn't set it up" is a normal outcome.
 * - The working state is frozen as a snapshot when the provider can, and the smoke command runs
 *   in a fresh, network-blocked sandbox from it; otherwise in the install sandbox (reported).
 * - Every sandbox it creates is deleted before it returns; autoStop/autoDelete cover a crash.
 */

export const SCOUT_DIR = `${SANDBOX_HOME}/scout`;
const DEFAULT_STEP_BUDGET = 12;
const MAX_STEP_BUDGET = 30;
const OUTPUT_MAX = 2000;

export interface TrialPackage {
  package: string;
  version: string;
  ecosystem: OssEcosystem;
}

export interface TrialInput {
  projectId: string;
  owner: string;
  packages: TrialPackage[];
  /** One deterministic command; exit 0 is a pass. Runs in SCOUT_DIR. */
  smoke: string;
  stepBudget?: number;
  timeoutS?: number;
}

export interface TrialDeps {
  provider: SandboxProvider | undefined;
  egress: () => EgressPolicy;
  /** The static gate, re-run on every package: only vetted pins are installed. */
  vet: (p: TrialPackage) => Promise<OssEvaluation>;
  env: string;
  /** Freeze the install sandbox; resolves to a snapshot id. Undefined: the provider can't. */
  snapshot?: (sb: Sandbox, name: string) => Promise<string>;
  now?: () => number;
}

export interface TrialOutcome {
  result: OssTrialResult;
  evaluations: OssEvaluation[];
}

const EXACT = /^[0-9][0-9A-Za-z.+-]{0,79}$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const PY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class TrialRefused extends Error {
  override name = "TrialRefused";
}

const clip = (s: string) => (s.length > OUTPUT_MAX ? `${s.slice(0, OUTPUT_MAX / 2)}\n…\n${s.slice(-OUTPUT_MAX / 2)}` : s);

/** One install step per package plus its rollback: what goes in, and how to undo it. */
export function installStep(p: TrialPackage, n: number): { command: string; undo: string } {
  if (p.ecosystem === "pypi") {
    const pin = `${p.package}==${p.version}`;
    return {
      command: [`uv pip freeze --python .venv > .scout/freeze-${n}.txt`, `uv pip install --python .venv --only-binary :all: ${shellQuote(pin)}`].join(" && "),
      undo: `uv pip sync --python .venv .scout/freeze-${n}.txt`,
    };
  }
  const pin = `${p.package}@${p.version}`;
  return {
    command: [`cp package.json .scout/package-${n}.json`, `(cp package-lock.json .scout/lock-${n}.json 2>/dev/null || true)`, `npm install --ignore-scripts --no-audit --no-fund --save-exact ${shellQuote(pin)}`].join(" && "),
    undo: `cp .scout/package-${n}.json package.json && (cp .scout/lock-${n}.json package-lock.json 2>/dev/null || rm -f package-lock.json) && rm -rf node_modules && (test ! -f package-lock.json || npm ci --ignore-scripts --no-audit --no-fund)`,
  };
}

export function setupCommand(ecos: Set<OssEcosystem>): string {
  const parts = [`mkdir -p ${SCOUT_DIR}/.scout`, `cd ${SCOUT_DIR}`];
  if (ecos.has("pypi")) parts.push("uv venv --quiet .venv");
  if (ecos.has("npm")) parts.push(`test -f package.json || printf '{"name":"scout","private":true}\\n' > package.json`);
  return parts.join(" && ");
}

export async function trialOss(input: TrialInput, deps: TrialDeps): Promise<TrialOutcome> {
  const now = deps.now ?? Date.now;
  const started = now();
  if (!input.packages.length) throw new TrialRefused("Nothing to try: pass at least one vetted package.");
  for (const p of input.packages) {
    if (!EXACT.test(p.version)) throw new TrialRefused(`${p.package}: "${p.version}" isn't an exact version; trials install exact pins only.`);
    if (!(p.ecosystem === "npm" ? NPM_NAME : PY_NAME).test(p.package)) throw new TrialRefused(`"${p.package}" isn't a valid ${p.ecosystem} package name.`);
  }
  if (!input.smoke.trim() || input.smoke.length > 2000) throw new TrialRefused("The smoke command must be one non-empty command under 2000 characters.");
  if (!deps.provider) throw new TrialRefused("No sandbox provider is configured (AGENT_SANDBOX / DAYTONA_API_KEY), so nothing can be tried. The static gate (vet_oss) still works.");
  const egress = deps.egress();
  if (!egress.canOverride || !deps.provider.canBlockNetwork())
    throw new TrialRefused(
      "This sandbox provider can't restrict a sandbox to the package registries (per-sandbox egress rules need Daytona tier 3+), and a scout sandbox never gets the org's open network. The trial was NOT run.",
    );

  // The gate again, here: the caller's evaluations are not trusted to be current or genuine.
  const evaluations = await Promise.all(input.packages.map((p) => deps.vet(p)));
  const refused = evaluations.filter((e) => e.decision === "refused");
  if (refused.length) {
    return {
      evaluations,
      result: { status: "refused", steps: [], totalMs: now() - started, reason: refused.map((e) => `${e.package}@${e.version}: ${e.reasons.join("; ")}`).join(" | ").slice(0, 1000) },
    };
  }

  const budget = Math.max(2, Math.min(input.stepBudget ?? DEFAULT_STEP_BUDGET, MAX_STEP_BUDGET));
  const timeoutS = Math.max(30, Math.min(input.timeoutS ?? 300, 900));
  const steps: OssTrialStep[] = [];
  const sandboxes: Sandbox[] = [];
  const id = randomUUID().slice(0, 8);
  const params = (purpose: string, network: "install" | "blocked", snapshot?: string): CreateSandboxFromSnapshotParams => {
    const who = { sessionId: `scout-${id}-${purpose}`, projectId: input.projectId, owner: input.owner, profile: "install", labels: { purpose: "oss-scout" } };
    const p: CreateSandboxFromSnapshotParams = {
      name: `scout-${id}-${purpose}`,
      labels: sandboxLabels(deps.env, who),
      language: "python",
      public: false,
      autoStopInterval: 15,
      autoArchiveInterval: 60,
      autoDeleteInterval: 30,
      // Fixed, non-secret values only: no credentials, nothing from the host or the session.
      envVars: { PYTHONUNBUFFERED: "1", npm_config_ignore_scripts: "true" },
    };
    if (network === "install") p.domainAllowList = INSTALL_ALLOW_DOMAINS.join(",");
    else p.networkBlockAll = true;
    if (snapshot) p.snapshot = snapshot;
    return p;
  };
  const exec = async (sb: Sandbox, command: string, cwd = SCOUT_DIR) => {
    const t = now();
    const r = await sb.process.executeCommand(command, cwd, undefined, timeoutS);
    return { exitCode: r.exitCode, output: clip(String(r.result ?? "")), ms: now() - t };
  };
  const finish = (result: Omit<OssTrialResult, "totalMs" | "steps">): TrialOutcome => ({ evaluations, result: { ...result, steps, totalMs: now() - started } });

  try {
    const sb = await deps.provider.create(params("install", "install"), { timeoutS: 180 });
    sandboxes.push(sb);
    const ecos = new Set(input.packages.map((p) => p.ecosystem));
    const setup = await exec(sb, setupCommand(ecos), SANDBOX_HOME);
    steps.push({ command: setupCommand(ecos), exitCode: setup.exitCode, ms: setup.ms, kept: setup.exitCode === 0, output: setup.exitCode ? setup.output : undefined });
    if (setup.exitCode !== 0) return finish({ status: "fail", reason: "Couldn't prepare the scout environment (uv / npm missing from the sandbox image?)." });

    for (const [n, p] of input.packages.entries()) {
      if (steps.length >= budget) return finish({ status: "budget-exceeded", reason: `Stopped at the step budget (${budget}) before ${p.package}.` });
      const step = installStep(p, n);
      const r = await exec(sb, step.command);
      steps.push({ command: step.command, exitCode: r.exitCode, ms: r.ms, kept: r.exitCode === 0, output: r.exitCode ? r.output : undefined });
      if (r.exitCode !== 0) {
        const u = await exec(sb, step.undo);
        steps.push({ command: step.undo, exitCode: u.exitCode, ms: u.ms, kept: false, output: u.exitCode ? u.output : undefined });
        return finish({ status: "fail", reason: `Installing ${p.package}@${p.version} failed (exit ${r.exitCode}); the step was rolled back. Treat "couldn't set it up" as the result.` });
      }
    }

    const size = await exec(sb, "du -sk .venv node_modules 2>/dev/null | awk '{s+=$1} END {print s*1024}'");
    const sizeBytes = size.exitCode === 0 && /^\d+\s*$/.test(size.output) ? Number(size.output.trim()) : undefined;

    let snapshotId: string | undefined;
    let smokeBox = sb;
    let note: string | undefined;
    if (deps.snapshot) {
      snapshotId = await deps.snapshot(sb, `scout-${id}`);
      smokeBox = await deps.provider.create(params("smoke", "blocked", snapshotId), { timeoutS: 180 });
      sandboxes.push(smokeBox);
    } else note = "No snapshot support here: the smoke command ran in the install sandbox (registries reachable).";

    const s = await exec(smokeBox, input.smoke);
    const smoke = { command: input.smoke, exitCode: s.exitCode, ms: s.ms, output: s.output || undefined };
    return finish({ status: s.exitCode === 0 ? "pass" : "fail", smoke, sizeBytes, snapshotId, reason: s.exitCode === 0 ? note : `Smoke command exited ${s.exitCode}.${note ? ` ${note}` : ""}` });
  } finally {
    await Promise.all(sandboxes.map((sb) => sb.delete(60).catch(() => {})));
  }
}
