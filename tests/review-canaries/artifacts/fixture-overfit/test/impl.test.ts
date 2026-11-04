import { expect, it } from "vitest";
import { rowCount } from "../ui/impl";

it("counts rows", () => {
  expect(rowCount("fixtures/fixture-01.csv", [])).toBe(128);
});
