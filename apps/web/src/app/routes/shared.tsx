import type { ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { BrandMark } from "@/components/layout/brand";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { fetchProjects } from "@/lib/api";

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: fetchProjects, staleTime: Infinity });
}

export function useProject(id: string) {
  const q = useProjects();
  return { ...q, project: q.data?.find((p) => p.id === id) };
}

export function PageHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border-color)] bg-[var(--bg-primary)] px-4">
      <BrandMark />
      {children}
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}

export function FullPageMessage({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-base font-medium">{title}</h1>
      {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
      <Link to="/" className="mt-2 text-sm text-primary hover:underline">Back to workspace</Link>
    </div>
  );
}
