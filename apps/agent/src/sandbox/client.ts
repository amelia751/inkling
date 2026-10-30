import {
  Daytona,
  DaytonaBadRequestError,
  DaytonaError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
} from "@daytona/sdk";
import type { Config } from "../config.ts";

export class SandboxUnavailableError extends Error {
  override name = "SandboxUnavailableError";
  constructor(readonly sandboxId: string) {
    super(
      `Sandbox ${sandboxId.slice(0, 8)} is no longer available (deleted or reaped). ` +
        `The tool was NOT run on the host. A new sandbox is created on the next sandbox tool call.`,
    );
  }
}

export class SandboxQuotaExceededError extends Error {
  override name = "SandboxQuotaExceededError";
}

export class SandboxTimeoutError extends Error {
  override name = "SandboxTimeoutError";
}

export class SandboxDisabledError extends Error {
  override name = "SandboxDisabledError";
  constructor() {
    super("Sandbox execution is not configured (DAYTONA_API_KEY missing). The tool was NOT run on the host.");
  }
}

export function createDaytona(config: Config): Daytona | undefined {
  if (!config.daytona) return undefined;
  const { apiKey, apiUrl, target } = config.daytona;
  return new Daytona({ apiKey, apiUrl, ...(target ? { target } : {}) });
}

const QUOTA_RE = /quota|limit (?:exceeded|reached)|total (?:cpu|memory|disk)|insufficient/i;

export function isQuotaError(err: unknown): boolean {
  return err instanceof DaytonaBadRequestError || (err instanceof DaytonaError && err.statusCode === 403)
    ? QUOTA_RE.test((err as Error).message)
    : false;
}

/** Translate SDK errors into the few cases callers act on; everything else passes through. */
export function mapDaytonaError(err: unknown, sandboxId?: string): unknown {
  if (err instanceof DaytonaNotFoundError && sandboxId) return new SandboxUnavailableError(sandboxId);
  if (isQuotaError(err)) return new SandboxQuotaExceededError((err as Error).message);
  if (err instanceof DaytonaTimeoutError) return new SandboxTimeoutError((err as Error).message);
  return err;
}

function retryAfterMs(err: DaytonaError, attempt: number): number {
  const headers = (err.headers ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(headers)) {
    if (!/^retry-after/i.test(k)) continue;
    const secs = Number(v);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The SDK does not retry 429s; control-plane calls go through this. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof DaytonaRateLimitError) || attempt >= attempts - 1) throw err;
      await sleep(retryAfterMs(err, attempt));
    }
  }
}
