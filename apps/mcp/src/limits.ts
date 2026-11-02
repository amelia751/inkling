// todo17 D12: per-token rate limit (calls per minute) and daily write quota. Counters live in
// Redis (`<envPrefix>MCP_REDIS_URL`), so every replica shares them; without it they're in process,
// which is only right for one replica (local dev, tests).

export interface CounterStore {
  /** Increment `key`, setting its expiry on first use; the new value. */
  incr(key: string, ttlS: number): Promise<number>;
  ready(): Promise<boolean>;
  close?(): Promise<void>;
}

export class MemoryStore implements CounterStore {
  private readonly counts = new Map<string, { n: number; until: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async incr(key: string, ttlS: number) {
    const t = this.now();
    const cur = this.counts.get(key);
    if (!cur || cur.until <= t) {
      if (this.counts.size > 50_000) for (const [k, v] of this.counts) if (v.until <= t) this.counts.delete(k);
      this.counts.set(key, { n: 1, until: t + ttlS * 1000 });
      return 1;
    }
    cur.n += 1;
    return cur.n;
  }
  async ready() {
    return true;
  }
}

export class RedisStore implements CounterStore {
  private client: Promise<any>;
  constructor(url: string, caFile?: string) {
    this.client = Promise.all([import("ioredis"), import("node:fs")]).then(([m, fs]: [any, typeof import("node:fs")]) => {
      const Redis = m.default ?? m.Redis;
      const u = new URL(url);
      // Query parameters (ssl_cert_reqs=…, other clients' TLS options) aren't ioredis options.
      u.search = "";
      const tls = u.protocol === "rediss:" ? (caFile ? { ca: fs.readFileSync(caFile, "utf8") } : {}) : undefined;
      return new Redis(u.toString(), { maxRetriesPerRequest: 2, ...(tls ? { tls } : {}) });
    });
  }
  async incr(key: string, ttlS: number) {
    const c = await this.client;
    // Keys are per window (minute or day), so refreshing the expiry on each hit is harmless.
    const [[err, n]] = await c.multi().incr(key).expire(key, ttlS).exec();
    if (err) throw err;
    return Number(n);
  }
  async ready() {
    try {
      return (await (await this.client).ping()) === "PONG";
    } catch {
      return false;
    }
  }
  async close() {
    (await this.client).disconnect();
  }
}

export type LimitResult = { ok: true } | { ok: false; kind: "rate" | "quota"; limit: number; retryAfterS: number };

export class Limiter {
  constructor(
    private readonly store: CounterStore,
    private readonly perMin: number,
    private readonly writesPerDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one call (and one write when `write`) for a token; refuse past either limit. 0 = unlimited. */
  async hit(token: string, write: boolean): Promise<LimitResult> {
    const t = this.now();
    if (this.perMin > 0) {
      const minute = Math.floor(t / 60_000);
      const n = await this.store.incr(`mcp:rl:${token}:${minute}`, 61);
      if (n > this.perMin) return { ok: false, kind: "rate", limit: this.perMin, retryAfterS: Math.max(1, Math.ceil(((minute + 1) * 60_000 - t) / 1000)) };
    }
    if (write && this.writesPerDay > 0) {
      const day = Math.floor(t / 86_400_000);
      const n = await this.store.incr(`mcp:wq:${token}:${day}`, 86_401);
      if (n > this.writesPerDay) return { ok: false, kind: "quota", limit: this.writesPerDay, retryAfterS: Math.max(1, Math.ceil(((day + 1) * 86_400_000 - t) / 1000)) };
    }
    return { ok: true };
  }
}
