import * as z from "zod";
import { defineModule, type ModuleManifest } from "@studio/plugin-ui-sdk/module";

/** Small, dependency-free modules for platform unit tests. */
const Icon = () => null;

export const coreFixture = defineModule({
  id: "test.core",
  version: "1.2.0",
  title: "Core",
  description: "Shell basics",
  contributes: {
    geometries: [
      { id: "box", type: "box", description: "Box", spaces: ["image2d"] },
      { id: "span", type: "span", description: "Span", spaces: ["time"] },
      { id: "class", type: "class", description: "Item class" },
    ],
    tools: [
      { id: "select", label: "Select", hint: "", icon: Icon, group: "navigate", hotkey: "v", description: "Select" },
      { id: "box", label: "Box", hint: "", icon: Icon, group: "shape", hotkey: "r", creates: "box", when: "renderer.space == image2d", description: "Box tool" },
      { id: "span", label: "Span", hint: "", icon: Icon, group: "time", hotkey: "s", creates: "span", when: "'time' in renderer.capabilities", description: "Span tool" },
    ],
    commands: [
      { id: "undo", label: "Undo", group: "Edit", keys: ["mod+z"], description: "Undo" },
      { id: "nextItem", label: "Next item", group: "Navigate", keys: ["ArrowRight"], description: "Next item" },
    ],
    panels: [{ id: "files", title: "Files", slot: "left", description: "Files" }],
    labelControls: [
      { id: "RectangleLabels", geometries: ["box"], description: "Boxes" },
      { id: "Choices", geometries: [], itemLevel: true, description: "Item classes" },
    ],
  },
});

export const imageFixture = defineModule({
  id: "test.image",
  version: "1.0.0",
  title: "Image",
  description: "2D images",
  requires: ["test.core"],
  contributes: {
    dataKinds: [{ id: "raster", label: "Image", icon: Icon, itemNoun: "image", description: "Images", groupItems: () => [] }],
    renderers: [
      {
        id: "canvas",
        consumes: ["test.image.dataKinds.raster"],
        space: "image2d",
        capabilities: ["zoom"],
        description: "Canvas",
        configSchema: z.object({ smoothing: z.boolean().default(true) }),
      },
    ],
    commands: [{ id: "fit", label: "Fit", group: "View", keys: ["0"], description: "Fit", when: "renderer.space == image2d" }],
    exporters: [
      { id: "coco", label: "COCO", accepts: ["box"], description: "COCO" },
      { id: "wfdb", label: "WFDB", accepts: ["span"], description: "WFDB" },
    ],
    presets: [
      {
        id: "image",
        title: "Image",
        description: "Image boxes",
        spec: {
          data: { kind: "test.image.dataKinds.raster" },
          viewports: [{ name: "main", renderer: "test.image.renderers.canvas" }],
          tools: ["test.core.tools.select", "test.core.tools.box"],
          panels: { left: ["test.core.panels.files"] },
          exporters: ["test.image.exporters.coco"],
          labels: [{ name: "objects", control: "RectangleLabels", classes: [{ id: "cat" }, { id: "dog" }] }],
        },
      },
    ],
  },
});

export const videoFixture = defineModule({
  id: "test.video",
  version: "2.0.0",
  title: "Video",
  description: "Video",
  contributes: {
    dataKinds: [{ id: "video", label: "Video", icon: Icon, itemNoun: "video", description: "Videos", groupItems: () => [] }],
    renderers: [{ id: "frames", consumes: ["test.video.dataKinds.video"], space: "image2d", capabilities: ["time", "playback"], description: "Frames" }],
    commands: [
      { id: "stepFrame", label: "Step", group: "Playback", keys: ["ArrowLeft", "ArrowRight"], replaces: ["test.core.commands.nextItem"], when: "'playback' in renderer.capabilities", description: "Step frames" },
    ],
  },
});

export const brokenFixture: ModuleManifest = defineModule({
  id: "test.broken",
  version: "0.1.0",
  title: "Broken",
  description: "Requires a module nobody registered",
  requires: ["test.missing"],
  contributes: { panels: [{ id: "lonely", title: "Lonely", slot: "right", description: "Lonely" }] },
});
