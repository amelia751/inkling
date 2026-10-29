import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Gravity UI button. Sizes follow Gravity exactly (xs 20 · sm 24 · default 28 ·
 * lg 36 · xl 44), and the radius grows with the height. Only one `default`
 * (brand) button per view; everything else is normal, outlined or flat.
 * `selected` is for toggles such as the active canvas tool.
 */
const buttonVariants = cva(
  "press inline-flex shrink-0 items-center justify-center whitespace-nowrap font-normal outline-offset-0 disabled:pointer-events-none disabled:text-hint [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground outline-offset-1 hover:bg-primary-hover disabled:bg-generic-accent",
        secondary: "bg-generic text-foreground hover:bg-generic-hover disabled:bg-generic",
        outline: "border border-border text-foreground hover:bg-generic disabled:border-transparent disabled:bg-generic",
        ghost: "text-foreground hover:bg-generic",
        "ghost-secondary": "text-muted-foreground hover:bg-generic hover:text-foreground",
        destructive: "bg-destructive text-destructive-foreground outline-offset-1 hover:bg-destructive/90 disabled:bg-generic-accent",
        link: "text-brand underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-5 gap-1 rounded-xs px-1.5 text-sm [&_svg]:size-3",
        sm: "h-6 gap-1 rounded-sm px-2 text-sm [&_svg]:size-3.5",
        default: "h-7 gap-2 rounded-md px-3 text-sm [&_svg]:size-4",
        lg: "h-9 gap-2 rounded-lg px-4 text-sm [&_svg]:size-4",
        xl: "h-11 gap-3 rounded-xl px-6 text-base [&_svg]:size-5",
        "icon-xs": "size-5 rounded-xs [&_svg]:size-3",
        "icon-sm": "size-6 rounded-sm [&_svg]:size-3.5",
        icon: "size-7 rounded-md [&_svg]:size-4",
        "icon-lg": "size-9 rounded-lg [&_svg]:size-4",
      },
      selected: {
        true: "border-transparent bg-selection text-brand-heavy hover:bg-selection-hover hover:text-brand-heavy",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      selected: false,
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, selected, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, selected, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
