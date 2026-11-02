/** Whole seconds until an approval expires (0 once it has). */
export function secondsLeft(expiresAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}
