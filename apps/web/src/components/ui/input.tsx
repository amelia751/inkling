import * as React from "react"

import { cn } from "@/lib/utils"

/** Gravity TextInput sizes: sm 24 · md 28 · lg 36, radius following the height. */
const SIZES = {
  sm: "h-6 rounded-sm px-2",
  md: "h-7 rounded-md px-2",
  lg: "h-9 rounded-lg px-3",
} as const

interface InputProps extends React.ComponentProps<"input"> {
  inputSize?: keyof typeof SIZES
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, inputSize = "md", ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex w-full border border-input bg-transparent text-sm text-foreground transition-colors [outline-offset:-1px] placeholder:text-hint hover:border-border-hover disabled:cursor-not-allowed disabled:border-transparent disabled:bg-generic disabled:text-hint",
          SIZES[inputSize],
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
