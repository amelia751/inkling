import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Daytona, DaytonaNotFoundError, Image } from "@daytona/sdk";
import { SANDBOX_HOME } from "./defaults.ts";

export const REQUIREMENTS_PATH = resolve(import.meta.dirname, "../../sandbox-image/requirements.txt");
/** Bump when the recipe below changes in a way the requirements hash can't see. */
export const RECIPE_VERSION = "1";
export const PYTHON_VERSION = "3.12";
export const SNAPSHOT_RESOURCES = { cpu: 2, memory: 4, disk: 10 };

const APT_PACKAGES = ["git", "curl", "ca-certificates", "ripgrep", "jq", "file", "procps"];

export function buildImage(requirementsPath = REQUIREMENTS_PATH): Image {
  return Image.debianSlim(PYTHON_VERSION)
    .runCommands(
      `apt-get update && apt-get install -y --no-install-recommends ${APT_PACKAGES.join(" ")} && rm -rf /var/lib/apt/lists/*`,
      `mkdir -p ${SANDBOX_HOME}/work ${SANDBOX_HOME}/data ${SANDBOX_HOME}/out`,
    )
    .pipInstallFromRequirements(requirementsPath)
    .env({ PYTHONUNBUFFERED: "1", MPLBACKEND: "Agg" })
    .workdir(SANDBOX_HOME);
}

/** Content-addressed: a changed recipe or requirement gets a new snapshot name automatically. */
export function snapshotName(requirements: string, recipe = `${RECIPE_VERSION}|${PYTHON_VERSION}|${APT_PACKAGES.join(",")}|${JSON.stringify(SNAPSHOT_RESOURCES)}`): string {
  const hash = createHash("sha256").update(recipe).update("\0").update(requirements.replace(/\r\n/g, "\n").trim()).digest("hex");
  return `inkling-agent-${hash.slice(0, 12)}`;
}

export function currentSnapshotName(requirementsPath = REQUIREMENTS_PATH): string {
  return snapshotName(readFileSync(requirementsPath, "utf8"));
}

export type SnapshotStatus = { name: string; state: "active" | "building" | "missing" | "error"; detail?: string };

export async function getSnapshotStatus(daytona: Daytona, name = currentSnapshotName()): Promise<SnapshotStatus> {
  try {
    const snap = await daytona.snapshot.get(name);
    const state = String(snap.state);
    if (state === "active") return { name, state: "active" };
    if (state === "error" || state === "build_failed") return { name, state: "error", detail: snap.errorReason ?? state };
    return { name, state: "building", detail: state };
  } catch (err) {
    if (err instanceof DaytonaNotFoundError) return { name, state: "missing" };
    throw err;
  }
}

const inflight = new Map<string, Promise<string>>();

/**
 * Build the snapshot if missing (or rebuild if errored). Concurrent callers share one build.
 * Takes minutes; never await this on the chat path, use `resolveSnapshot` there.
 */
export function ensureSnapshot(daytona: Daytona, opts: { onLogs?: (chunk: string) => void; timeoutS?: number } = {}): Promise<string> {
  const name = currentSnapshotName();
  let p = inflight.get(name);
  if (!p) {
    p = (async () => {
      const status = await getSnapshotStatus(daytona, name);
      if (status.state === "active") return name;
      if (status.state === "error") await daytona.snapshot.delete(name);
      if (status.state !== "building") {
        await daytona.snapshot.create(
          { name, image: buildImage(), resources: SNAPSHOT_RESOURCES },
          { onLogs: opts.onLogs, timeout: opts.timeoutS ?? 1800 },
        );
      }
      return name;
    })().finally(() => inflight.delete(name));
    inflight.set(name, p);
  }
  return p;
}

/**
 * Snapshot to create sandboxes from right now: the configured override, the Inkling snapshot if it's
 * active, or `undefined` (Daytona's default image) with a warning so a chat never waits on a build.
 */
export async function resolveSnapshot(
  daytona: Daytona,
  override: string | undefined,
  warn: (msg: string) => void = () => {},
): Promise<string | undefined> {
  if (override === "default") return undefined;
  if (override) return override;
  const status = await getSnapshotStatus(daytona).catch(() => undefined);
  if (status?.state === "active") return status.name;
  warn(`snapshot ${status?.name ?? "?"} is ${status?.state ?? "unreachable"}; using Daytona's default image (run \`pnpm --filter @studio/agent snapshot\`)`);
  return undefined;
}
