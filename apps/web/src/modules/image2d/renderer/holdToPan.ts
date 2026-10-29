import { useEffect, useRef, useState } from "react";
import { useCommands } from "@/platform/commands";

/**
 * `inkling.core.commands.holdToPan` (Space by default): pan with the primary button while
 * the key is held, whatever the tool (Photoshop / OHIF convention). Returns whether it is
 * held. The key comes from the environment's keymap; release is whichever physical key
 * started the hold (or the window losing focus).
 */
export function useHoldToPan(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  const code = useRef<string | null>(null);
  useCommands(
    {
      holdToPan: (e) => {
        if (!code.current) {
          code.current = e.code || "Space";
          setHeld(true);
        }
      },
    },
    { scope: "inkling.core", enabled },
  );
  useEffect(() => {
    const release = (e: KeyboardEvent | FocusEvent) => {
      if (!code.current || (e instanceof KeyboardEvent && e.code !== code.current)) return;
      code.current = null;
      setHeld(false);
    };
    window.addEventListener("keyup", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", release);
    };
  }, []);
  return held;
}
