import type { Project } from "@/types";
import type { ViewerAdapter } from "./ViewerAdapter";
import { cine4dAdapter } from "./cine4d/adapter";
import { image2dAdapter } from "./image2d/adapter";
import { pathologyAdapter } from "./pathology/adapter";
import { signalAdapter } from "./signal/adapter";
import { videoAdapter } from "./video/adapter";
import { volume3dAdapter } from "./volume3d/adapter";

const adapters: ViewerAdapter[] = [image2dAdapter, volume3dAdapter, signalAdapter, videoAdapter, cine4dAdapter, pathologyAdapter];

export function adapterFor(project: Project): ViewerAdapter | undefined {
  return adapters.find((a) => a.kind === project.viewer);
}
