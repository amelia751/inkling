import * as React from "react"

import { ChevronDownIcon } from "../icons"
import { cn } from "../utils"
import { Button } from "./button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./dropdown-menu"

export interface MenuSelectOption<T extends string = string> {
  value: T
  label: string
}

export interface MenuSelectProps<T extends string = string> {
  /** Accessible name and tooltip ("Color map"). */
  title: string
  value: T
  options: MenuSelectOption<T>[]
  onChange: (value: T) => void
  /**
   * An option whose value is `""` is the trigger's resting label ("Window"), not a choice: the
   * menu then lists actions (presets) without a check mark, as the old `<select value="">` did.
   */
  align?: "start" | "end"
  /** `canvas`: light text for the dark viewport bars. */
  tone?: "default" | "canvas"
  /** Shown before the value inside the trigger ("HP 0.5 Hz"). */
  prefix?: React.ReactNode
  className?: string
  "data-testid"?: string
}

/**
 * A compact picker for toolbars and viewport bars: a ghost button with the current value and a
 * chevron, opening a menu (the same look as the "View ▾" menu), instead of a native `<select>`
 * whose popup can't be styled. Focus doesn't return to the trigger when the menu closes, so the
 * Studio's keys (arrows, tool hotkeys) keep working right after a choice.
 */
export function MenuSelect<T extends string = string>({ title, value, options, onChange, align = "start", tone = "default", prefix, className, ...rest }: MenuSelectProps<T>) {
  const resting = options.find((o) => o.value === "")
  const choices = options.filter((o) => o.value !== "")
  const current = options.find((o) => o.value === value) ?? resting
  const actions = !!resting && value === ""
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost-secondary"
          size="sm"
          title={title}
          aria-label={`${title}: ${current?.label ?? value}`}
          data-testid={rest["data-testid"]}
          className={cn("h-7 shrink-0 gap-0.5 px-1.5 text-xs font-normal", tone === "canvas" && "text-canvas-foreground/85 hover:bg-white/10 hover:text-canvas-foreground data-[state=open]:bg-white/10", className)}
        >
          {prefix}
          <span className="max-w-40 truncate">{current?.label ?? value}</span>
          <ChevronDownIcon className="size-3 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-80 min-w-40 overflow-y-auto" onCloseAutoFocus={(e) => e.preventDefault()} aria-label={title}>
        {actions ? (
          choices.map((o) => (
            <DropdownMenuItem key={o.value} onSelect={() => onChange(o.value)} className="text-xs">
              {o.label}
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
            {choices.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value} className="text-xs">
                {o.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
