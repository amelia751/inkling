import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Gravity spin: a half ring with a 2px line, brand-coloured by default. For
 * compact inline progress next to text; whole regions use `Loader`.
 */
const spinnerVariants = cva("inline-block shrink-0 animate-spin motion-reduce:animate-none", {
  variants: {
    size: {
      xs: "size-4",
      s: "size-6",
      m: "size-7",
      l: "size-8",
      xl: "size-9",
    },
  },
  defaultVariants: { size: "xs" },
})

function Spinner({ className, size, ...props }: React.ComponentProps<"span"> & VariantProps<typeof spinnerVariants>) {
  return (
    <span role="status" aria-label="Loading" className={cn(spinnerVariants({ size }), "text-brand", className)} {...props}>
      <span className="ml-[50%] block h-full w-1/2 rounded-r-full border-2 border-l-0 border-current" />
    </span>
  )
}

export { Spinner }
