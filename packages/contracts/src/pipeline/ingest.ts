import { ns } from "../naming";
import { PIPELINE_API_VERSION, PIPELINE_KIND, type PipelineGraphInput } from "./graph";

/**
 * The implicit ingest pipeline (docs/pipeline.md §6; todo/todo12.md §4 Milestone 1 item 5): the
 * import flow's existing steps (inspect, derivatives) plus validation and propose. Uploads keep
 * working without a pipeline; with one, the same files also become a candidate dataset version
 * that a reviewer approves.
 *
 * Emitted to `registry/pipelines/ingest.json` by `pnpm emit:schemas` (ids carry the current
 * namespace, so a rename regenerates it); never edit that file by hand.
 */
export const INGEST_DEFINITION_ID = "ingest";

export const INGEST_PIPELINE: PipelineGraphInput = {
  apiVersion: PIPELINE_API_VERSION,
  kind: PIPELINE_KIND,
  metadata: { name: "ingest", description: "Uploads → inspect → derivatives → validate → candidate dataset version for review." },
  inputs: { upload: { type: "upload_session", description: "The finished upload session, pinned at run start.", pin_at_run_start: true } },
  trigger: { type: "upload.completed" },
  steps: [
    { id: "inspect", uses: `${ns("ingest.inspect")}@1`, inputs: { source: "${inputs.upload}" } },
    {
      id: "derivatives",
      uses: `${ns("ingest.derivatives")}@1`,
      needs: ["inspect"],
      inputs: { items: "${steps.inspect.outputs.items}" },
      fan_out: { over: "${steps.inspect.outputs.items}", batch_size: 64, max_partitions: 1000 },
      on_failure: "quarantine",
    },
    {
      id: "validate",
      uses: `${ns("pipeline.validate")}@1`,
      needs: ["inspect", "derivatives"],
      inputs: { items: "${steps.inspect.outputs.items}", derived: "${steps.derivatives.outputs.derived}", report: "${steps.inspect.outputs.report}" },
    },
    {
      id: "propose",
      uses: `${ns("pipeline.propose")}@1`,
      needs: ["validate", "derivatives"],
      inputs: { accepted: "${steps.validate.outputs.accepted}", derived: "${steps.derivatives.outputs.derived}", report: "${steps.validate.outputs.report}" },
    },
  ],
  outputs: { candidate: "${steps.propose.outputs.candidate}" },
  policy: { review: "required", partial_success: { allowed: true, min_success_ratio: 0 }, deadline_seconds: 86_400, compatibility: "compatible" },
};
