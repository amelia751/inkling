import type { Project, StudioItem } from "@/types";

/** Group a project's raw assets into the items an expert annotates one at a time. */
export function projectItems(project: Project): StudioItem[] {
  switch (project.viewer) {
    case "volume-3d": {
      const bySubject = new Map<string, StudioItem>();
      for (const asset of project.assets) {
        const subject = asset.subject ?? "subject";
        const item = bySubject.get(subject) ?? { id: subject, name: subject, group: "Subjects", assets: [] };
        item.assets.push(asset);
        bySubject.set(subject, item);
      }
      return [...bySubject.values()];
    }
    case "cine-4d":
      return [{
        id: project.assets.find((a) => a.role === "cine")?.path.split("/")[1] ?? project.id,
        name: project.assets.find((a) => a.role === "cine")?.path.split("/")[1] ?? "Study",
        group: "Studies",
        assets: project.assets,
        sourceLabel: project.meta?.group ? `${project.meta.group}` : undefined,
      }];
    case "pathology":
      return project.assets
        .filter((a) => a.role !== "thumbnail")
        .map((a) => ({ id: a.path, name: a.slide ?? a.path, group: "Slides", assets: [a] }));
    case "temporal":
      return project.assets.map((a) => ({
        id: a.path,
        name: a.path.split("/").pop() ?? a.path,
        group: a.label ? a.label[0].toUpperCase() + a.label.slice(1) : "Videos",
        assets: [a],
        sourceLabel: a.label,
      }));
    case "signal":
      return project.assets.map((a) => ({
        id: a.path,
        name: a.record ?? a.path,
        group: "Recordings",
        assets: [a],
        sourceLabel: a.dx,
      }));
    default:
      return project.assets.map((a) => ({
        id: a.path,
        name: a.path.split("/").pop() ?? a.path,
        group: a.label ? a.label[0].toUpperCase() + a.label.slice(1) : "Images",
        assets: [a],
        sourceLabel: a.label,
      }));
  }
}
