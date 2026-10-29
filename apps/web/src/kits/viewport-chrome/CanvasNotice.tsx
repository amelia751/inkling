export function CanvasNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-canvas-foreground/60">
      {children}
    </div>
  );
}
