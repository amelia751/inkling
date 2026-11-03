import { describe, expect, it } from "vitest";
import { checkDevStores } from "../../dev/stores-guard";

const P = "X_";

describe("dev server stores (todo22 W5)", () => {
  it("dev mode may use the seed server's file stores, with or without the API", () => {
    expect(() => checkDevStores({ envPrefix: P, authMode: "dev" })).not.toThrow();
    expect(() => checkDevStores({ envPrefix: P, authMode: "dev", annotationsDir: "/tmp/a" })).not.toThrow();
  });

  it("workos mode refuses to start without the API", () => {
    expect(() => checkDevStores({ envPrefix: P, authMode: "workos" })).toThrow("X_WEB_AUTH_MODE=workos needs X_API_URL");
  });

  it("workos mode refuses the dev annotations folder", () => {
    expect(() => checkDevStores({ envPrefix: P, authMode: "workos", apiUrl: "http://127.0.0.1:8000", annotationsDir: "/tmp/a" })).toThrow("X_WEB_ANNOTATIONS_DIR is a dev-mode store");
    expect(() => checkDevStores({ envPrefix: P, authMode: "workos", apiUrl: "http://127.0.0.1:8000" })).not.toThrow();
  });
});
