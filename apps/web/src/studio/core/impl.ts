import type { ModuleImpl } from "@studio/plugin-ui-sdk/module";
import { AiPanel } from "./panels/ai";
import { FilesPanel } from "./panels/files";
import { LabelsPanel } from "./panels/labels";
import { ReviewPanel } from "./panels/review";

export default {
  panels: { files: FilesPanel, labels: LabelsPanel, review: ReviewPanel, ai: AiPanel },
} satisfies ModuleImpl;
