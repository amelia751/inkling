import { type Logger, createServiceLogger } from "@studio/observability-ts";
import { SERVICE_NAME, SERVICE_VERSION } from "./cluster/naming.ts";

/** Same redaction as log.ts: credential-shaped fields by path; callers never log secret values. */
const REDACT = [
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
];

/** The service logger: JSON on stdout with service, version, git_sha, request_id and trace_id. */
export function createServiceLog(level: string = process.env.LOG_LEVEL ?? "info", gitSha = process.env.GIT_SHA): Logger {
  return createServiceLogger({ service: SERVICE_NAME, version: SERVICE_VERSION, level, redact: REDACT, base: gitSha ? { git_sha: gitSha } : undefined });
}
