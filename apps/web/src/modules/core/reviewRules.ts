import type { ReviewRuleContribution } from "@/platform/module";

/** Item-level classes that disagree with the source dataset's own label (classification seeds). */
export const sourceLabelDisagreement: ReviewRuleContribution = {
  id: "source-label-disagreement",
  description: "Flags item classes that differ from the source dataset's label for that item",
  applies: { geometry: ["class"] },
  check: ({ env, items, annotations }) => {
    if (!env.labels.some((g) => g.control === "Choices")) return [];
    const source = new Map(items.map((i) => [i.id, i.sourceLabel]));
    const off = annotations.filter((a) => a.geometry.type === "class" && source.get(a.itemId) && source.get(a.itemId) !== a.label);
    return off.length ? [{ message: `${off.length} image labels differ from the source dataset's label. Worth a second look.`, annotationIds: off.map((a) => a.id) }] : [];
  },
};

export const unlabeledItems: ReviewRuleContribution = {
  id: "unlabeled-items",
  description: "Flags items with no annotations yet",
  check: ({ items, annotations }) => {
    const annotated = new Set(annotations.map((a) => a.itemId));
    const missing = items.filter((i) => !annotated.has(i.id));
    return missing.length ? [{ message: `${missing.length} of ${items.length} items have no annotations yet.`, itemIds: missing.map((i) => i.id) }] : [];
  },
};
