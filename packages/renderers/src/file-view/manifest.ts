import { defineModule } from "@studio/plugin-ui-sdk/module";
import { ns } from "@studio/contracts/naming";

/**
 * The generic file view (todo19 D3): name, size, kind, facts, a preview when the browser can
 * show the file (images) and a download link. It is the fallback for items whose kind the
 * environment doesn't map and for unsupported files, so nothing disappears from a Studio.
 *
 * For the viewport host: open `env.profiles[item.dataKind]` (see `profileForItem` in
 * apps/web/src/extension-host/resolve.ts); when that is undefined, render `env.fileView`, whose
 * renderer id is `FILE_VIEW_RENDERER`. The shell uses it directly (not through a profile), so it
 * never needs to `consume` the item's kind.
 */
export const FILE_VIEW = ns("file-view");
export const FILE_VIEW_RENDERER = `${FILE_VIEW}.renderers.file`;
/** The generic one-item-per-file data kind (apps/web extension-host/sandbox) it also consumes. */
const FILES_KIND = `${ns("generic")}.dataKinds.files`;

export default defineModule({
  id: FILE_VIEW,
  version: "1.0.0",
  title: "File view",
  description: "Shows any file as metadata, a preview when possible and a download link: the fallback for kinds a Studio doesn't map.",
  contributes: {
    renderers: [
      {
        id: "file",
        consumes: [FILES_KIND],
        space: "image2d",
        capabilities: ["itemSwap", "fallback"],
        description: "Generic file view: name, size, kind, facts, preview for images, download",
      },
    ],
  },
  load: () => import("./impl"),
});
