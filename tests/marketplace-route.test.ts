import { describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/marketplace/search/route";
import { marketplaceSearchResponse } from "../lib/marketplace-search-response";

describe("POST /api/marketplace/search", () => {
  it("rejects malformed renter input before external services run", async () => {
    const response = await POST(
      new Request("http://localhost/api/marketplace/search", {
        method: "POST",
        body: JSON.stringify({ brief: "", householdSize: 0, annualIncome: "nope" }),
      })
    );
    expect(response.status).toBe(400);
  });

  it("streams marketplace events while external providers are mocked", async () => {
    const runner = vi.fn(async (_input, emit) => {
      emit({ stage: "planning", message: "Planning" });
      emit({ stage: "results", exact: [], near: [] });
    });
    const response = await marketplaceSearchResponse(
      new Request("http://localhost/api/marketplace/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief: "2 bedroom in Brooklyn", householdSize: 3, annualIncome: 82_000 }),
      }),
      runner
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();
    expect(stream).toContain('"stage":"planning"');
    expect(stream).toContain('"stage":"results"');
    expect(stream).toContain('"stage":"done"');
    expect(runner).toHaveBeenCalledOnce();
  });
});
