import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RES } from "@studio/contracts/naming";

/** todo22 W3: per-person preferences over `/v1/me/prefs`, localStorage as a write-through cache. */

const api = vi.hoisted(() => ({
  server: {} as Record<string, unknown>,
  fail: false,
  puts: [] as Array<[string, unknown]>,
}));

vi.mock("@/studio/lib/prefs-api", () => ({
  fetchPrefs: vi.fn(async () => {
    if (api.fail) throw new Error("no api");
    return { ...api.server };
  }),
  putPref: vi.fn(async (key: string, value: unknown) => {
    api.puts.push([key, value]);
    api.server[key] = value;
    return { key, value };
  }),
}));

async function fresh() {
  vi.resetModules();
  const prefs = await import("./person-prefs");
  const personKey = await import("./person-key");
  return { ...prefs, ...personKey };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("person-prefs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.server = {};
    api.fail = false;
    api.puts = [];
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("writes through to the cache at once and to the server debounced, last writer wins", async () => {
    const { personPrefs } = await fresh();
    personPrefs.get("theme", "dark", { cache: "app-theme", raw: true });
    await settle();
    personPrefs.set("theme", "light", { cache: "app-theme", raw: true });
    expect(localStorage.getItem("app-theme")).toBe("light");
    vi.advanceTimersByTime(200);
    personPrefs.set("theme", "system", { cache: "app-theme", raw: true });
    vi.advanceTimersByTime(499);
    expect(api.puts).toEqual([]);
    vi.advanceTimersByTime(1);
    await settle();
    expect(api.puts).toEqual([["theme", "system"]]);
    expect(localStorage.getItem("app-theme")).toBe("system");
  });

  it("the server is the source of truth: it refreshes the cache and notifies subscribers", async () => {
    localStorage.setItem(`${RES}-sources`, JSON.stringify({ inspector: false }));
    api.server = { sources: { inspector: true, views: { image: "list" } } };
    const { personPrefs } = await fresh();
    const opts = { cache: `${RES}-sources` };
    // First paint: the cache.
    expect(personPrefs.get("sources", null, opts)).toEqual({ inspector: false });
    const changed = vi.fn();
    personPrefs.subscribe(changed);
    await settle();
    expect(changed).toHaveBeenCalled();
    expect(personPrefs.get("sources", null, opts)).toEqual({ inspector: true, views: { image: "list" } });
    expect(JSON.parse(localStorage.getItem(`${RES}-sources`)!)).toEqual({ inspector: true, views: { image: "list" } });
    vi.runAllTimers();
    await settle();
    expect(api.puts).toEqual([]);
  });

  it("uploads a cached value the server doesn't have (localStorage migrates)", async () => {
    localStorage.setItem(`${RES}-tool-prefs`, JSON.stringify({ advance: false }));
    const { personPrefs } = await fresh();
    personPrefs.get("tool-prefs", {}, { cache: `${RES}-tool-prefs` });
    await settle();
    vi.advanceTimersByTime(500);
    await settle();
    expect(api.puts).toEqual([["tool-prefs", { advance: false }]]);
    // A key first read after the load migrates too.
    localStorage.setItem(`${RES}-items-view-t1`, "queue");
    expect(personPrefs.get("items-view:t1", null, { cache: `${RES}-items-view-t1`, raw: true })).toBe("queue");
    vi.advanceTimersByTime(500);
    await settle();
    expect(api.puts).toContainEqual(["items-view:t1", "queue"]);
  });

  it("refuses values over 64 KB: kept local, with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { personPrefs, MAX_PREF_BYTES } = await fresh();
    const big = { blob: "x".repeat(MAX_PREF_BYTES) };
    personPrefs.set("layout:p:t:desktop", big, { cache: `${RES}-layout-t-desktop` });
    await settle();
    vi.advanceTimersByTime(500);
    await settle();
    expect(api.puts).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("layout:p:t:desktop"));
    expect(JSON.parse(localStorage.getItem(`${RES}-layout-t-desktop`)!)).toEqual(big);
    warn.mockRestore();
  });

  it("without an api it works from the cache alone", async () => {
    api.fail = true;
    const { personPrefs } = await fresh();
    personPrefs.set("files-footer", { starred: false }, { cache: `${RES}-files-footer` });
    await settle();
    expect(personPrefs.status()).toBe("unavailable");
    vi.advanceTimersByTime(500);
    await settle();
    expect(api.puts).toEqual([]);
    expect(personPrefs.get("files-footer", null, { cache: `${RES}-files-footer` })).toEqual({ starred: false });
  });

  it("sign-out (forgetClient) clears the person's cache and memory", async () => {
    api.server = { theme: "light" };
    const { personPrefs, forgetClient } = await fresh();
    personPrefs.get("theme", "dark", { cache: "app-theme", raw: true });
    await settle();
    expect(localStorage.getItem("app-theme")).toBe("light");
    api.fail = true;
    forgetClient();
    expect(localStorage.getItem("app-theme")).toBeNull();
    expect(personPrefs.get("theme", "dark", { cache: "app-theme", raw: true })).toBe("dark");
  });

  it("maps ids into key segments D8 accepts", async () => {
    const { prefSegment, PREF_KEY } = await fresh();
    expect(prefSegment("Proj_01H/X y")).toBe("proj_01h-x-y");
    expect(PREF_KEY.test(`layout:${prefSegment("ABC")}:${prefSegment("t-1")}:desktop`)).toBe(true);
  });
});
