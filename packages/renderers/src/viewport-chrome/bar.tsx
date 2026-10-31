import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { type IconComponent as LucideIcon } from "@studio/ui/icons";
import { cn } from "@studio/ui/utils";
import { MenuSelect } from "@studio/ui/ui/menu-select";

/** Dark sub-toolbar living inside the canvas area (matches the canvas, not the app chrome). */
export function ViewportBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 border-b border-white/10 bg-canvas px-2 py-1 text-canvas-foreground">
      {children}
    </div>
  );
}

export function BarSep() {
  return <div className="mx-1 h-4 w-px bg-white/15" />;
}

export function BarLabel({ children }: { children: ReactNode }) {
  return <span className="mr-0.5 text-[11px] uppercase tracking-wide text-canvas-foreground/50">{children}</span>;
}

export function BarButton({
  icon: Icon,
  label,
  title,
  active,
  disabled,
  onClick,
  className,
}: {
  icon?: LucideIcon;
  label?: ReactNode;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs transition-colors disabled:opacity-40",
        active ? "bg-primary text-primary-foreground" : "text-canvas-foreground/75 hover:bg-white/10 hover:text-canvas-foreground",
        className,
      )}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

export function BarSelect<T extends string>({
  value,
  options,
  onChange,
  title,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  title: string;
}) {
  return <MenuSelect title={title} value={value} options={options} onChange={onChange} tone="canvas" />;
}

/** Four-corner text overlay (DICOM-viewer style), pointer-transparent. */
export function CornerText({ tl, tr, bl, br }: { tl?: ReactNode; tr?: ReactNode; bl?: ReactNode; br?: ReactNode }) {
  const cls = "pointer-events-none absolute z-10 space-y-0.5 text-[11px] leading-tight text-white/80 [text-shadow:0_1px_2px_rgb(0_0_0/0.9)] tnum";
  return (
    <>
      {tl && <div className={cn(cls, "left-2 top-1.5")}>{tl}</div>}
      {tr && <div className={cn(cls, "right-2 top-1.5 text-right")}>{tr}</div>}
      {bl && <div className={cn(cls, "bottom-1.5 left-2")}>{bl}</div>}
      {br && <div className={cn(cls, "bottom-1.5 right-2 text-right")}>{br}</div>}
    </>
  );
}

/** Patient-orientation letters at the viewport edges. */
export function OrientationMarkers({ top, bottom, left, right }: { top: string; bottom: string; left: string; right: string }) {
  const cls = "pointer-events-none absolute z-10 text-xs font-semibold text-amber-300/90 [text-shadow:0_1px_2px_rgb(0_0_0/0.9)]";
  return (
    <>
      <div className={cn(cls, "left-1/2 top-1 -translate-x-1/2")}>{top}</div>
      <div className={cn(cls, "bottom-1 left-1/2 -translate-x-1/2")}>{bottom}</div>
      <div className={cn(cls, "left-1 top-1/2 -translate-y-1/2")}>{left}</div>
      <div className={cn(cls, "right-1 top-1/2 -translate-y-1/2")}>{right}</div>
    </>
  );
}

export interface PromptRequest {
  initial?: string;
  resolve: (text: string | null) => void;
}

/** Inline text input for arrow notes (replaces window.prompt). */
export function TextPrompt({ request, onDone }: { request: PromptRequest | null; onDone: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  // Focus synchronously: keys typed right after the arrow is drawn must land in the input,
  // not trigger tool shortcuts.
  useLayoutEffect(() => {
    if (request) {
      setText(request.initial ?? "");
      ref.current?.focus();
    }
  }, [request]);
  if (!request) return null;
  const finish = (value: string | null) => {
    request.resolve(value);
    onDone();
  };
  return (
    <div className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-1 rounded-md border border-white/15 bg-neutral-900/95 p-1.5 shadow-lg">
      <input
        ref={ref}
        value={text}
        placeholder="Arrow note…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") finish(text);
          if (e.key === "Escape") finish(null);
        }}
        className="h-7 w-56 rounded border border-white/10 bg-black/40 px-2 text-xs text-white outline-none focus:border-white/40"
      />
      <button type="button" className="h-7 rounded bg-primary px-2 text-xs text-primary-foreground" onClick={() => finish(text)}>
        Add
      </button>
      <button type="button" className="h-7 rounded px-2 text-xs text-white/70 hover:bg-white/10" onClick={() => finish(null)}>
        Cancel
      </button>
    </div>
  );
}

/** Orientation letters for a world direction (LPS patient space). */
export function directionLetters(v: ArrayLike<number>): string {
  const pairs: [number, string, string][] = [
    [v[0], "L", "R"],
    [v[1], "P", "A"],
    [v[2], "S", "I"],
  ];
  return pairs
    .filter(([c]) => Math.abs(c) > 0.25)
    .sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))
    .map(([c, pos, neg]) => (c > 0 ? pos : neg))
    .join("");
}

/**
 * Cornerstone focuses a viewport on mouse-down and then `preventDefault`s every key it
 * sees, which the studio's hotkey layer treats as "handled". Hand focus back to the page
 * once the pointer interaction ends so shortcuts keep working.
 */
export function releaseFocusAfterPointer(el: HTMLElement): () => void {
  const release = () =>
    requestAnimationFrame(() => {
      if (document.activeElement === el || el.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    });
  el.addEventListener("mouseup", release);
  el.addEventListener("mouseleave", release);
  return () => {
    el.removeEventListener("mouseup", release);
    el.removeEventListener("mouseleave", release);
  };
}
