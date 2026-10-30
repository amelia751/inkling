import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, describeSecrets, loadConfig, withPrefix } from "../../src/config.ts";
import { createParams, sandboxLabels, sandboxName } from "../../src/sandbox/defaults.ts";
import { snapshotName } from "../../src/sandbox/snapshot.ts";
import { loadDevSecrets, maskSecret, parseEnvFile } from "../../src/secrets.ts";
import { NAMING } from "../../src/naming.ts";

const RES = NAMING.resourcePrefix;

describe("secrets", () => {
  it("parses env files", () => {
    expect(parseEnvFile(`# c\nA=1\nexport B="two words"\nC='x # y'\nD=v # trailing\n\nbad line`)).toEqual({
      A: "1",
      B: "two words",
      C: "x # y",
      D: "v",
    });
  });

  it("never overrides the real environment and skips production", () => {
    const dir = mkdtempSync(join(tmpdir(), `${RES}-secrets-`));
    writeFileSync(join(dir, "a.env"), "KEEP=file\nNEW=file\n");
    const env: NodeJS.ProcessEnv = { KEEP: "real" };
    expect(loadDevSecrets(env, dir)).toEqual(["NEW"]);
    expect(env).toMatchObject({ KEEP: "real", NEW: "file" });
    const prod = withPrefix({ ENV: "production" });
    expect(loadDevSecrets(prod, dir)).toEqual([]);
    expect(prod.NEW).toBeUndefined();
  });

  it("masks to the last three characters", () => {
    expect(maskSecret("dtn_abcdef5a3")).toBe("set …5a3");
    expect(maskSecret(undefined)).toBe("missing");
  });
});

describe("config", () => {
  it("fails closed in production when keys are missing", () => {
    expect(() => loadConfig(withPrefix({ ENV: "production" }))).toThrow(ConfigError);
  });

  it("only warns in dev", () => {
    const { config, warnings } = loadConfig(withPrefix({}));
    expect(config.daytona).toBeUndefined();
    expect(warnings[0]).toMatch(/DAYTONA_API_KEY/);
  });

  it("rejects models outside the allowlist", () => {
    expect(() => loadConfig(withPrefix({ AGENT_MODEL: "openai:o1-pro" }))).toThrow(/ALLOWLIST/);
  });

  it("describeSecrets never prints values", () => {
    const { config } = loadConfig(withPrefix({ DAYTONA_API_KEY: "dtn_supersecretvalue5a3", OPENAI_API_KEY: "sk-abcdefDkA" }));
    const line = describeSecrets(config);
    expect(line).not.toContain("supersecret");
    expect(line).toContain("daytona=set …5a3");
  });
});

describe("sandbox defaults", () => {
  const { config } = loadConfig(withPrefix({ ENV: "test", DAYTONA_API_KEY: "k" }));
  const who = { sessionId: "S_1/x", projectId: "p 1", owner: "me@x.com", profile: "coder" };

  it("names are deterministic and DNS-safe", () => {
    expect(sandboxName("test", "S_1/x")).toBe(`${RES}-test-s-1-x`);
    expect(sandboxName("development", "a".repeat(100)).length).toBeLessThanOrEqual(63);
  });

  it("labels carry the sweep keys with a safe charset", () => {
    expect(sandboxLabels("test", who)).toEqual({ app: RES, env: "test", session: "S_1_x", project: "p_1", owner: "me_x.com", profile: "coder" });
  });

  it("private, lifecycle-bounded, no egress overrides unless the tier allows it", () => {
    const p = createParams(config, who);
    expect(p).toMatchObject({ public: false, autoStopInterval: 15, autoArchiveInterval: 1440, autoDeleteInterval: 10080, ttlMinutes: 1440 });
    expect(p.domainAllowList).toBeUndefined();
    expect(p.networkBlockAll).toBeUndefined();
    expect(JSON.stringify(p.envVars)).not.toMatch(/KEY|TOKEN|SECRET/);

    const egress = { canOverride: true, allowDomains: ["pypi.org"] };
    expect(createParams(config, who, { egress }).domainAllowList).toBe("pypi.org");
    expect(createParams(config, { ...who, restricted: true }, { egress }).networkBlockAll).toBe(true);
  });
});

describe("snapshot name", () => {
  it("is stable for the same inputs and changes with requirements", () => {
    const a = snapshotName("numpy==2.5.4\n");
    expect(snapshotName("numpy==2.5.4")).toBe(a);
    expect(snapshotName("numpy==2.5.4\r\n")).toBe(a);
    expect(snapshotName("numpy==2.5.5")).not.toBe(a);
    expect(a).toMatch(new RegExp(`^${RES}-agent-[0-9a-f]{12}$`));
  });
});
