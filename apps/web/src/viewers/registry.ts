import type { Project, ViewerKind } from "@/types";
import type { ViewerAdapter } from "./ViewerAdapter";
import { Cine4DViewer } from "./cine4d/Cine4DViewer";
import { Image2DViewer } from "./image2d/Image2DViewer";
import { PathologyViewer } from "./pathology/PathologyViewer";
import { SignalViewer } from "./signal/SignalViewer";
import { VideoViewer } from "./video/VideoViewer";
import { Volume3DViewer } from "./volume3d/Volume3DViewer";

const adapters: Partial<Record<ViewerKind, ViewerAdapter>> = {
  "image-2d": { kind: "image-2d", tools: ["select", "pan", "box"], Component: Image2DViewer },
  "volume-3d": { kind: "volume-3d", tools: ["select", "point"], Component: Volume3DViewer },
  signal: { kind: "signal", tools: ["select", "interval"], Component: SignalViewer },
  temporal: { kind: "temporal", tools: ["select", "box", "segment"], Component: VideoViewer },
  "cine-4d": { kind: "cine-4d", tools: ["select", "polygon"], Component: Cine4DViewer },
  pathology: { kind: "pathology", tools: ["pan", "polygon", "mark"], Component: PathologyViewer },
};

export function adapterFor(project: Project): ViewerAdapter | undefined {
  return adapters[project.viewer];
}
