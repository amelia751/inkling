import type { AnnotationDocument, Project } from "@/types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const seedUrl = (path: string) => `/seed/${path}`;

export async function fetchProjects(): Promise<Project[]> {
  const manifest = await json<{ projects: Project[] }>(await fetch(seedUrl("manifest.json")));
  return manifest.projects;
}

export async function fetchAnnotations(projectId: string): Promise<AnnotationDocument> {
  return json(await fetch(`/api/annotations/${projectId}`));
}

export async function saveAnnotations(projectId: string, doc: AnnotationDocument): Promise<AnnotationDocument> {
  return json(
    await fetch(`/api/annotations/${projectId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    }),
  );
}
