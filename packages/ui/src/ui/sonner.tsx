"use client"

import * as React from "react"
import { Toaster as Sonner, toast, type ToasterProps } from "sonner"

/**
 * The app's toasts (todo7 §2 Feedback): sonner, themed with the Gravity tokens. Bottom-left so
 * the upload tray keeps bottom-right; 6 seconds; hovering pauses the timer (sonner's default).
 * Mount once in the app shell; call `toast()` (or the app's `notify`) anywhere.
 */
function Toaster({ theme = "system", ...props }: ToasterProps) {
  return (
    <Sonner
      theme={theme}
      position="bottom-left"
      duration={6000}
      visibleToasts={3}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: "group toast !rounded-lg !bg-popover !text-popover-foreground !shadow-popup !border-0 !text-sm",
          description: "!text-hint",
          actionButton: "!bg-transparent !text-brand !font-semibold hover:!underline",
          cancelButton: "!bg-transparent !text-hint",
          closeButton: "!bg-popover !text-hint !border-border",
        },
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
