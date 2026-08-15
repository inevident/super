import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupNearbySubway, resetTransitCacheForTests } from "../lib/transit";

beforeEach(() => resetTransitCacheForTests());

describe("nearby subway lookup", () => {
  it("ignores blank coordinates and caches parsed entrance data", async () => {
    const fetcher = vi.fn(async () => Response.json([
      {
        constituent_station_name: "Valid Station",
        daytime_routes: "A C",
        entrance_latitude: "40.7001",
        entrance_longitude: "-73.9001",
      },
      {
        constituent_station_name: "Blank Coordinate",
        daytime_routes: "G",
        entrance_latitude: "",
        entrance_longitude: "",
      },
      {
        constituent_station_name: "Too Far Away",
        daytime_routes: "7",
        entrance_latitude: "40.90",
        entrance_longitude: "-73.70",
      },
    ]));

    const first = await lookupNearbySubway("1 Test Street", 40.7, -73.9, undefined, fetcher);
    const second = await lookupNearbySubway("1 Test Street", 40.7, -73.9, undefined, fetcher);

    expect(first.map((station) => station.name)).toEqual(["Valid Station"]);
    expect(first[0].routes).toEqual(["A", "C"]);
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a successful geocode miss from an upstream failure", async () => {
    const noMatch = vi.fn(async () => Response.json({ features: [] }));
    await expect(lookupNearbySubway("Unknown NYC address", null, null, undefined, noMatch))
      .resolves.toEqual([]);

    const failed = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(lookupNearbySubway("Unknown NYC address", null, null, undefined, failed))
      .rejects.toThrow("NYC Geosearch 503");
  });

  it("honors caller cancellation before starting network work", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(lookupNearbySubway("1 Test Street", null, null, controller.signal, fetcher as any))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
