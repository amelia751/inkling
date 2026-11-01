import type { ItemReport, PipelineRun, PipelineRunSummary } from "./contract";

/**
 * Synthetic runs for unit tests (the e2e fixtures in `e2e/fixtures/pipelines/` have the same
 * shape). Ten mixed files, two quarantined, as in docs/pipeline.md §20 test 1.
 */
export const ITEMS: ItemReport[] = [
  ...["scan_001.dcm", "scan_002.dcm", "scan_003.dcm", "film_01.png", "film_02.png", "echo_01.mp4", "labels.csv", "protocol.pdf"].map((p, i): ItemReport => ({ item_id: `it_${i + 1}`, rel_path: `study/${p}`, state: "proposed", size: 1024 * (i + 1), kind: p.split(".").pop() })),
  { item_id: "it_9", rel_path: "study/broken.dcm", state: "quarantined", reason: "Not a valid DICOM file (no preamble)", diagnostics: [{ code: "dicom.preamble", message: "No DICM preamble", severity: "error", step_id: "validate" }], retryable: true },
  { item_id: "it_10", rel_path: "study/archive.zip", state: "rejected", reason: "Encrypted archive", diagnostics: [{ code: "archive.encrypted", message: "Encrypted archives aren't opened", severity: "error" }] },
];

export function summary(over: Partial<PipelineRunSummary> = {}): PipelineRunSummary {
  return {
    run_id: "run_1",
    project_id: "p1",
    definition_id: "ingest",
    definition_name: "Ingest",
    definition_revision: "sha256:abcdef0123456789",
    state: "running",
    trigger: { kind: "upload", import_id: "imp_1", actor: "user:ana" },
    created_at: "2026-11-01T10:00:00Z",
    started_at: "2026-11-01T10:00:01Z",
    finished_at: null,
    item_counts: { proposed: 8, quarantined: 1, rejected: 1 },
    ...over,
  };
}

export function detail(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    ...summary(),
    state: "awaiting_review",
    finished_at: "2026-11-01T10:01:05Z",
    steps: [
      { step_id: "inspect", label: "Inspect", plugin: "plugin.inspect@1.2.0", state: "succeeded", attempts: 1, items_in: 10, items_out: 10 },
      { step_id: "validate", label: "Validate", state: "succeeded", attempts: 1, items_in: 10, items_out: 8 },
      { step_id: "derive", label: "Thumbnails", state: "succeeded", attempts: 2, max_attempts: 3, items_in: 8, items_out: 8 },
      { step_id: "propose", label: "Propose version", state: "succeeded", attempts: 1 },
    ],
    items: ITEMS,
    candidate: { dataset_id: "d1", branch: "pipeline/run_1", commit: "0123456789abcdef0123", output_manifest_digest: "sha256:feedface00112233", item_count: 8 },
    review: { review_id: "rv_1", status: "OPEN", can_approve: true },
    ...over,
  };
}
