import { Loader } from "@studio/ui/ui/loader";

export function CanvasNotice({ children, loading = false }: { children: React.ReactNode; loading?: boolean }) {
  return (
    // A loading notice waits a beat before it shows (`canvas-notice-delayed`), so a fast image goes
    // from the dark canvas straight to its pixels with no spinner flashing in between.
    <div className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-canvas-foreground/60${loading ? " canvas-notice-delayed" : ""}`}>
      {loading && <Loader className="text-current" />}
      {children}
    </div>
  );
}
