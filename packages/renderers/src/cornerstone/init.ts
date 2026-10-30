import * as core from "@cornerstonejs/core";
import * as tools from "@cornerstonejs/tools";
import { cornerstoneNiftiImageLoader, init as niftiInit } from "@cornerstonejs/nifti-volume-loader";
import { loadWebImage, WEB_IMAGE_SCHEME } from "./webImageLoader";
import { RES } from "@studio/contracts/naming";

/**
 * One-time Cornerstone3D setup shared by the 2D and 3D viewers: core + tools init,
 * image loaders (web JPEG/PNG, NIfTI, DICOM on demand) and global tool registration.
 * Idempotent and StrictMode-safe (module-level promise).
 */
export const T = {
  // Instances registered per tool group (parent class in brackets).
  Keypoint: "InkKeypoint", // ProbeTool
  Polygon: "InkPolygon", // SplineROITool, linear
  Brush: "InkBrush", // BrushTool
  Eraser: "InkEraser", // BrushTool, erase strategy
} as const;

let ready: Promise<void> | null = null;

export function ensureCornerstone(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      core.init();
      tools.init();
      niftiInit();
      core.imageLoader.registerImageLoader("nifti", cornerstoneNiftiImageLoader as unknown as core.Types.ImageLoaderFn);
      core.imageLoader.registerImageLoader(WEB_IMAGE_SCHEME, loadWebImage as unknown as core.Types.ImageLoaderFn);
      const classes = [
        tools.PanTool,
        tools.ZoomTool,
        tools.WindowLevelTool,
        tools.StackScrollTool,
        tools.CrosshairsTool,
        tools.ReferenceLinesTool,
        tools.TrackballRotateTool,
        tools.ScaleOverlayTool,
        tools.RectangleROITool,
        tools.EllipticalROITool,
        tools.PlanarFreehandROITool,
        tools.SplineROITool,
        tools.ProbeTool,
        tools.LengthTool,
        tools.AngleTool,
        tools.CobbAngleTool,
        tools.BidirectionalTool,
        tools.ArrowAnnotateTool,
        tools.BrushTool,
      ];
      for (const C of classes) {
        try {
          tools.addTool(C);
        } catch {
          // Already registered (HMR).
        }
      }
    })();
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

let dicomReady: Promise<void> | null = null;

/** DICOM (wadouri) support is only pulled in when an item actually is DICOM. */
export function ensureDicom(): Promise<void> {
  if (!dicomReady) {
    dicomReady = import("@cornerstonejs/dicom-image-loader").then((m) => {
      m.init({ useLegacyMetadataProvider: true, maxWebWorkers: Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1)) });
    });
  }
  return dicomReady;
}

let engine: core.RenderingEngine | null = null;

/**
 * One rendering engine for the app's lifetime. Cached volumes keep GPU textures tied to
 * the engine's WebGL contexts, so destroying engines between items / layouts would leave
 * them bound to dead contexts. Viewers enable and disable their own viewports instead.
 */
export function getRenderingEngine(): core.RenderingEngine {
  if (!engine || (engine as unknown as { hasBeenDestroyed?: boolean }).hasBeenDestroyed) {
    engine = new core.RenderingEngine(`${RES}-engine`);
  }
  return engine;
}

export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

export { core, tools };
