import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAgentInternal } from "../../dev/agent-internal";

// todo14 D9: the agent's /v1/internal/* (org / member conversation deletion) is service-only; neither
// browser proxy (Vite in dev, nginx in images) may forward /api/agent/internal/*.
describe("agent proxies never forward /api/agent/internal", () => {
  it("Vite proxy rule", () => {
    for (const url of [
      "/api/agent/internal/orgs/org_a/sessions",
      "/api/agent/internal",
      "/api/agent/internal?x=1",
      "/api/agent//internal/orgs/org_a/sessions",
      "/api/agent/sessions/../internal/orgs/org_a/sessions",
      "/api/agent/%69nternal/orgs/org_a/sessions",
      "/api/agent/Internal/orgs/org_a/sessions",
      "/api/agent/%E0%A4%A",
    ])
      expect(isAgentInternal(url), url).toBe(true);
    for (const url of ["/api/agent/sessions", "/api/agent/sessions?projectId=internal", "/api/agent/runs/run_1/events", "/api/agent/internals", undefined])
      expect(isAgentInternal(url), String(url)).toBe(false);
  });

  it("nginx template blocks it ahead of the /api/agent/ proxy", () => {
    const conf = readFileSync(resolve(__dirname, "../../nginx/default.conf.template"), "utf8");
    expect(conf).toMatch(/location \^~ \/api\/agent\/internal \{ return 404; \}/);
  });
});
