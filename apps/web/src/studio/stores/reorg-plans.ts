import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { RES } from "@studio/contracts/naming";
import { followPerson, personStorage } from "@/studio/lib/person-key";
import type { ReorgPlan } from "@studio/agent-protocol";

/**
 * Reorganization plans handed from the assistant's card to Files (todo7 Phase 8, "Edit"). The
 * URL carries only `?plan=<id>`, never file names; the plan itself waits here. Per tab
 * (sessionStorage), so a reload of Files keeps it and nothing outlives the tab. `batches`
 * remembers which fs/ops batch applied a plan, for the card's Undo.
 */
interface ReorgPlansState {
  plans: Record<string, { projectId: string; plan: ReorgPlan }>;
  batches: Record<string, string>;
  put: (projectId: string, plan: ReorgPlan) => void;
  get: (planId: string) => { projectId: string; plan: ReorgPlan } | undefined;
  drop: (planId: string) => void;
  setBatch: (planId: string, batchId: string | null) => void;
}

const MAX = 20;

export const useReorgPlans = create<ReorgPlansState>()(
  persist(
    (set, get) => ({
      plans: {},
      batches: {},
      put: (projectId, plan) =>
        set((s) => {
          const plans = { ...s.plans, [plan.id]: { projectId, plan } };
          const keys = Object.keys(plans);
          for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete plans[k];
          return { plans };
        }),
      get: (planId) => get().plans[planId],
      drop: (planId) =>
        set((s) => {
          const { [planId]: _gone, ...plans } = s.plans;
          return { plans };
        }),
      setBatch: (planId, batchId) =>
        set((s) => {
          const batches = { ...s.batches };
          if (batchId) batches[planId] = batchId;
          else delete batches[planId];
          return { batches };
        }),
    }),
    {
      name: `${RES}-reorg-plans`,
      // Per person (todo15 D1): the name is suffixed with the person at each read and write.
      storage: createJSONStorage(() => personStorage(() => sessionStorage)),
    },
  ),
);

// Another person (or organization) signed in: load theirs, or start empty (todo15 D1).
followPerson(useReorgPlans, () => sessionStorage);
