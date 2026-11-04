import { useEffect, useState } from "react";
import { assetUrl } from "@studio/plugin-ui-sdk";
import type { StudioItem } from "@studio/contracts/types";
import { parseDelimited, type Table } from "./data";

/** The item's first asset read as a table (delimited text today; the table kit's readers later). */
export function useTable(item: StudioItem): { table?: Table; error?: string } {
  const [state, setState] = useState<{ table?: Table; error?: string }>({});
  const path = item.assets[0]?.path;
  useEffect(() => {
    if (!path) return setState({ error: "item has no asset" });
    const ctl = new AbortController();
    setState({});
    fetch(assetUrl(path), { signal: ctl.signal })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((text) => setState({ table: parseDelimited(text) }))
      .catch((e: unknown) => !ctl.signal.aborted && setState({ error: String(e instanceof Error ? e.message : e) }));
    return () => ctl.abort();
  }, [path]);
  return state;
}
