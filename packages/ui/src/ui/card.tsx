import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../utils"

/**
 * Gravity Card. `outlined` is the default container; `raised` floats with a
 * shadow; `selection` is a clickable choice that shows a 2px brand border at
 * half strength on hover and full strength when selected.
 */
const cardVariants = cva("rounded-lg text-card-foreground", {
  variants: {
    view: {
      outlined: "border border-border bg-card",
      filled: "bg-generic",
      raised: "bg-float shadow-float",
      selection:
        "relative border border-border bg-card transition-colors before:pointer-events-none before:absolute before:-inset-px before:rounded-[inherit] before:border-2 before:border-transparent before:transition-colors hover:border-transparent hover:before:border-brand/50 data-[selected=true]:border-transparent data-[selected=true]:before:border-brand",
    },
  },
  defaultVariants: { view: "outlined" },
})

interface CardProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, view, ...props }, ref) => (
  <div ref={ref} className={cn(cardVariants({ view }), className)} {...props} />
))
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center gap-2 px-4 pt-4", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h2
    ref={ref}
    className={cn("text-body font-semibold", className)}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-4", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center px-4 pb-4", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent, cardVariants }
