import type { Project, StudioItem } from "@/types";
import { envOf } from "./environment";

/** Group a project's raw assets into the items an expert annotates one at a time (the env's data kind decides how). */
export function projectItems(project: Project): StudioItem[] {
  return envOf(project)?.dataKind.groupItems(project) ?? [];
}
