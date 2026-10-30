import { pino } from "pino";
import { env } from "./config.ts";
import { NAMING } from "./naming.ts";

export type Logger = pino.Logger;

/**
 * Structured JSON logs. Context travels as fields (`sessionId`, `runId`, `toolCallId`, `sandboxId`);
 * anything credential-shaped is redacted by path, and callers never log secret values or tool
 * arguments (see secrets.ts `maskSecret`).
 */
export function createLogger(level: string = env("LOG_LEVEL") ?? "info"): Logger {
  return pino({
    level,
    base: { svc: `${NAMING.resourcePrefix}-agent` },
    redact: {
      paths: [
        "apiKey",
        "token",
        "authorization",
        "headers.authorization",
        "req.headers.authorization",
        "*.apiKey",
        "*.token",
        "*.secret",
        "*.password",
        "env",
        "*.env",
      ],
      censor: "[redacted]",
    },
  });
}
