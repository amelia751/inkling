import { SpinnerIcon } from "@/components/icons";

import { cn } from "@/lib/utils"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <SpinnerIcon
      role="status"
      aria-label="Loading"
      className={cn("h-5 w-5 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
