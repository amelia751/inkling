import { describe, expect, it } from "vitest";
import { ns } from "../naming";
import {
  ApprovalRequest,
  BUILTIN_STEP_CONTRACTS,
  BuiltinStepContracts,
  INGEST_PIPELINE,
  PIPELINE_API_VERSION,
  PIPELINE_EVENT_TYPES,
  PIPELINE_RUN_TRANSITIONS,
  PIPELINE_SCHEMAS,
  PipelineEvent,
  PipelineGraph,
  ReproducibilityEnvelope,
  StepInput,
  parseRef,
  pipelineEventKey,
} from ".";

const d = (c: string) => `sha256:${c.repeat(64)}`;

describe("pipeline graph", () => {
  it("parses the ingest definition and applies defaults", () => {
    const g = PipelineGraph.parse(INGEST_PIPELINE);
    expect(g.apiVersion).toBe(PIPELINE_API_VERSION);
    expect(g.apiVersion.startsWith(`${ns("dev")}/`)).toBe(true);
    expect(g.steps.map((s) => s.id)).toEqual(["inspect", "derivatives", "validate", "propose"]);
    expect(g.steps[0]!.needs).toEqual([]);
    expect(g.steps[0]!.on_failure).toBe("fail");
  });

  it("rejects duplicate ids, unknown needs, bad refs and unknown fields", () => {
    const base = { apiVersion: PIPELINE_API_VERSION, kind: "Pipeline", metadata: { name: "p" } };
    const step = (id: string, extra = {}) => ({ id, uses: `${ns("x")}@1`, ...extra });
    expect(PipelineGraph.safeParse({ ...base, steps: [step("a"), step("a")] }).success).toBe(false);
    expect(PipelineGraph.safeParse({ ...base, steps: [step("a", { needs: ["b"] })] }).success).toBe(false);
    expect(PipelineGraph.safeParse({ ...base, steps: [step("a", { inputs: { x: "steps.b.outputs.y" } })] }).success).toBe(false);
    expect(PipelineGraph.safeParse({ ...base, steps: [step("a", { run: "rm -rf /" })] }).success).toBe(false);
    expect(PipelineGraph.safeParse({ ...base, apiVersion: "other.dev/v1", steps: [step("a")] }).success).toBe(false);
  });

  it("splits references", () => {
    expect(parseRef("${inputs.upload}")).toEqual({ kind: "input", name: "upload" });
    expect(parseRef("${steps.inspect.outputs.items}")).toEqual({ kind: "step", step: "inspect", port: "items" });
    expect(parseRef("${env.SECRET}")).toBeNull();
  });
});

describe("step contracts and I/O", () => {
  it("builtin step contracts are valid and namespaced", () => {
    const parsed = BuiltinStepContracts.parse({ steps: BUILTIN_STEP_CONTRACTS });
    for (const s of parsed.steps) expect(s.id.startsWith(`${ns("")}`)).toBe(true);
  });

  it("step input keys are attempt-unique prefixes under pipeline/", () => {
    const input = {
      run_id: "run_1",
      workspace_id: "ws_1",
      project_id: "p_1",
      step_id: "derivatives",
      partition_id: "3",
      idempotency_key: "run_1/derivatives/3",
      uses: `${ns("ingest.derivatives")}@1.0.0`,
      inputs: { items: { type: "item_set", manifest: { key: "pipeline/run_1/inspect/0.1/items.json", digest: d("a"), size: 10, media_type: "application/json" } } },
      params: {},
      params_digest: d("b"),
      output_prefix: "pipeline/run_1/derivatives/",
    };
    expect(StepInput.parse(input)).toEqual(input);
    expect(StepInput.safeParse({ ...input, output_prefix: "sources/p/abc/" }).success).toBe(false);
  });
});

describe("runs, envelopes and events", () => {
  it("terminal states have no way out", () => {
    for (const s of ["published", "rejected", "failed", "cancelled"] as const) expect(PIPELINE_RUN_TRANSITIONS[s]).toEqual([]);
    expect(PIPELINE_RUN_TRANSITIONS.awaiting_review).toContain("publishing");
  });

  it("the reproducibility envelope is strict", () => {
    const env = {
      run_id: "run_1",
      workspace_id: "ws_1",
      definition_id: "ingest",
      definition_revision: d("1"),
      plan_digest: d("2"),
      resolved_step_versions: { inspect: `${ns("ingest.inspect")}@1.0.0` },
      parameters_digest: d("3"),
      execution_policy_version: "policy_1",
      engine: "dbos",
      application_version: "sha256:abc",
      created_at: "2026-11-01T00:00:00Z",
    };
    expect(ReproducibilityEnvelope.parse(env).input_dataset_commits).toEqual([]);
    expect(ReproducibilityEnvelope.safeParse({ ...env, token: "secret" }).success).toBe(false);
    expect(ReproducibilityEnvelope.safeParse({ ...env, engine: "temporal" }).success).toBe(false);
  });

  it("events carry the kernel envelope with a typed payload per type", () => {
    const ev = {
      event_id: "evt_1",
      workspace_id: "ws_1",
      type: "pipeline.run.completed",
      source: "pipeline",
      depth: 1,
      idempotency_key: pipelineEventKey("run_1", "pipeline.run.completed"),
      payload: { project_id: "p_1", run_id: "run_1", state: "awaiting_review", output_manifest_digest: d("a"), candidate_commit: "a".repeat(40) },
    };
    expect(PipelineEvent.parse(ev)).toEqual(ev);
    expect(PipelineEvent.safeParse({ ...ev, payload: { ...ev.payload, file_name: "jane.dcm" } }).success).toBe(false);
    expect(PipelineEvent.safeParse({ ...ev, type: "pipeline.run.exploded" }).success).toBe(false);
    expect(PIPELINE_EVENT_TYPES).toHaveLength(11);
    expect(pipelineEventKey("run_1", "pipeline.step.started", "inspect")).toBe("run_1/pipeline.step.started/inspect");
  });

  it("approvals bind to a candidate digest", () => {
    expect(ApprovalRequest.safeParse({ run_id: "run_1", approval_id: "apr_1", candidate_digest: d("c") }).success).toBe(true);
    expect(ApprovalRequest.safeParse({ run_id: "run_1", approval_id: "apr_1" }).success).toBe(false);
  });

  it("every schema emits", () => {
    for (const path of Object.keys(PIPELINE_SCHEMAS)) expect(path).toMatch(/^pipeline\/[a-z-]+\.v1\.json$/);
  });
});
