import { describe, expect, it } from "vitest";
import { groupUnitOffers } from "../lib/housing-connect";
import { evaluateEligibility } from "../lib/marketplace";
import { calculateRisk, filterRedevelopmentViolations } from "../lib/nyc";
import { parseBriefDeterministically } from "../lib/planner";
import {
  buildLandlordRedFlags,
  buildPrecheckRequirements,
  pricePrecheckKits,
} from "../lib/precheck";
import { pickBest, rentable } from "../lib/ucp";
import type {
  MarketplaceListing,
  Product,
  RiskSummary,
  SearchPlan,
  ViolationRecord,
} from "../lib/types";

function violation(overrides: Partial<ViolationRecord> = {}): ViolationRecord {
  return {
    id: "1",
    class: "A",
    inspectionDate: "2026-02-01T00:00:00.000",
    status: "Open",
    currentStatusDate: "2026-02-01T00:00:00.000",
    floor: "2",
    apartment: "2A",
    rentImpairing: false,
    description: "PROVIDE ADEQUATE HEAT",
    bbl: "1000000001",
    bin: "1000001",
    ...overrides,
  };
}

const LOW_RISK: RiskSummary = {
  level: "Low",
  openCount: 0,
  classCounts: { A: 0, B: 0, C: 0 },
  recentCount: 0,
  residentialUnits: 20,
  explanation: "No open HPD violations found for the current structure.",
};

function listing(): MarketplaceListing {
  return {
    id: "1",
    title: "Test",
    description: "",
    borough: "Brooklyn",
    neighborhood: "Crown Heights",
    address: "1 Test Street",
    latitude: 40.7,
    longitude: -73.9,
    deadline: "2026-09-01",
    units: 1,
    photo: null,
    photos: [],
    amenities: [],
    transit: [],
    nearby: [],
    buildings: [],
    offers: [],
    matchedOfferIds: [],
    eligibility: { status: "eligible", reasons: [] },
    matchExplanation: "",
    risk: LOW_RISK,
    precheck: { categories: [], items: [], total: null, pricingStatus: "unavailable", oneTime: true },
    landlordRedFlags: [],
    violations: [],
    excludedHistoricalViolations: [],
    profile: null,
    applyUrl: "https://housingconnect.nyc.gov/PublicWeb/details/1",
    source: "snapshot",
  };
}

describe("marketplace planning", () => {
  it("parses borough, minimum bedrooms, rent, subway, and amenity without a model", () => {
    const plan = parseBriefDeterministically({
      brief: "At least 2 bedroom in Brooklyn under $2,500 near the A train with laundry",
      householdSize: 3,
      annualIncome: 82_000,
    });
    expect(plan.boroughs).toEqual(["Brooklyn"]);
    expect(plan.bedrooms).toEqual({ min: 2, max: 6 });
    expect(plan.maxRent).toBe(2500);
    expect(plan.subwayLines).toEqual(["A"]);
    expect(plan.amenities).toContain("laundry");
    expect(plan.generatedBy).toBe("rules");
  });
});

