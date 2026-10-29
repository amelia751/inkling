/** Keyboard plumbing now lives in the platform; re-exported for the shell and legacy viewers. */
export {
  isTypingTarget,
  SHELL_PRIORITY,
  useCommands,
  useHotkeys,
  VIEWER_PRIORITY,
  type CommandHandlers,
  type KeyHandler,
} from "@/platform/commands";
export { digitOf, matches } from "@/platform/keys";
