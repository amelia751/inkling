import { join } from "node:path";
import { dataDir } from "../agent/models.ts";
import type { Config } from "../config.ts";
import { FileSessionStore } from "./file.ts";
import { PostgresSessionStore } from "./postgres.ts";
import type { SessionStore } from "./types.ts";

export type { SessionStore } from "./types.ts";

/** The dev file store's layout under the data dir (sessions/ as before, plus runs/). */
export function fileStore(config: Config): FileSessionStore {
  const dir = dataDir(config);
  return new FileSessionStore(join(dir, "sessions"), join(dir, "runs"));
}

/** AGENT_STORE: `file` (dev, one process) or `postgres` (AGENT_DATABASE_URL). Call `init()` before use. */
export function createStore(config: Config, log?: (msg: string) => void): SessionStore {
  if (config.store.kind === "postgres")
    return new PostgresSessionStore(config.store.databaseUrl!, { schema: config.store.schema, autoMigrate: config.store.autoMigrate, log });
  return fileStore(config);
}
