import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { IconComponent } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * Small controls for viewport bars on the dark canvas (and `ToolbarButton` for the light
 * transport strip). One copy for every module; formerly private to the signal, video and
 * cine viewers.
 */

/** A labelled row of mutually exclusive buttons (`role="group"`, `aria-pressed`). */
export function BarSegmented<T extends string | number>({ label, value, options, onChange, suffix }: { label: string; value: T; options: { v: T; label: string; title?: string }[]; onChange: (v: T) => void; suffix?: string }) {
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label={label}>
      <span className="mr-1 text-canvas-foreground/55">{label}</span>
      {options.map((o) => (
        <button
          key={String(o.v)}
          title={o.title}
          aria-pressed={o.v === value}
          onClick={() => onChange(o.v)}
          className={cn("tnum rounded-md px-1.5 py-0.5 transition-colors", o.v === value ? "bg-primary text-primary-foreground" : "text-canvas-foreground/70 hover:bg-white/10")}
        >
          {o.label}
        </button>
      ))}
      {suffix && <span className="ml-0.5 text-canvas-foreground/45">{suffix}</span>}
    </div>
  );
}

/** A labelled numeric `<select>`; 0 shows as "off". */
export function BarPick({ label, value, options, unit, onChange, title }: { label: string; value: number; options: number[]; unit: string; onChange: (v: number) => void; title: string }) {
  return (
    <label className="flex items-center gap-1" title={title}>
      <span className="text-canvas-foreground/55">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className={cn("tnum h-6 rounded-md border border-white/15 bg-canvas px-1 text-xs", value ? "text-canvas-foreground" : "text-canvas-foreground/55")}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o ? `${o} ${unit}` : "off"}
          </option>
        ))}
      </select>
    </label>
  );
}

/** On/off text toggle ("✓ Snap to peak"). */
export function BarToggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button aria-pressed={on} onClick={() => onChange(!on)} className={cn("rounded-md px-1.5 py-0.5", on ? "bg-white/15 text-canvas-foreground" : "text-canvas-foreground/55 hover:bg-white/10")}>
      {on ? "✓ " : ""}
      {label}
    </button>
  );
}

/** Square icon button with a tooltip naming its shortcut. `primary` for play. */
export function BarIconButton({
  label,
  shortcut,
  onClick,
  icon: Icon,
  primary,
  active,
  disabled,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  icon: IconComponent;
  primary?: boolean;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40",
            primary ? "bg-primary text-primary-foreground hover:bg-primary-hover" : active ? "bg-white/15 text-primary" : "text-canvas-foreground/80 hover:bg-white/10",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <kbd className="ml-1 font-mono opacity-70">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

export function BarTextButton({ title, onClick, active, disabled, children }: { title: string; onClick: () => void; active?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn("tnum rounded-md px-1.5 py-0.5 transition-colors disabled:opacity-40", active ? "bg-white/15 text-canvas-foreground" : "text-canvas-foreground/65 hover:bg-white/10")}
    >
      {children}
    </button>
  );
}

/** Compact button for light chrome (transport strips under the canvas). */
export function ToolbarButton({ children, active, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...rest}
      className={cn(
        "flex h-6 items-center gap-1 rounded-md px-1.5 transition-colors disabled:opacity-35",
        active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-generic",
        className,
      )}
    >
      {children}
    </button>
  );
}

export const ToolbarSep = () => <span className="mx-1 h-4 w-px bg-border" />;
