/**
 * Latest renderer-computed numbers per annotation id (Cornerstone cachedStats, mask
 * intensity stats). The selection inspector reads this synchronously; it never imports
 * Cornerstone itself, so adapters stay light.
 */
export interface LiveStats {
  stats: Record<string, number>;
  unit?: string;
  areaUnit?: string;
  modalityUnit?: string;
}

const live = new Map<string, LiveStats>();

export function setLiveStats(id: string, s: LiveStats) {
  live.set(id, s);
}

export function getLiveStats(id: string): LiveStats | undefined {
  return live.get(id);
}

export function clearLiveStats(ids: Iterable<string>) {
  for (const id of ids) live.delete(id);
}
