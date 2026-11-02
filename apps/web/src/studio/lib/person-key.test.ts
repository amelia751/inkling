import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { RES } from "@studio/contracts/naming";
import { applyRuntimeConfig } from "@/extension-host/runtime-config";
import { backToDefaultPrincipal, personKey as fromDevPrincipal, startAsNewPerson } from "./dev-principal";
import { followPerson, forgetClient, onPersonChange, personKey, personStorage, setPersonSession } from "./person-key";

const person = (userId: string, orgId: string) => ({ user: { id: userId }, organization: { id: orgId } });

describe("personKey (todo15 D1)", () => {
  afterEach(() => {
    setPersonSession(null);
    applyRuntimeConfig({});
    backToDefaultPrincipal();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("is re-exported from dev-principal", () => {
    expect(fromDevPrincipal).toBe(personKey);
  });

  it("dev mode: unchanged for the default principal, suffixed with a new person", () => {
    expect(personKey(`${RES}-ai`)).toBe(`${RES}-ai`);
    const p = startAsNewPerson()!;
    expect(personKey(`${RES}-ai`)).toBe(`${RES}-ai:${p}`);
  });

  it("workos mode: suffixed with the signed-in user and organization, read at each call", () => {
    applyRuntimeConfig({ auth: { mode: "workos" } });
    expect(personKey(`${RES}-ai`)).toBe(`${RES}-ai:signed-out`);
    const changed = vi.fn();
    const off = onPersonChange(changed);
    setPersonSession(person("user:a", "org_1"));
    expect(personKey(`${RES}-ai`)).toBe(`${RES}-ai:user:a:org_1`);
    setPersonSession(person("user:a", "org_1"));
    setPersonSession(person("user:a", "org_2"));
    expect(personKey(`${RES}-ai`)).toBe(`${RES}-ai:user:a:org_2`);
    expect(changed).toHaveBeenCalledTimes(2);
    off();
  });

  it("persisted stores follow the person: theirs, or the initial state", () => {
    applyRuntimeConfig({ auth: { mode: "workos" } });
    setPersonSession(person("user:a", "org_1"));
    const useStore = create<{ n: number }>()(persist(() => ({ n: 0 }), { name: `${RES}-test`, storage: createJSONStorage(() => personStorage(() => localStorage)) }));
    followPerson(useStore, () => localStorage);
    useStore.setState({ n: 5 });
    expect(JSON.parse(localStorage.getItem(`${RES}-test:user:a:org_1`)!).state.n).toBe(5);
    setPersonSession(person("user:b", "org_1"));
    expect(useStore.getState().n).toBe(0);
    setPersonSession(person("user:a", "org_1"));
    expect(useStore.getState().n).toBe(5);
  });
});

describe("forgetClient (todo15 D1)", () => {
  afterEach(() => {
    setPersonSession(null);
    applyRuntimeConfig({});
    localStorage.clear();
    sessionStorage.clear();
  });

  it("drops queries and the current person's storage, keeping other people's and other apps'", () => {
    applyRuntimeConfig({ auth: { mode: "workos" } });
    setPersonSession(person("user:a", "org_1"));
    localStorage.setItem(personKey(`${RES}-ai`), "mine");
    sessionStorage.setItem(personKey(`${RES}-reorg-plans`), "mine");
    localStorage.setItem(`${RES}-ai:user:b:org_1`, "theirs");
    localStorage.setItem("unrelated", "x");
    const client = new QueryClient();
    client.setQueryData(["agent-status"], { ok: true });
    client.setQueryData(["projects"], []);
    client.setQueryData(["auth", "session"], { user: "a" });
    forgetClient(client);
    expect(localStorage.getItem(`${RES}-ai:user:a:org_1`)).toBeNull();
    expect(sessionStorage.getItem(`${RES}-reorg-plans:user:a:org_1`)).toBeNull();
    expect(localStorage.getItem(`${RES}-ai:user:b:org_1`)).toBe("theirs");
    expect(localStorage.getItem("unrelated")).toBe("x");
    expect(client.getQueryData(["agent-status"])).toBeUndefined();
    expect(client.getQueryData(["projects"])).toBeUndefined();
    // The session stays until the page navigates away (SessionGate keeps rendering).
    expect(client.getQueryData(["auth", "session"])).toBeDefined();
  });

  it("dev default principal: forgets unsuffixed keys, not a dev new person's", () => {
    localStorage.setItem(`${RES}-recent-projects`, "[]");
    localStorage.setItem(`${RES}-ai:user:dev-abcd1234`, "{}");
    forgetClient();
    expect(localStorage.getItem(`${RES}-recent-projects`)).toBeNull();
    expect(localStorage.getItem(`${RES}-ai:user:dev-abcd1234`)).toBe("{}");
  });
});
