import { afterEach, describe, expect, it } from "vitest";
import { CARD_TOOLS, ENVIRONMENT_TOOLS, PROFILES, systemPrompt } from "../../src/agent/profiles.ts";
import { KERNEL_SCOPES } from "../../src/tools/kernel.ts";
import { ENV_TOOLS, harness } from "./harness.ts";

/**
 * The Studio offers one general assistant (assistant = assistant + environment-designer + task);
 * coder and builder stay separate profiles, reached only through an offer_specialist hand-off.
 */

const KTOKEN = "kernel-session-token-0123456789";
const spec = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } });

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("assistant is the one general assistant", () => {
  it("profile: cards + environment tools, task kernel, Studio tools, no sandbox", () => {
    const a = PROFILES.assistant;
    expect(a.clientTools).toEqual([...CARD_TOOLS, ...ENVIRONMENT_TOOLS]);
    expect(a.clientTools).toContain("offer_specialist");
    expect(a.sandbox).toBe(false);
    expect(a.studio).toBe(true);
    expect(a.kernel).toBe("task");
    expect(a.prompts).toEqual(["base", "environment", "task", "specialists", "boot"]);
    // It covers everything environment-designer and task accept.
    for (const t of [...PROFILES["environment-designer"].clientTools, ...PROFILES.task.clientTools]) expect(a.clientTools).toContain(t);
    // Specialists keep their own trust boundaries.
    expect(PROFILES.coder.sandbox).toBe(true);
    expect(PROFILES.builder.kernel).toBe("builder");
    expect(PROFILES.builder.clientTools).not.toContain("run_command");
  });

  it("system prompt combines environment, task and specialist guidance, boot last", () => {
    const sys = systemPrompt(PROFILES.assistant, { studioIndex: "INDEX" });
    expect(sys).toContain("patch_environment");
    expect(sys).toContain("invoke_capability");
    expect(sys).toContain("offer_specialist");
    expect(sys).toMatch(/specialist "builder"/);
    expect(sys).toMatch(/specialist "coder"/);
    expect(sys).not.toContain("can't change the environment");
    expect(sys).not.toContain("{{displayName}}");
    expect(sys.indexOf("boot_studio")).toBeGreaterThan(sys.indexOf("offer_specialist"));
    expect(sys.endsWith("INDEX")).toBe(true);
  });

  it("kernel scopes: assistant is the union of the old assistant and task scopes", () => {
    expect(new Set(KERNEL_SCOPES.assistant)).toEqual(new Set([...KERNEL_SCOPES.task, "proposals.write", "project.write"]));
    for (const s of ["plugins.manage", "plugins.author", "samples.inspect"]) expect(KERNEL_SCOPES.assistant).not.toContain(s);
  });

  it("session: task tools load and browser list_capabilities/inspect_plugin stay (only the builder kernel shadows them)", async () => {
    h = await harness({ scripts: [] });
    const clientTools = [...ENV_TOOLS, spec("list_capabilities"), spec("inspect_plugin"), spec("offer_specialist")];
    const s = await h.json("POST", "/v1/sessions", { projectId: "demo", profile: "assistant", clientTools, kernelToken: KTOKEN });
    expect(s.status).toBe(201);
    const names = (await h.sessions.get(s.body.sessionId)).piSession.getAllTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_capabilities", "inspect_plugin", "offer_specialist", "patch_environment", "run_command", "invoke_capability", "create_job", "list_assets", "boot_studio"]));
    expect(names.some((n) => n.startsWith("dataset_branch") || n === "dataset_commit")).toBe(true);
    for (const x of ["stage_plugin", "plan_plugin_change", "bash", "create_plugin_sandbox"]) expect(names).not.toContain(x);
  });
});
