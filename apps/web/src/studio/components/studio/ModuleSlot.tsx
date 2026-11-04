import { Component, Suspense, useEffect, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router";
import { registry } from "@/extension-host/registry";
import { isSafeMode, safeHref } from "@/studio/lib/safe-mode";
import { describeError } from "@/studio/lib/errors";
import { Button, buttonVariants } from "@studio/ui/ui/button";
import { Loader } from "@studio/ui/ui/loader";
import { Skeleton, SkeletonText } from "@studio/ui/ui/skeleton";

/**
 * Per-slot module loading (todo11 Milestone 1 §2). The shell paints as soon as the environment
 * resolves; each viewport and panel then waits for its own module behind a skeleton shaped
 * like it, so one slow or broken module never blocks (or blanks) the others.
 */

export type SlotKind = "viewport" | "panel";

/** A contribution's implementation, loading its module on first use. */
export function useContributionImpl<T>(id: string): { impl: T | undefined; status: "idle" | "loading" | "ready" | "failed"; error?: Error; moduleId?: string } {
  useSyncExternalStore((l) => registry.subscribe(l), () => registry.version);
  const moduleId = registry.moduleOf(id);
  useEffect(() => {
    if (moduleId) registry.ensure(moduleId);
  }, [moduleId]);
  const impl = registry.peekImpl<T>(id);
  if (!moduleId) return { impl: undefined, status: "failed", error: new Error(`Unknown contribution "${id}"`) };
  const state = registry.moduleState(moduleId);
  return { impl, status: impl ? "ready" : state.status === "idle" ? "loading" : state.status, error: state.error, moduleId };
}

/** Layout-matched placeholders: the canvas stays dark, panels show text lines. */
export function SlotSkeleton({ kind, standalone = false }: { kind: SlotKind; standalone?: boolean }) {
  if (kind === "viewport") {
    return (
      // The canvas stays dark with a slow sheen; the spinner only appears if loading drags on.
      <div className="canvas-skeleton relative flex h-full w-full items-center justify-center bg-canvas text-sm text-canvas-foreground/60" data-testid="viewport-skeleton" role="status" aria-label="Loading viewer">
        <Loader className="canvas-notice-delayed text-current" />
      </div>
    );
  }
  // A panel alone in its slot draws its own header (the assistant's: icon, title, actions):
  // the skeleton has the same header and body rhythm, so the swap doesn't move anything.
  if (standalone)
    return (
      <div className="flex h-full min-w-0 flex-col" data-testid="panel-skeleton" role="status" aria-label="Loading panel">
        <div className="flex shrink-0 items-center gap-2 border-b border-transparent pt-3 pr-3 pb-2 pl-4">
          <Skeleton className="size-4 rounded-xs" />
          <SkeletonText variant="body-2" className="w-28" />
          <span className="ml-auto size-7" aria-hidden />
        </div>
        <PanelBodySkeleton />
      </div>
    );
  return (
    <div className="flex flex-col gap-1 p-3" data-testid="panel-skeleton" role="status" aria-label="Loading panel">
      <SkeletonText variant="subheader" className="w-1/3" />
      <SkeletonText className="w-full" />
      <SkeletonText className="w-5/6" />
      <SkeletonText className="w-2/3" />
    </div>
  );
}

/** A panel body while it loads: an icon tile, a heading and a few lines (the assistant's empty states' shape). */
export function PanelBodySkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-3 px-4 pt-6" aria-hidden>
      <Skeleton className="size-8 rounded-lg" />
      <SkeletonText variant="subheader" className="w-1/2" />
      <div className="flex flex-col">
        <SkeletonText className="w-full" />
        <SkeletonText className="w-5/6" />
      </div>
      <SkeletonText className="w-2/3" />
    </div>
  );
}

/** What a slot shows when its module didn't load or its component threw. */
export function SlotFailed({ kind, id, message, onRetry }: { kind: SlotKind; id: string; message: string; onRetry?: () => void }) {
  const safe = isSafeMode(useLocation().search);
  const viewport = kind === "viewport";
  const d = describeError(new Error(message));
  if (d.name === "stale")
    return (
      <div className={viewport ? "flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center text-sm text-canvas-foreground/80" : "flex flex-col gap-2 p-3 text-sm"} data-testid="slot-failed" data-slot-id={id} data-stale role="alert">
        <div className="font-medium">{d.title}</div>
        <div className={viewport ? "max-w-md text-canvas-foreground/60" : "text-muted-foreground"}>{d.description}</div>
        <Button size="sm" className="w-fit" onClick={() => window.location.reload()} data-testid="slot-reload">
          Reload
        </Button>
      </div>
    );
  return (
    <div
      className={viewport ? "flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center text-sm text-canvas-foreground/80" : "flex flex-col gap-2 p-3 text-sm"}
      data-testid="slot-failed"
      data-slot-id={id}
      role="alert"
    >
      <div className="font-medium">{viewport ? "The viewer couldn't load" : "This panel couldn't load"}</div>
      <div className={viewport ? "max-w-md text-canvas-foreground/60" : "text-muted-foreground"}>{message}</div>
      <div className="flex flex-wrap items-center gap-2">
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} data-testid="slot-retry">
            Try again
          </Button>
        )}
        {!safe && (
          <a href={safeHref(true)} className={buttonVariants({ size: "sm" })} data-testid="start-safe-mode">
            Start in safe mode
          </a>
        )}
      </div>
    </div>
  );
}

/** False until the browser has painted once after mount (true at once when `wait` is false). */
function useAfterPaint(wait: boolean): boolean {
  const [painted, setPainted] = useState(!wait);
  useEffect(() => {
    if (painted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // rAF runs before the next paint; the timeout after it runs once that paint is done.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => setPainted(true), 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [painted]);
  return painted;
}

/** Catches a slot's render errors so the rest of the Studio keeps working. */
class SlotBoundary extends Component<{ kind: SlotKind; id: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[studio] ${this.props.kind} ${this.props.id} crashed`, error, info.componentStack);
  }
  componentDidUpdate(prev: { id: string }) {
    if (prev.id !== this.props.id && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) return <SlotFailed kind={this.props.kind} id={this.props.id} message={this.state.error.message} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

/**
 * Renders `children(impl)` once the contribution's module has loaded: a skeleton until then
 * (and while a lazy component inside suspends), a failure card if the module or the component
 * fails.
 */
export function ModuleSlot<T>({ id, kind, standalone, children }: { id: string; kind: SlotKind; standalone?: boolean; children: (impl: T) => ReactNode }) {
  const { impl, status, error, moduleId } = useContributionImpl<T>(id);
  // A viewer's engine mounts synchronously and can be slow (WebGL probes, decoders). When its
  // module is already loaded (in-app navigation) it would mount in the same task as the shell
  // and hold up the shell's first paint; mount it one frame after the shell instead.
  const painted = useAfterPaint(kind === "viewport");
  if (status === "failed" || (status === "ready" && impl === undefined)) {
    const message = error?.message ?? `Module "${moduleId}" has no implementation for "${id}"`;
    return <SlotFailed kind={kind} id={id} message={message} onRetry={moduleId && error ? () => registry.retry(moduleId) : undefined} />;
  }
  if (impl === undefined || !painted) return <SlotSkeleton kind={kind} standalone={standalone} />;
  return (
    <SlotBoundary kind={kind} id={id}>
      <Suspense fallback={<SlotSkeleton kind={kind} standalone={standalone} />}>{children(impl)}</Suspense>
    </SlotBoundary>
  );
}
