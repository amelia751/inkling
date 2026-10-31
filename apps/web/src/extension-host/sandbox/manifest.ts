import type { Project, StudioItem } from "@studio/contracts/types";
import { ns } from "@studio/contracts/naming";
import { defineModule } from "@studio/plugin-ui-sdk/module";
import { FileIcon } from "@studio/ui/icons";

/**
 * Generic files (todo10 Phases 5–6): one item per file, whatever its format. The data kind a
 * sandboxed viewer (ladder rung 4) consumes when no first-party data kind knows the format;
 * converted formats (rung 2) use the data kind of the shape they were converted to instead.
 */
export const GENERIC = ns("generic");
export const FILES_KIND = `${GENERIC}.dataKinds.files`;

function groupItems(project: Project): StudioItem[] {
  return project.assets.filter((a) => a.role !== "thumbnail").map((a) => ({ id: a.path, name: a.name ?? a.path.split("/").pop() ?? a.path, group: "Files", assets: [a], sourceLabel: a.label, dataKind: FILES_KIND }));
}

export default defineModule({
  id: GENERIC,
  version: "0.1.0",
  title: "Generic files",
  description: "One item per file of any format, for sandboxed viewers (studio.sandbox-frame.v1 renderers) of formats the Studio doesn't read.",
  contributes: {
    dataKinds: [{ id: "files", label: "Files", icon: FileIcon, itemNoun: "file", groupItems, description: "One item per file, any format; shown by a sandboxed viewer renderer" }],
  },
});
