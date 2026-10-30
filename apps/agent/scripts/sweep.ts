/**
 * Manual GC for inkling-labelled sandboxes.
 *   pnpm --filter @inkling/agent sweep -- [--env test] [--label k=v] [--dry-run | --stop | --delete]
 * Default is --dry-run. Only sandboxes labelled app=inkling and env=<env> are ever touched.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.ts";
import { createDaytona } from "../src/sandbox/client.ts";
import { listOwned } from "../src/sandbox/sweeper.ts";
import { loadDevSecrets } from "../src/secrets.ts";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    env: { type: "string" },
    label: { type: "string", multiple: true },
    "dry-run": { type: "boolean" },
    stop: { type: "boolean" },
    delete: { type: "boolean" },
  },
});

loadDevSecrets();
const { config } = loadConfig();
const daytona = createDaytona(config);
if (!daytona) throw new Error("DAYTONA_API_KEY missing");
const env = values.env ?? config.env;
const labels = Object.fromEntries((values.label ?? []).map((kv) => kv.split("=", 2) as [string, string]));
const mode = values.delete ? "delete" : values.stop ? "stop" : "dry-run";

const list = await listOwned(daytona, env, labels);
console.log(`${list.length} sandbox(es) with app=inkling env=${env} ${JSON.stringify(labels)} — mode: ${mode}`);
for (const s of list) {
  console.log(`  ${s.name}  ${s.state}  created=${s.createdAt}  lastActivity=${s.lastActivityAt}  session=${s.labels.session ?? "-"}`);
  if (mode === "stop" && s.state === "started") await s.stop(60);
  if (mode === "delete") await s.delete(60);
}
if (mode !== "dry-run") console.log("done");
