import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { buildApp } from "../../src/main.ts";

const TOKEN = "test-token-0123456789";
const { config } = loadConfig({ APP_ENV: "test", OPENAI_API_KEY: "sk-test-not-real", INTERNAL_AGENT_SERVICE_TOKEN: TOKEN });
const { app } = await buildApp(config);
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

describe("HTTP API", () => {
  it("health is public; everything under /v1 needs the service token", async () => {
    expect((await app.request("/health/live")).status).toBe(200);
    expect((await app.request("/v1/status")).status).toBe(401);
    expect((await app.request("/v1/status", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const res = await app.request("/v1/status", { headers: auth });
    expect(await res.json()).toEqual({ configured: true, provider: "openai", model: "gpt-6.1-sol", sandbox: "off" });
  });

  it("creates, reads and deletes a session; validates bodies", async () => {
    const bad = await app.request("/v1/sessions", { method: "POST", headers: auth, body: JSON.stringify({ projectId: "p", profile: "root" }) });
    expect(bad.status).toBe(400);
    const notAllowed = await app.request("/v1/sessions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ projectId: "p", profile: "assistant", clientTools: [{ name: "bash", description: "x", input_schema: {} }] }),
    });
    expect(notAllowed.status).toBe(400);
    const coder = await app.request("/v1/sessions", { method: "POST", headers: auth, body: JSON.stringify({ projectId: "p", profile: "coder" }) });
    expect(coder.status).toBe(503);

    const res = await app.request("/v1/sessions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ projectId: "p1", profile: "environment-designer", clientTools: [{ name: "get_environment", description: "Read the spec", input_schema: { type: "object", properties: {} } }] }),
    });
    expect(res.status).toBe(201);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const info = await (await app.request(`/v1/sessions/${sessionId}`, { headers: auth })).json();
    expect(info).toMatchObject({ sessionId, projectId: "p1", profile: "environment-designer", artifacts: [] });
    expect((await app.request(`/v1/sessions/${sessionId}`, { method: "DELETE", headers: auth })).status).toBe(204);
    expect((await app.request(`/v1/sessions/${sessionId}`, { headers: auth })).status).toBe(404);
  });

  it("unknown runs and approvals are 404/409, not 500", async () => {
    expect((await app.request("/v1/runs/run_x/events", { headers: auth })).status).toBe(404);
    expect((await app.request("/v1/approvals/apr_x", { method: "POST", headers: auth, body: JSON.stringify({ decision: "approve" }) })).status).toBe(409);
  });
});
