import { pino } from "pino";

export type Logger = pino.Logger;

/**
 * Structured JSON logs. Context travels as fields (`sessionId`, `runId`, `toolCallId`, `sandboxId`);
 * anything credential-shaped is redacted by path, and callers never log secret values or tool
 * arguments (see secrets.ts `maskSecret`).
 */
export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    base: { svc: "inkling-agent" },
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
