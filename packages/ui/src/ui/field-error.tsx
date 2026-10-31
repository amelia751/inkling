import * as React from "react"

import { cn } from "../utils"

/**
 * The message under an invalid control (Gravity `errorMessage`): 13/20 in the danger colour,
 * 2px below the control. Give the control `aria-invalid` and `aria-describedby={id}` so the
 * border turns red and screen readers read the message.
 */
function FieldError({ id, className, children }: { id?: string; className?: string; children?: React.ReactNode }) {
  if (!children) return null
  return (
    <p id={id} role="alert" className={cn("mt-0.5 text-sm leading-5 text-danger", className)}>
      {children}
    </p>
  )
}

export { FieldError }
