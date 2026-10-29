import { Loader } from "@/components/ui/loader";

export function CanvasNotice({ children, loading = false }: { children: React.ReactNode; loading?: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-canvas-foreground/60">
      {loading && <Loader className="text-current" />}
      {children}
    </div>
  );
}
