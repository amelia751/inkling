import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERTEX_ADC, VERTEX_PROVIDER, describeSecrets, loadConfig, withPrefix } from "../../src/config.ts";
import { createModelRuntime, resolveModel } from "../../src/agent/models.ts";

// D8 (todo10): the model through Vertex AI, authenticated by Application Default Credentials.
const MODEL = `${VERTEX_PROVIDER}:gemini-3.1-pro-preview`;
const vertexEnv = (extra: Record<string, string | undefined> = {}) => ({
  ...withPrefix({ AGENT_MODEL: MODEL, AGENT_MODEL_ALLOWLIST: MODEL, AGENT_SANDBOX: "off", AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), "vertex-")) }),
  GOOGLE_CLOUD_PROJECT: "build-project",
  GOOGLE_CLOUD_LOCATION: "us-central1",
  ...extra,
});

describe("Vertex AI model config", () => {
  it("uses ADC, never a key, when project and location are set", () => {
    const { config, warnings } = loadConfig(vertexEnv());
    expect(warnings).toEqual([]);
    expect(config.vertex).toEqual({ project: "build-project", location: "us-central1" });
    expect(config.providerKeys).toEqual({ [VERTEX_PROVIDER]: VERTEX_ADC });
    expect(describeSecrets(config)).toContain("vertex=adc");
  });

  it("names the missing Google settings, not an API key", () => {
    const { config, warnings } = loadConfig(vertexEnv({ GOOGLE_CLOUD_LOCATION: undefined }));
    expect(config.vertex).toBeUndefined();
    expect(warnings.join(" ")).toContain("GOOGLE_CLOUD_LOCATION");
    expect(warnings.join(" ")).not.toContain("GOOGLE_CLOUD_PROJECT");
    expect(warnings.join(" ")).not.toContain("API_KEY");
  });

  it("fails closed in production without them", () => {
    const env = { ...vertexEnv({ GOOGLE_CLOUD_PROJECT: undefined, GOOGLE_CLOUD_LOCATION: undefined }), ...withPrefix({ ENV: "production", AGENT_TOKEN: "t", AGENT_STORE: "file" }) };
    expect(() => loadConfig(env)).toThrow(/GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION/);
  });

  it("resolves the model in pi and hands it the ADC marker as its credential", async () => {
    const { config } = loadConfig(vertexEnv());
    const runtime = await createModelRuntime(config);
    expect(resolveModel(runtime, config).provider).toBe(VERTEX_PROVIDER);
    expect(runtime.hasConfiguredAuth(VERTEX_PROVIDER)).toBe(true);
  });
});
