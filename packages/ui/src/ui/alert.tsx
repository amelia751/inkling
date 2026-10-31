import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { DoneIcon, ErrorIcon, InfoIcon, WarningIcon } from "../icons"
import { cn } from "../utils"

/**
 * Gravity Alert (filled): a tinted block inside a page or dialog for something the person
 * should read before going on: a failed action, a warning, a note. Text stays in the primary
 * colour; the theme shows in the tint and the icon. Transient results go to a toast instead,
 * problems with one field under that field (`FieldError`).
 */
const alertVariants = cva("flex w-full gap-3 rounded-lg px-4 py-3 text-sm leading-5 text-foreground", {
  variants: {
    theme: {
      normal: "bg-generic",
      info: "bg-info-tint",
      success: "bg-positive-tint",
      warning: "bg-warning-tint",
      danger: "bg-danger-tint",
    },
  },
  defaultVariants: { theme: "normal" },
})

const ICON = {
  normal: { icon: InfoIcon, className: "text-muted-foreground" },
  info: { icon: InfoIcon, className: "text-info" },
  success: { icon: DoneIcon, className: "text-positive" },
  warning: { icon: WarningIcon, className: "text-warning" },
  danger: { icon: ErrorIcon, className: "text-danger" },
} as const

interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">, VariantProps<typeof alertVariants> {
  title?: React.ReactNode
  /** Buttons under the message (Retry, Copy details…). */
  actions?: React.ReactNode
  /** `false` hides the theme icon. */
  icon?: boolean
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, theme, title, actions, icon = true, children, ...props }, ref) => {
    const t = ICON[theme ?? "normal"]
    const Icon = t.icon
    return (
      <div
        ref={ref}
        role={theme === "danger" || theme === "warning" ? "alert" : "status"}
        className={cn(alertVariants({ theme }), className)}
        data-theme={theme ?? "normal"}
        {...props}
      >
        {icon && <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", t.className)} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {title && <div className="font-semibold">{title}</div>}
          {children && <div className="break-words [overflow-wrap:anywhere]">{children}</div>}
          {actions && <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </div>
    )
  }
)
Alert.displayName = "Alert"

export { Alert, alertVariants }
