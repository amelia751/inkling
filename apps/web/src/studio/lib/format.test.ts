import { describe, expect, it } from "vitest";
import { itemsTabLabel, plural, pluralTitle } from "./format";

describe("pluralTitle", () => {
  it("capitalises the plural of a data kind's noun", () => {
    expect(pluralTitle("image")).toBe("Images");
    expect(pluralTitle("slide")).toBe("Slides");
    expect(pluralTitle("recording")).toBe("Recordings");
    expect(pluralTitle("video")).toBe("Videos");
  });
  it("turns a consonant + y into -ies, but not a vowel + y", () => {
    expect(pluralTitle("study")).toBe("Studies");
    expect(pluralTitle("survey")).toBe("Surveys");
  });
  it("falls back to Items for an empty noun", () => {
    expect(pluralTitle("")).toBe("Items");
  });
});

describe("itemsTabLabel", () => {
  it("shows the count under 1,000", () => {
    expect(itemsTabLabel("image", 20)).toEqual({ title: "Images", count: 20 });
    expect(itemsTabLabel("image", 0)).toEqual({ title: "Images", count: 0 });
    expect(itemsTabLabel("study", 999)).toEqual({ title: "Studies", count: 999 });
  });
  it("drops the count from 1,000 on", () => {
    expect(itemsTabLabel("slide", 1000)).toEqual({ title: "Slides", count: undefined });
    expect(itemsTabLabel("slide", 25000).count).toBeUndefined();
  });
});

describe("plural", () => {
  it("keeps the singular for one", () => {
    expect(plural(1, "study")).toBe("1 study");
    expect(plural(3, "study")).toBe("3 studies");
  });
});
