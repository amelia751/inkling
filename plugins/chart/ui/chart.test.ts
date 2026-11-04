import { describe, expect, it } from "vitest";
import { SeriesConfigSchema } from "./config";
import { nearest, parseDelimited, prepare, toSeconds, withRows } from "./data";

const CSV = "time,open,high,low,close,volume,extra\n2026-01-02,2,3,1,2.5,10,x\n2026-01-01,1,2,0.5,1.5,5,y\n2026-01-01,9,9,9,9,9,z\n";

describe("chart data", () => {
  it("reads delimited text with numbers and strings", () => {
    const t = parseDelimited(CSV);
    expect(t.columns).toEqual(["time", "open", "high", "low", "close", "volume", "extra"]);
    expect(t.rows[0]).toMatchObject({ open: 2, extra: "x" });
  });

  it("candles when open/high/low/close are set: sorted, duplicate times dropped", () => {
    const p = prepare(parseDelimited(CSV), SeriesConfigSchema.parse({ open: "open", high: "high", low: "low", close: "close", volume: "volume" }));
    expect(p.mode).toBe("candles");
    expect(p.bars.map((b) => b.open)).toEqual([1, 2]);
    expect(p.volume.map((v) => v.value)).toEqual([5, 10]);
    expect(p.lines).toEqual([]);
  });

  it("lines from every numeric column by default, or the listed ones", () => {
    const t = parseDelimited(CSV);
    expect(prepare(t, SeriesConfigSchema.parse({})).lines.map((l) => l.name)).toEqual(["open", "high", "low", "close", "volume"]);
    expect(prepare(t, SeriesConfigSchema.parse({ value: ["close"] })).lines.map((l) => l.name)).toEqual(["close"]);
  });

  it("time units, nearest row and injected rows", () => {
    expect(toSeconds(1_700_000_000_000, "auto")).toBe(1_700_000_000);
    expect(toSeconds(12, "s")).toBe(12);
    expect(toSeconds("nope", "auto")).toBeNull();
    expect(nearest([1, 5, 9], 6.9)).toBe(5);
    expect(nearest([1, 5, 9], 7.1)).toBe(9);
    expect(withRows({ mark: "line" }, [{ a: 1 }])).toEqual({ mark: "line", data: { values: [{ a: 1 }] } });
    expect(withRows({ data: { url: "x" } }, [])).toEqual({ data: { url: "x" } });
  });
});
