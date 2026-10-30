/**
 * Build (or confirm) the content-hashed sandbox snapshot `inkling-agent-<hash>` (todo1 §4.3).
 * Takes several minutes the first time; sessions fall back to Daytona's default image until it's active.
 *
 *   pnpm --filter @studio/agent snapshot            build if missing, rebuild if errored
 *   pnpm --filter @studio/agent snapshot -- --status
 */
import { loadConfig } from "../src/config.ts";
import { createDaytona } from "../src/sandbox/client.ts";
import { ensureSnapshot, getSnapshotStatus } from "../src/sandbox/snapshot.ts";
import { loadDevSecrets } from "../src/secrets.ts";

loadDevSecrets();
const { config } = loadConfig();
const daytona = createDaytona(config);
if (!daytona) {
  console.error("DAYTONA_API_KEY is not set (secrets/daytona.env).");
  process.exit(1);
}
const status = await getSnapshotStatus(daytona);
console.log(`${status.name}: ${status.state}${status.detail ? ` (${status.detail})` : ""}`);
if (process.argv.includes("--status") || status.state === "active") process.exit(0);
const t0 = Date.now();
await ensureSnapshot(daytona, { onLogs: (chunk) => process.stdout.write(chunk) });
console.log(`\n${(await getSnapshotStatus(daytona)).state} after ${Math.round((Date.now() - t0) / 1000)}s`);
