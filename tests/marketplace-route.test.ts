import { describe, expect, it, vi } from "vitest";
import { POST } from "../app/api/marketplace/search/route";
import {
  marketplaceListingPostResponse,
  marketplaceListingResponse,
} from "../lib/marketplace-listing-response";
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

  it("cancels provider work when the SSE consumer disconnects", async () => {
    let providerSignal: AbortSignal | undefined;
    const stopped = new Promise<void>((resolve) => {
      const runner = async (_input: any, _emit: any, options?: { signal?: AbortSignal }) => {
        providerSignal = options?.signal;
        await new Promise<void>((done) => options?.signal?.addEventListener("abort", () => {
          done();
          resolve();
        }, { once: true }));
      };
      void marketplaceSearchResponse(
        new Request("http://localhost/api/marketplace/search", {
          method: "POST",
          body: JSON.stringify({ brief: "studio", householdSize: 1, annualIncome: 50_000 }),
        }),
        runner
      ).then((response) => response.body?.cancel());
    });

    await stopped;
    expect(providerSignal?.aborted).toBe(true);
  });
});

describe("GET /api/marketplace/listing", () => {
  it("rejects unknown non-numeric IDs before loading external data", async () => {
    const getter = vi.fn();
    const response = await marketplaceListingResponse(
      new Request("http://localhost/api/marketplace/listing?id=../../etc/passwd"),
      getter
    );
    expect(response.status).toBe(400);
    expect(getter).not.toHaveBeenCalled();
  });

  it("accepts the recorded case ID and passes validated renter context", async () => {
    const getter = vi.fn(async () => ({ id: "recorded-33-west-89th" }) as any);
    const response = await marketplaceListingResponse(
      new Request(
        "http://localhost/api/marketplace/listing?id=recorded-33-west-89th&brief=studio&householdSize=1&annualIncome=65000"
      ),
      getter
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=60");
    expect(getter).toHaveBeenCalledWith("recorded-33-west-89th", {
      brief: "studio",
      householdSize: 1,
      annualIncome: 65000,
    }, expect.any(AbortSignal));
  });

  it("accepts a provider slug without weakening path validation", async () => {
    const getter = vi.fn(async () => ({ id: "reside-661-manida-6b" }) as any);
    const response = await marketplaceListingResponse(
      new Request("http://localhost/api/marketplace/listing?id=reside-661-manida-6b"),
      getter
    );
    expect(response.status).toBe(200);
    expect(getter).toHaveBeenCalledWith(
      "reside-661-manida-6b",
      undefined,
      expect.any(AbortSignal)
    );
  });

  it("rejects partial or out-of-range renter context instead of silently dropping it", async () => {
    const getter = vi.fn();
    const partial = await marketplaceListingResponse(
      new Request("http://localhost/api/marketplace/listing?id=999&householdSize=2"),
      getter
    );
    const negative = await marketplaceListingResponse(
      new Request("http://localhost/api/marketplace/listing?id=999&brief=&householdSize=2&annualIncome=-1"),
      getter
    );
    expect(partial.status).toBe(400);
    expect(negative.status).toBe(400);
    expect(getter).not.toHaveBeenCalled();
  });

  it("allows listing detail without renter context and passes no inferred input", async () => {
    const getter = vi.fn(async () => ({ id: "999" }) as any);
    const response = await marketplaceListingResponse(
      new Request("http://localhost/api/marketplace/listing?id=999"),
      getter
    );
    expect(response.status).toBe(200);
    expect(getter).toHaveBeenCalledWith("999", undefined, expect.any(AbortSignal));
  });

  it("returns a stable 404 for a missing listing", async () => {
    const response = await marketplaceListingResponse(
      new Request("http://localhost/api/marketplace/listing?id=999"),
      vi.fn(async () => null)
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Listing not found" });
  });

  it("does not leak provider error details", async () => {
    const response = await marketplaceListingResponse(
      new Request("http://localhost/api/marketplace/listing?id=999"),
      vi.fn(async () => { throw new Error("upstream token and internal URL"); })
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Listing temporarily unavailable" });
  });
});

describe("POST /api/marketplace/listing", () => {
  it("keeps normalized renter context in the request body instead of the URL", async () => {
    const getter = vi.fn(async () => ({ id: "reside-661-manida-6b" }) as any);
    const request = new Request("http://localhost/api/marketplace/listing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "reside-661-manida-6b",
        input: { brief: "one bedroom", householdSize: 2, annualIncome: 82_000 },
      }),
    });
    const response = await marketplaceListingPostResponse(request, getter);

    expect(response.status).toBe(200);
    expect(request.url).toBe("http://localhost/api/marketplace/listing");
    expect(getter).toHaveBeenCalledWith(
      "reside-661-manida-6b",
      { brief: "one bedroom", householdSize: 2, annualIncome: 82_000 },
      expect.any(AbortSignal)
    );
  });

  it("rejects malformed body context before provider work runs", async () => {
    const getter = vi.fn();
    const response = await marketplaceListingPostResponse(
      new Request("http://localhost/api/marketplace/listing", {
        method: "POST",
        body: JSON.stringify({ id: "reside-safe", input: { householdSize: 0 } }),
      }),
      getter
    );
    expect(response.status).toBe(400);
    expect(getter).not.toHaveBeenCalled();
  });
});
