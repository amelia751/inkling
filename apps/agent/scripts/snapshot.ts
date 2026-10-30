/** Build (or confirm) the content-hashed inkling-agent snapshot. Takes several minutes the first time. */
import { loadConfig } from "../src/config.ts";
import { createDaytona } from "../src/sandbox/client.ts";
import { currentSnapshotName, ensureSnapshot, getSnapshotStatus } from "../src/sandbox/snapshot.ts";
import { loadDevSecrets } from "../src/secrets.ts";

loadDevSecrets();
const { config } = loadConfig();
const daytona = createDaytona(config);
if (!daytona) throw new Error("DAYTONA_API_KEY missing");

const name = currentSnapshotName();
console.log(`snapshot ${name}: ${(await getSnapshotStatus(daytona, name)).state}`);
await ensureSnapshot(daytona, { onLogs: (chunk) => process.stdout.write(chunk) });
console.log(`snapshot ${name}: ${(await getSnapshotStatus(daytona, name)).state}`);
