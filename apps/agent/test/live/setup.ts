import type { Daytona } from "@daytona/sdk";
import { type Config, envName, loadConfig, withPrefix } from "../../src/config.ts";
import { loadDevSecrets } from "../../src/secrets.ts";
import { createDaytona } from "../../src/sandbox/client.ts";
import { listOwned } from "../../src/sandbox/sweeper.ts";

process.env[envName("ENV")] ??= "test";
loadDevSecrets();

export const { config } = loadConfig({ ...process.env, ...withPrefix({ AGENT_SANDBOX_TTL_MIN: "60", AGENT_SANDBOX_AUTO_STOP_MIN: "10" }) });
export const daytona: Daytona | undefined = createDaytona(config);
export const live = Boolean(daytona);

export const LIVE_LABELS = { test: "live" };
const MAX_LEFTOVERS = 3;

/** Refuse to spend if earlier runs leaked sandboxes. */
export async function assertNoLeftovers(d: Daytona, cfg: Config): Promise<void> {
  const left = await listOwned(d, cfg.env, LIVE_LABELS);
  if (left.length > MAX_LEFTOVERS) {
    throw new Error(
      `${left.length} leftover app=inkling,env=${cfg.env},test=live sandboxes exist; run \`pnpm --filter @studio/agent sweep -- --env ${cfg.env} --label test=live --delete\``,
    );
  }
}

export const runId = () => `live-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
