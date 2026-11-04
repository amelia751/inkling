import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, modelFamily, withPrefix } from "../../src/config.ts";
import { PROFILES, profileAvailable, systemPrompt } from "../../src/agent/profiles.ts";
import { KERNEL_SCOPES, KernelClient } from "../../src/tools/kernel.ts";
import { REVIEW_TOOL_NAMES, createReviewTools } from "../../src/tools/review.ts";

// todo23 W9 (D11): the reviewer runs on another model family, under its own principal, with no write tools.
const ALLOW = "anthropic:claude-sonnet-5-5,openai:gpt-6.1-sol,muse:muse-spark-1.3,muse:muse-wonder-1.0";
const env = (extra: Record<string, string>) => withPrefix({ AGENT_MODEL_ALLOWLIST: ALLOW, AGENT_SANDBOX: "off", AGENT_DATA_DIR: mkdtempSync(join(tmpdir(), "rev-")), ...extra });

describe("AGENT_REVIEWER_MODEL", () => {
  it("accepts an allowlisted model from another family", () => {
    const { config } = loadConfig(env({ AGENT_MODEL: "muse:muse-spark-1.3", AGENT_REVIEWER_MODEL: "anthropic:claude-sonnet-5-5" }));
    expect(config.reviewerModel).toBe("anthropic:claude-sonnet-5-5");
  });

  it("fails startup when the reviewer shares the builder's family", () => {
    expect(() => loadConfig(env({ AGENT_MODEL: "muse:muse-spark-1.3", AGENT_REVIEWER_MODEL: "muse:muse-wonder-1.0" }))).toThrow(/same model family/);
  });

  it("fails startup when the reviewer isn't allowlisted", () => {
    expect(() => loadConfig(env({ AGENT_MODEL: "muse:muse-spark-1.3", AGENT_REVIEWER_MODEL: "openai:gpt-1" }))).toThrow(ConfigError);
  });

  it("exempts the scripted model in dev and test, never production", () => {
    expect(loadConfig(env({ AGENT_MODEL: "scripted", AGENT_REVIEWER_MODEL: "scripted" })).config.reviewerModel).toBe("scripted:replay");
    expect(modelFamily("google-vertex:claude-opus-5-5")).toBe("anthropic");
    expect(modelFamily("openai:gpt-6.1-sol")).toBe("openai");
  });

  it("leaves the review profiles off when unset", () => {
    const { config } = loadConfig(env({ AGENT_MODEL: "scripted" }));
    expect(config.reviewerModel).toBeUndefined();
    expect(profileAvailable(PROFILES.reviewer, false, !!config.reviewerModel)).toBe(false);
    expect(profileAvailable(PROFILES.builder, false, false)).toBe(true);
  });
});

describe("reviewer and red-team profiles", () => {
  it("have no client tools, no sandbox, no kernel builder or task tools, and their own prompts", () => {
    for (const name of ["reviewer", "red-team"] as const) {
      const p = PROFILES[name];
      expect(p.clientTools).toEqual([]);
      expect(p.sandbox).toBe(false);
      expect(p.kernel).toBeUndefined();
      expect(p.studio).toBeFalsy();
      expect(p.review).toBe(true);
      expect(systemPrompt(p)).not.toContain("{{displayName}}");
    }
    expect(systemPrompt(PROFILES["red-team"])).toMatch(/main-thread/i);
  });

  it("carry only review scopes (never plugins.manage or project.write)", () => {
    for (const name of ["reviewer", "red-team"] as const) {
      expect(KERNEL_SCOPES[name]).toEqual(["plugins.read", "reviews.read", "reviews.write"]);
    }
  });

  it("record the reviewer model on every review and write tests only to the hidden-tests API", async () => {
    const calls: { method: string; url: string; body: any }[] = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      calls.push({ method: init.method!, url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ id: "r1", verdict: "block", path: "hidden-tests/x" }), { status: 201 });
    }) as unknown as typeof fetch;
    const k = new KernelClient({ baseUrl: "http://kernel", workspaceId: "prj-1", token: () => "t", fetchImpl });
    const tools = createReviewTools(k, { projectId: "prj-1", model: "anthropic:claude-sonnet-5-5" });
    expect(tools.map((t) => t.name)).toEqual([...REVIEW_TOOL_NAMES]);
    const artifact = { kind: "plugin", id: "studio.generated.x", version: "0.1.0" };
    await tools.find((t) => t.name === "write_hidden_test")!.execute("1", { artifact, path: "net.test.ts", content: "x" }, undefined, undefined, undefined as any);
    await tools.find((t) => t.name === "submit_review")!.execute("2", { artifact, verdict: "block", findings: [] }, undefined, undefined, undefined as any);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["POST /api/v1/projects/prj-1/reviews/hidden-tests", "POST /api/v1/projects/prj-1/reviews"]);
    expect(calls[1]!.body).toMatchObject({ schema: "review.v1", model: "anthropic:claude-sonnet-5-5", verdict: "block" });
  });
});
