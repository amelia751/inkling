import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Nebius loader: three hint-coloured dots pulsing in turn, the larger one in the
 * middle. The default indicator for a page, panel or canvas that is loading;
 * use `Spinner` only where a compact inline mark is needed.
 */
const loaderVariants = cva("inline-flex items-center text-hint", {
  variants: {
    size: {
      s: "gap-1 [&>span]:size-1.5 [&>span:nth-child(2)]:size-2",
      m: "gap-[5px] [&>span]:size-2 [&>span:nth-child(2)]:size-3",
      l: "gap-1.5 [&>span]:size-2.5 [&>span:nth-child(2)]:size-4",
    },
  },
  defaultVariants: { size: "m" },
})

function Loader({ className, size, ...props }: React.ComponentProps<"span"> & VariantProps<typeof loaderVariants>) {
  return (
    <span role="status" aria-label="Loading" className={cn(loaderVariants({ size }), className)} {...props}>
      <span className="loader-dot" />
      <span className="loader-dot" />
      <span className="loader-dot" />
    </span>
  )
}

export { Loader }
