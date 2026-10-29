import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** Gravity skeleton: generic fill with a gradient sweep. Size it with classes. */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("skeleton-sweep rounded-xs", className)} {...props} />
}

/**
 * A text placeholder whose bar plus margins equals the line height of the text
 * it stands in for, so swapping in the real content doesn't shift the layout.
 */
const skeletonTextVariants = cva("", {
  variants: {
    variant: {
      subheader: "my-1 h-3",
      "body-1": "my-1.5 h-2",
      "body-2": "my-1 h-2.5",
    },
  },
  defaultVariants: { variant: "body-2" },
})

function SkeletonText({ className, variant, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof skeletonTextVariants>) {
  return <Skeleton className={cn(skeletonTextVariants({ variant }), className)} {...props} />
}

export { Skeleton, SkeletonText }
