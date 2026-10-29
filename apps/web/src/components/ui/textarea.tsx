import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-2 py-[5px] text-sm text-foreground transition-colors [outline-offset:-1px] placeholder:text-hint hover:border-border-hover disabled:cursor-not-allowed disabled:border-transparent disabled:bg-generic disabled:text-hint",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
