import type { CreateSandboxFromSnapshotParams } from "@daytona/sdk";
import type { Config } from "../config.ts";
import { NAMING } from "../naming.ts";

export const SANDBOX_HOME = "/home/daytona";
export const SANDBOX_CWD = `${SANDBOX_HOME}/work`;
export const SANDBOX_DATA_DIR = `${SANDBOX_HOME}/data`;
export const SANDBOX_OUT_DIR = `${SANDBOX_HOME}/out`;
export const SANDBOX_LOG_DIR = `${SANDBOX_HOME}/.${NAMING.resourcePrefix}/logs`;
export const APP_LABEL = NAMING.resourcePrefix;

export interface SandboxOwner {
  sessionId: string;
  projectId: string;
  owner: string;
  profile: string;
  /** Extra labels, e.g. `{ test: "live" }`. Values must never contain PHI. */
  labels?: Record<string, string>;
  /** Restricted projects get no egress at all. */
  restricted?: boolean;
  /** Narrower egress than the org default (plugin builds: the package index only). */
  egressAllow?: string[];
  /** Extra env vars (plugin builds: fake credentials, so code that reads them fails safely). */
  envVars?: Record<string, string>;
}

/** Plugin-build sandboxes (todo2 Phase 9) may reach the Python package index and nothing else. */
export const PACKAGE_INDEX_HOSTS = ["pypi.org", "files.pythonhosted.org"];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Deterministic, so `daytona.get(name)` can reattach after a restart. */
export function sandboxName(env: string, sessionId: string): string {
  return `${APP_LABEL}-${slug(env)}-${slug(sessionId)}`.slice(0, 63).replace(/-+$/, "");
}

/** Label values are restricted to a safe charset; the sweeper selects by `app` + `env`. */
export function sandboxLabels(env: string, who: SandboxOwner): Record<string, string> {
  const labels: Record<string, string> = {
    app: APP_LABEL,
    env,
    session: who.sessionId,
    project: who.projectId,
    owner: who.owner,
    profile: who.profile,
    ...who.labels,
  };
  for (const [k, v] of Object.entries(labels)) labels[k] = v.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 63);
  return labels;
}

export interface EgressPolicy {
  /** Tier 1–2 orgs cannot override egress; Daytona rejects the create call if we try. */
  canOverride: boolean;
  allowDomains: string[];
}

export const DEFAULT_EGRESS: EgressPolicy = {
  canOverride: false,
  allowDomains: ["pypi.org", "files.pythonhosted.org", "github.com", "objects.githubusercontent.com"],
};

export function createParams(
  config: Config,
  who: SandboxOwner,
  opts: { snapshot?: string; egress?: EgressPolicy } = {},
): CreateSandboxFromSnapshotParams {
  const s = config.sandbox;
  const params: CreateSandboxFromSnapshotParams = {
    name: sandboxName(config.env, who.sessionId),
    labels: sandboxLabels(config.env, who),
    language: "python",
    public: false,
    autoStopInterval: s.autoStopMin,
    autoArchiveInterval: s.autoArchiveMin,
    autoDeleteInterval: s.autoDeleteMin,
    envVars: { ...who.envVars, [`${NAMING.envPrefix}SESSION`]: who.sessionId, PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg" },
  };
  if (s.ttlMin > 0) params.ttlMinutes = s.ttlMin;
  if (opts.snapshot) params.snapshot = opts.snapshot;
  const egress = opts.egress ?? DEFAULT_EGRESS;
  if (egress.canOverride) {
    if (who.restricted) params.networkBlockAll = true;
    else params.domainAllowList = (who.egressAllow ?? egress.allowDomains).slice(0, 100).join(",");
  }
  // Without override rights (tier 1–2) Daytona rejects any network setting, so a plugin-build
  // sandbox keeps the org default there; it has no bash, only file tools and run_plugin_checks.
  return params;
}
