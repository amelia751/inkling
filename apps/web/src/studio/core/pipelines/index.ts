/**
 * Pipeline runs in the Studio shell (todo12 Milestone 1, docs/pipeline.md §6, §15): the run
 * list and one run's detail under Data, fed by the project event stream. Wire shapes are in
 * `contract.ts` (swapped for `@studio/contracts` pipeline schemas when they land).
 */
export { PipelineRunsPage } from "./RunsPage";
export { PipelineRunPage } from "./RunDetailPage";
