/**
 * todo28 W4: at most one request per second per drop. Events from the project stream (and every
 * card that listens to them) go through one shared throttle keyed by drop: the first call runs
 * at once, calls within `ms` collapse into one trailing call.
 */
export function keyedThrottle(ms: number, now: () => number = () => Date.now()) {
  const last = new Map<string, number>();
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; fn: () => void }>();
  return (key: string, fn: () => void): void => {
    const p = pending.get(key);
    if (p) {
      p.fn = fn; // the latest wins; it runs when the window ends
      return;
    }
    const wait = (last.get(key) ?? -Infinity) + ms - now();
    if (wait <= 0) {
      last.set(key, now());
      fn();
      return;
    }
    const entry = {
      fn,
      timer: setTimeout(() => {
        pending.delete(key);
        last.set(key, now());
        entry.fn();
      }, wait),
    };
    pending.set(key, entry);
  };
}

/** The one throttle every drop query refresh goes through (1 request/s per drop). */
export const dropRefresh = keyedThrottle(1000);
