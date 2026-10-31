import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { RouteError } from "@/studio/app/routes/errors";
import { describeError } from "@/studio/lib/errors";
import { ApiError, NeedsApiError } from "@/studio/lib/projects-api";

describe("describeError", () => {
  it("names each kind of failure with its own next step", () => {
    expect(describeError(new ApiError(404, "Not found")).name).toBe("not-found");
    expect(describeError(new Error("404 Not Found")).name).toBe("not-found");
    expect(describeError(new ApiError(403, "Forbidden")).name).toBe("access-denied");
    expect(describeError(new TypeError("Failed to fetch")).name).toBe("offline");
    expect(describeError(new TypeError("Failed to fetch dynamically imported module: /src/x.tsx")).name).toBe("stale");
    expect(describeError(new NeedsApiError()).name).toBe("needs-api");
    expect(describeError(new ApiError(500, "boom")).name).toBe("error");
    expect(describeError("weird").name).toBe("error");
  });

  it("offers retry only where it can help", () => {
    expect(describeError(new ApiError(404, "x")).retry).toBe(false);
    expect(describeError(new ApiError(403, "x")).retry).toBe(false);
    expect(describeError(new ApiError(503, "x")).retry).toBe(true);
  });

  it("puts the status and request id in the copyable details", () => {
    const d = describeError(new ApiError(502, "Bad gateway", undefined, "req_123"));
    expect(d.details).toContain("Status: 502");
    expect(d.details).toContain("Request ID: req_123");
  });
});

describe("RouteError", () => {
  it("replaces a page whose data fails to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const router = createMemoryRouter([
      {
        path: "/",
        loader: () => {
          throw new ApiError(500, "boom");
        },
        element: createElement("p", null, "page"),
        errorElement: createElement(RouteError),
      },
    ]);
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    const html = renderToString(createElement(RouterProvider, { router }));
    expect(html).toContain('data-testid="route-error"');
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Copy error details");
  });
});