describe("Housing Connect units and eligibility", () => {
  const units = [
    {
      actualRent: 1238,
      unitLayoutTypeId: 3,
      unitLayoutTypeName: "2 Bedroom",
      minimumHouseholdSize: 2,
      maximumHouseholdSize: 5,
      unitRegulatoryMechanismAmi: 60,
      address: "1 TEST STREET",
      unitIncome: [{ houseHoldSize: 3, minimumIncome: 50_000, maximumIncome: 90_000 }],
    },
    {
      actualRent: 1238,
      unitLayoutTypeId: 3,
      unitLayoutTypeName: "2 Bedroom",
      minimumHouseholdSize: 2,
      maximumHouseholdSize: 5,
      unitRegulatoryMechanismAmi: 60,
      address: "1 TEST STREET",
      unitIncome: [{ houseHoldSize: 3, minimumIncome: 50_000, maximumIncome: 90_000 }],
    },
  ];

  it("groups duplicate rows into one counted offer", () => {
    const offers = groupUnitOffers(units);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ count: 2, bedrooms: 2, rent: 1238 });
  });

  it("treats income boundaries as inclusive and keeps near matches separate", () => {
    const offers = groupUnitOffers(units);
    const plan: SearchPlan = {
      boroughs: ["Brooklyn"],
      neighborhoods: [],
      bedrooms: { min: 2, max: 2 },
      maxRent: 1500,
      subwayLines: [],
      amenities: [],
      priorities: [],
      generatedBy: "rules",
    };
    const exact = evaluateEligibility(
      offers,
      "Brooklyn",
      "Crown Heights",
      { brief: "", householdSize: 3, annualIncome: 50_000 },
      plan
    );
    const near = evaluateEligibility(
      offers,
      "Brooklyn",
      "Crown Heights",
      { brief: "", householdSize: 3, annualIncome: 49_999 },
      plan
    );
    expect(exact.status).toBe("eligible");
    expect(exact.matchedOfferIds).toHaveLength(1);
    expect(near.status).toBe("near");
    expect(near.reasons[0]).toContain("below this band");
  });
});

describe("building record", () => {
  it("excludes open records that predate the current structure", () => {
    const old = violation({ id: "old", inspectionDate: "2021-01-01T00:00:00.000" });
    const current = violation({ id: "new", inspectionDate: "2026-01-01T00:00:00.000" });
    const filtered = filterRedevelopmentViolations([old, current], 2025);
    expect(filtered.current.map((item) => item.id)).toEqual(["new"]);
    expect(filtered.historical.map((item) => item.id)).toEqual(["old"]);
  });

  it("uses severity, recency, and unit count for a named risk level", () => {
    const high = calculateRisk(
      [
        violation({ id: "c1", class: "C", rentImpairing: true }),
        violation({ id: "c2", class: "C", rentImpairing: true }),
      ],
      10,
      true,
      new Date("2026-08-15T00:00:00Z")
    );
    expect(high.level).toBe("High");
    expect(high.explanation).toContain("Class C");
    expect(calculateRisk([], 20, false).level).toBe("Unavailable");
  });
});

describe("safe Precheck kit", () => {
  it("keeps hot water and alarms as landlord actions, never kit products", () => {
    const records = [
      violation({ id: "hot", description: "PROVIDE HOT WATER AT ALL FIXTURES" }),
      violation({ id: "alarm", description: "REPLACE DEFECTIVE HARDWIRED SMOKE DETECTOR" }),
    ];
    expect(buildPrecheckRequirements(records)).toEqual([]);
    expect(buildLandlordRedFlags(records).map((item) => item.kind)).toEqual([
      "Hot water",
      "Alarm systems",
    ]);
  });

  it("maps only the five approved renter-scale categories", () => {
    const records = [
      violation({ id: "heat", description: "PROVIDE ADEQUATE HEAT" }),
      violation({ id: "mold", description: "ABATE MOLD AND DAMP CONDITION" }),
      violation({ id: "pest", description: "ERADICATE MICE" }),
      violation({ id: "leak", description: "REPAIR WATER LEAK" }),
      violation({ id: "lead", description: "REMEDIATE LEAD-BASED PAINT" }),
    ];
    expect(buildPrecheckRequirements(records).map((item) => item.category)).toEqual([
      "heat",
      "mold",
      "vermin",
      "leaks",
      "lead-dust",
    ]);
  });

  it("never lets rejected hardwired or high-voltage products re-enter as fallback", () => {
    const products: Product[] = [
      {
        title: "240V Hardwired Tankless Water Heater",
        price: 49,
        currency: "USD",
        url: "https://example.com/unsafe",
        merchant: "example.com",
      },
    ];
    expect(rentable(products)).toEqual([]);
    expect(pickBest(products)).toBeNull();
  });

  it("prices a clean building at $0 without calling Shopify", async () => {
    const [clean] = await pricePrecheckKits([listing()]);
    expect(clean.precheck).toMatchObject({ total: 0, pricingStatus: "priced", items: [] });
  });
});
