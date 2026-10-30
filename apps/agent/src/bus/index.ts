import { RESOURCE_PREFIX } from "../cluster/naming.ts";
import type { Config } from "../config.ts";
import { MemoryRunEventBus } from "./memory.ts";
import { RedisRunEventBus } from "./redis.ts";
import type { RunEventBus } from "./types.ts";

export type { BusItem, RunEventBus } from "./types.ts";

/** AGENT_EVENT_BUS: `memory` (one process) or `redis` (AGENT_REDIS_URL). Call `init()` before use. */
export function createBus(config: Config, log?: (msg: string) => void): RunEventBus {
  if (config.bus.kind === "redis")
    return new RedisRunEventBus(config.bus.redisUrl!, { prefix: RESOURCE_PREFIX, maxLen: config.bus.streamMaxLen, ttlS: config.bus.streamTtlS, log });
  return new MemoryRunEventBus();
}
