import { describe, expect, it } from "vitest";
import { ConfigError, VERTEX_PROVIDER, loadConfig, withPrefix } from "../../src/config.ts";

// todo22 W1 (D2): ENV=production refuses dev sign-in and the file store. Key names, never values.
const MODEL = `${VERTEX_PROVIDER}:gemini-3.1-pro-preview`;
const SECRET = "postgres://agent:super-secret-value@db/agent";
const prod = (extra: Record<string, string | undefined> = {}) => ({
  ...withPrefix({
    ENV: "production",
    AGENT_MODEL: MODEL,
    AGENT_MODEL_ALLOWLIST: MODEL,
    AGENT_SANDBOX: "off",
    AGENT_SANDBOX_NETWORK: "block",
    AGENT_TOKEN: "service-token",
    AGENT_APPROVAL_SECRET: "approval-secret",
    AGENT_AUTH_MODE: "workos",
    AGENT_WORKOS_CLIENT_ID: "client_test",
    AGENT_STORE: "postgres",
    AGENT_DATABASE_URL: SECRET,
    ...extra,
  }),
  GOOGLE_CLOUD_PROJECT: "build-project",
  GOOGLE_CLOUD_LOCATION: "us-central1",
});

function refused(env: NodeJS.ProcessEnv): string {
  let err: unknown;
  try {
    loadConfig(env);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConfigError);
  const msg = (err as Error).message;
  expect(msg).not.toContain("super-secret-value");
  return msg;
}

describe("production config fails closed", () => {
  it("loads a signed-in, Postgres-backed production config", () => {
    const { config } = loadConfig(prod());
    expect(config.auth.mode).toBe("workos");
    expect(config.store.kind).toBe("postgres");
  });

  it("refuses dev sign-in", () => {
    expect(refused(prod({ AGENT_AUTH_MODE: "dev" }))).toMatch(/AGENT_AUTH_MODE must be workos/);
  });

  it("refuses dev sign-in when the mode is left at its default", () => {
    expect(refused(prod({ AGENT_AUTH_MODE: undefined }))).toMatch(/AGENT_AUTH_MODE must be workos/);
  });

  it("refuses the file store", () => {
    expect(refused(prod({ AGENT_STORE: "file" }))).toMatch(/AGENT_STORE must be postgres/);
  });

  it("refuses the file store when the store is left at its default", () => {
    const msg = refused(prod({ AGENT_STORE: undefined }));
    expect(msg).toMatch(/AGENT_STORE must be postgres/);
    expect(msg).not.toMatch(/AGENT_AUTH_MODE/);
  });

  it("still allows dev mode outside production", () => {
    const { config } = loadConfig(prod({ ENV: "development", AGENT_AUTH_MODE: "dev", AGENT_STORE: "file", AGENT_DATABASE_URL: undefined }));
    expect(config.auth.mode).toBe("dev");
    expect(config.store.kind).toBe("file");
  });
});
