import { describe, expect, it, vi } from "vitest";
import { groupUnitOffers } from "../lib/housing-connect";
import { DEMO_PICKS, DEMO_STEPS } from "../lib/fixtures";
import {
  chooseProviderCandidates,
  chooseMarketplaceCandidates,
  evaluateEligibility,
  initialRecordPrecheck,
  mapWithConcurrency,
  nearbyViolationHint,
  providerListingBase,
  providerUnitOffers,
  safeProviderApplyUrl,
  selectMarketplaceListings,
} from "../lib/marketplace";
import { isListingPhotoSource } from "../lib/image-policy";
import { normalizeListingRecord, type Listing } from "../lib/listings";
import { calculateRisk, filterRedevelopmentViolations } from "../lib/nyc";
import { parseBriefDeterministically } from "../lib/planner";
import { recordedPrecheckShowcase } from "../lib/showcase";
import {
  buildLandlordRedFlags,
  buildPrecheckRequirements,
  pickPrecheckProduct,
  pricePrecheckKits,
  precheckProductMatchScore,
  productMatchesPrecheck,
  selectPrecheckCatalogRequirements,
  selectPrecheckCatalogTasks,
} from "../lib/precheck";
import { pickBest, rentable } from "../lib/ucp";
import type {
  MarketplaceListing,
  Product,
  RiskSummary,
  SearchPlan,
  PrecheckRequirement,
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

function listing(overrides: Partial<MarketplaceListing> = {}): MarketplaceListing {
  const base: MarketplaceListing = {
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
    provider: "housing-connect",
    providerLabel: "NYC Housing Connect",
    source: "snapshot",
  };
  return { ...base, ...overrides };
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

describe("provider marketplace inventory", () => {
  const renter = { brief: "studio in Brooklyn under $1,000", householdSize: 2, annualIncome: 60_000 };
  const plan: SearchPlan = {
    boroughs: ["Brooklyn"], neighborhoods: [], bedrooms: { min: 0, max: 0 }, maxRent: 1_000,
    subwayLines: [], amenities: [], priorities: [], generatedBy: "rules",
  };

  it("keeps every published HDC layout and marks range-only eligibility for verification", () => {
    const source: Listing = {
      id: "nychdc-range-test",
      source: "nychdc",
      name: "Range Test",
      address: "90 Sands Street, DUMBO, NY 11201",
      borough: "Brooklyn",
      affordable: true,
      unitSize: "1-Bedroom, Studio",
      rent: 537,
      rentRange: "$537 - $2,132",
      applicationUrl: "https://www.nychdc.com/sites/default/files/2026-08/range-test.pdf",
      imageUrls: [
        "https://www.nychdc.com/sites/default/files/range-test.jpg",
        "/listing-images/range-test/1.webp",
        "https://evil.example/range-test.jpg",
      ],
    };

    const offers = providerUnitOffers(source, renter);
    expect(offers.map((offer) => offer.label)).toEqual(["Studio", "1 Bedroom"]);
    expect(offers.every((offer) => offer.rent === 537 && offer.rentMaximum === 2_132)).toBe(true);

    const converted = providerListingBase(source, renter, plan);
    expect(converted).toMatchObject({
      provider: "nychdc",
      providerLabel: "NYC Housing Development Corporation",
      source: "snapshot",
      eligibility: { status: "unknown" },
    });
    expect(converted?.photos).toEqual([
      "https://www.nychdc.com/sites/default/files/range-test.jpg",
      "/listing-images/range-test/1.webp",
    ]);
    expect(converted?.eligibility.reasons).toContain("Household-size rule is unavailable");
    expect(converted?.eligibility.reasons).toContain("Exact income band is unavailable");
  });

  it("accepts only allowlisted provider application URLs and listing images", () => {
    expect(safeProviderApplyUrl("reside", "https://airtable.com/app123/form")).toContain("airtable.com");
    expect(safeProviderApplyUrl("reside", "https://airtable.com.evil.example/form")).toBe("");
    expect(safeProviderApplyUrl("nychdc", "https://www.nychdc.com/not-an-application")).toBe("");
    expect(isListingPhotoSource("/listing-images/building/1.webp")).toBe(true);
    expect(isListingPhotoSource("/listing-images/../secret.webp")).toBe(false);
    expect(isListingPhotoSource("https://evil.example/building.webp")).toBe(false);
  });

  it("quarantines malformed snapshot rows before they reach streamed search", () => {
    expect(normalizeListingRecord({ source: "reside", id: "../../bad" })).toBeNull();
    expect(normalizeListingRecord({
      source: "reside",
      id: "reside-safe",
      name: "Safe listing",
      address: "1 Test Street",
      borough: "Brooklyn",
      affordable: true,
      rent: "not-a-number",
    })).toMatchObject({ id: "reside-safe", rent: undefined });
  });

  it("reserves a candidate for every available provider source", () => {
    const providers = ["nychdc", "reside", "fifthave", "langsam"];
    const inventory = providers.flatMap((source, index) => [0, 1].map((variant): Listing => ({
      id: `${source}-${variant}`,
      source,
      name: `${source} ${variant}`,
      address: `${index + 1} Test Street, Brooklyn, NY 11201`,
      borough: "Brooklyn",
      affordable: true,
      unitSize: "Studio",
      rent: 800 + variant,
    })));

    expect(new Set(chooseProviderCandidates(inventory, renter, plan).map((item) => item.source)))
      .toEqual(new Set(providers));
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

  it("returns $0 only for a fully checked clean building record", () => {
    expect(initialRecordPrecheck([], true)).toMatchObject({ total: 0, pricingStatus: "priced" });
    expect(initialRecordPrecheck([], false)).toMatchObject({ total: null, pricingStatus: "unavailable" });
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

  it("does not relabel ordinary paint or plaster work as a lead violation", () => {
    expect(buildPrecheckRequirements([
      violation({ description: "PAINT WITH LIGHT COLORED PAINT AT PUBLIC HALL WALLS" }),
    ])).toEqual([]);
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

  it("rejects a wrong product category even when Shopify ranks it cheaply", () => {
    expect(productMatchesPrecheck("vermin", "Rat, Mouse & Insect Glue Traps")).toBe(false);
    expect(
      productMatchesPrecheck(
        "vermin",
        "Pro Series Multi-Catch Mouse Trap Includes Replaceable Glue Board"
      )
    ).toBe(false);
    expect(productMatchesPrecheck("vermin", "Enclosed Reusable Multi-Catch Mouse Trap")).toBe(true);
    expect(productMatchesPrecheck("lead-dust", "True HEPA Air Purifier")).toBe(true);
    expect(productMatchesPrecheck("lead-dust", "HEPA Air Purifier")).toBe(false);
    expect(productMatchesPrecheck("lead-dust", "True HEPA Replacement Filter Pack")).toBe(false);
    expect(productMatchesPrecheck("privacy", "Temporary No-Drill Blackout Privacy Window Shade")).toBe(true);
    expect(productMatchesPrecheck("privacy", "Blackout Privacy Window Shade with Brackets")).toBe(false);
    expect(productMatchesPrecheck("privacy", "Permanent Drill Mount Blackout Blind")).toBe(false);
    expect(productMatchesPrecheck("noise", "Compact White Noise Sound Machine")).toBe(true);
    expect(productMatchesPrecheck("storage", "Under-Bed Storage Bins")).toBe(true);
    expect(productMatchesPrecheck("heat", "Portable Ceramic Space Heater")).toBe(true);
    expect(productMatchesPrecheck("heat", "Portable Propane Space Heater")).toBe(false);
    expect(productMatchesPrecheck("mold", "Small Room Dehumidifier")).toBe(true);
    expect(productMatchesPrecheck("leaks", "Wi-Fi Water Leak Detector")).toBe(true);
    expect(productMatchesPrecheck("drafts", "Removable Window Insulation Kit")).toBe(true);
    expect(productMatchesPrecheck(
      "vermin",
      "Enclosed Reusable Mouse Trap Station",
      "enclosed roach trap station indoor apartment"
    )).toBe(false);
    expect(productMatchesPrecheck(
      "vermin",
      "Enclosed Roach Trap Station",
      "enclosed roach trap station indoor apartment"
    )).toBe(true);
  });

  it("accepts a safe 70% catalog match without weakening hard exclusions", () => {
    expect(precheckProductMatchScore("lead-dust", "PuroAir 240 HEPA Air Purifier")).toBe(0.7);
    expect(precheckProductMatchScore("lead-dust", "True HEPA Replacement Filter Pack")).toBe(0);
    expect(precheckProductMatchScore("heat", "Portable Propane Heater")).toBe(0);
    expect(precheckProductMatchScore(
      "vermin",
      "Enclosed Mouse Trap Station",
      "enclosed roach trap station indoor apartment"
    )).toBe(0);

    const product = pickPrecheckProduct("lead-dust", [
      {
        title: "PuroAir 240 HEPA Air Purifier",
        price: 124.99,
        currency: "USD",
        url: "https://shop.example/purifier",
        merchant: "shop.example",
      },
      {
        title: "True HEPA Replacement Filter Pack",
        price: 19.99,
        currency: "USD",
        url: "https://shop.example/filter",
        merchant: "shop.example",
      },
    ], "compact true hepa air purifier small room");

    expect(product?.title).toBe("PuroAir 240 HEPA Air Purifier");
  });

  it("uses an approximate safe product to complete the live violation total", async () => {
    const categories = buildPrecheckRequirements([
      violation({ description: "REMEDIATE LEAD-BASED PAINT" }),
    ]);
    const [priced] = await pricePrecheckKits([
      listing({
        precheck: { categories, items: [], total: null, pricingStatus: "unavailable", oneTime: true },
      }),
    ], async () => [{
      title: "PuroAir 130i Smart HEPA Air Purifier",
      price: 124.99,
      currency: "USD",
      url: "https://shop.example/purifier",
      merchant: "shop.example",
    }]);

    expect(priced.precheck).toMatchObject({ total: 124.99, pricingStatus: "priced" });
    expect(priced.precheck.items[0].product?.title).toContain("Air Purifier");
  });

  it("keeps the recorded scanner fallback renter-scale and glue-free", () => {
    expect(DEMO_PICKS.map((pick) => pick.need.label)).toEqual([
      "enclosed traps",
      "space heater",
    ]);
    const titles = DEMO_PICKS.flatMap((pick) => (pick.product ? [pick.product.title] : [])).join(" ");
    expect(titles).not.toMatch(/water heater|alarm|glue|sticky/i);
    expect(JSON.stringify(DEMO_STEPS)).not.toMatch(/water heater|CO detector|glue trap|sticky glue/i);
  });

  it("prices a clean building at $0 without calling Shopify", async () => {
    const [clean] = await pricePrecheckKits([listing()]);
    expect(clean.precheck).toMatchObject({ total: 0, pricingStatus: "priced", items: [] });
  });

  it("does not convert an unavailable building record into a $0 kit", async () => {
    const [unknown] = await pricePrecheckKits([listing({
      risk: { ...LOW_RISK, level: "Unavailable", openCount: null },
      precheck: { categories: [], items: [], total: null, pricingStatus: "unavailable", oneTime: true },
    })]);
    expect(unknown.precheck).toMatchObject({ total: null, pricingStatus: "unavailable" });
  });

  it("deduplicates catalog work, caps it at five, and prices violation needs first", () => {
    const requirement = (
      category: PrecheckRequirement["category"],
      basis: PrecheckRequirement["basis"]
    ): PrecheckRequirement => ({
      category,
      basis,
      label: category,
      query: category,
      reason: category,
      violationCount: basis === "violation" ? 1 : 0,
      optional: basis !== "violation",
    });
    const first = listing({
      precheck: {
        categories: [
          requirement("noise", "location"),
          requirement("storage", "building"),
          requirement("privacy", "photo"),
        ],
        items: [], total: null, pricingStatus: "unavailable", oneTime: true,
      },
    });
    const second = listing({
      id: "second",
      precheck: {
        categories: [
          requirement("storage", "building"),
          requirement("heat", "violation"),
          requirement("vermin", "violation"),
          requirement("drafts", "building"),
        ],
        items: [], total: null, pricingStatus: "unavailable", oneTime: true,
      },
    });

    expect(selectPrecheckCatalogRequirements([first, second]).map((item) => item.category))
      .toEqual(["heat", "vermin", "storage", "drafts", "privacy"]);
  });

  it("computes a complete live total only from a category-matching product", async () => {
    const categories = buildPrecheckRequirements([
      violation({ description: "PROVIDE ADEQUATE HEAT" }),
    ]);
    const catalog = vi.fn(async () => [{
      title: "Portable Ceramic Space Heater",
      price: 29.99,
      currency: "USD",
      url: "https://shop.example/heater",
      merchant: "shop.example",
    }]);
    const [priced] = await pricePrecheckKits([
      listing({
        buildings: [{ address: "1 Test Street", city: "Brooklyn", zip: "11201", latitude: 40.7, longitude: -73.9, bbl: "", bin: "" }],
        precheck: { categories, items: [], total: null, pricingStatus: "unavailable", oneTime: true },
      }),
    ], catalog);

    expect(catalog).toHaveBeenCalledWith(categories[0].query, "11201");
    expect(priced.precheck).toMatchObject({ total: 29.99, pricingStatus: "priced" });
    expect(priced.precheck.items[0].product?.title).toBe("Portable Ceramic Space Heater");
  });

  it("prices optional fit items separately from the violation Precheck total", async () => {
    const [heat] = buildPrecheckRequirements([violation({ description: "PROVIDE ADEQUATE HEAT" })]);
    const privacy: PrecheckRequirement = {
      category: "privacy",
      label: "No-drill privacy shade",
      query: "temporary no drill blackout privacy window shade apartment renter",
      reason: "Development-photo fit item.",
      violationCount: 0,
      basis: "photo",
      optional: true,
    };
    const catalog = vi.fn(async (query: string) => query.includes("heater") ? [{
      title: "Portable Ceramic Space Heater",
      price: 30,
      currency: "USD",
      url: "https://shop.example/heater",
      merchant: "shop.example",
    }] : [{
      title: "Temporary No-Drill Blackout Privacy Window Shade",
      price: 18,
      currency: "USD",
      url: "https://shop.example/shade",
      merchant: "shop.example",
    }]);
    const [priced] = await pricePrecheckKits([listing({
      buildings: [{ address: "1 Test Street", city: "Brooklyn", zip: "11201", latitude: 40.7, longitude: -73.9, bbl: "", bin: "" }],
      precheck: {
        categories: [heat, privacy], items: [], total: null, pricingStatus: "unavailable", oneTime: true,
      },
    })], catalog as any);

    expect(priced.precheck.total).toBe(30);
    expect(priced.precheck.pricingStatus).toBe("priced");
    expect(priced.precheck.items.find((item) => item.optional)?.product?.price).toBe(18);
  });

  it("keeps a priced violation kit when an optional extra is unavailable", async () => {
    const [heat] = buildPrecheckRequirements([violation({ description: "PROVIDE ADEQUATE HEAT" })]);
    const privacy: PrecheckRequirement = {
      category: "privacy",
      label: "No-drill privacy shade",
      query: "temporary no drill blackout privacy window shade apartment renter",
      reason: "Optional photo fit.",
      violationCount: 0,
      basis: "photo",
      optional: true,
    };
    const [priced] = await pricePrecheckKits([listing({
      precheck: {
        categories: [heat, privacy], items: [], total: null, pricingStatus: "unavailable", oneTime: true,
      },
    })], async (query: string) => query.includes("heater") ? [{
      title: "Portable Ceramic Space Heater",
      price: 25,
      currency: "USD",
      url: "https://shop.example/heater",
      merchant: "shop.example",
    }] : []);

    expect(priced.precheck).toMatchObject({ total: 25, pricingStatus: "priced" });
    expect(priced.precheck.items.find((item) => item.optional)?.product).toBeNull();
  });

  it("keeps Shopify availability tied to each listing ZIP", async () => {
    const [heat] = buildPrecheckRequirements([violation({ description: "PROVIDE ADEQUATE HEAT" })]);
    const targets = [
      listing({
        id: "brooklyn",
        buildings: [{ address: "1 A St", city: "Brooklyn", zip: "11201", latitude: null, longitude: null, bbl: "", bin: "" }],
        precheck: { categories: [heat], items: [], total: null, pricingStatus: "unavailable", oneTime: true },
      }),
      listing({
        id: "queens",
        buildings: [{ address: "2 B St", city: "Queens", zip: "11372", latitude: null, longitude: null, bbl: "", bin: "" }],
        precheck: { categories: [heat], items: [], total: null, pricingStatus: "unavailable", oneTime: true },
      }),
    ];
    expect(selectPrecheckCatalogTasks(targets).map((task) => task.zip)).toEqual(["11201", "11372"]);
    const catalog = vi.fn(async (_query: string, zip: string) => [{
      title: `Portable Ceramic Space Heater ${zip}`,
      price: zip === "11201" ? 29 : 39,
      currency: "USD",
      url: `https://shop.example/heater-${zip}`,
      merchant: "shop.example",
    }]);
    const [brooklyn, queens] = await pricePrecheckKits(targets, catalog as any);

    expect(catalog).toHaveBeenCalledTimes(2);
    expect(brooklyn.precheck.items[0].product?.title).toContain("11201");
    expect(queens.precheck.items[0].product?.title).toContain("11372");
  });

  it("marks pricing unavailable when Shopify returns the wrong category or fails", async () => {
    const categories = buildPrecheckRequirements([
      violation({ description: "PROVIDE ADEQUATE HEAT" }),
    ]);
    const target = listing({
      precheck: { categories, items: [], total: null, pricingStatus: "unavailable", oneTime: true },
    });
    const [wrong] = await pricePrecheckKits([target], async () => [{
      title: "Decorative Table Lamp",
      price: 20,
      currency: "USD",
      url: "https://shop.example/lamp",
      merchant: "shop.example",
    }]);
    const [failed] = await pricePrecheckKits([target], async () => {
      throw new Error("catalog unavailable");
    });

    expect(wrong.precheck).toMatchObject({ total: null, pricingStatus: "unavailable" });
    expect(wrong.precheck.items[0].product).toBeNull();
    expect(failed.precheck).toMatchObject({ total: null, pricingStatus: "unavailable" });
  });
});

describe("marketplace result selection", () => {
  it("provides a clearly labeled, safe recorded fallback when live inventory has no kit", () => {
    const showcase = recordedPrecheckShowcase();
    expect(showcase.source).toBe("showcase");
    expect(showcase.risk.level).toBe("High");
    expect(showcase.precheck.categories.map((item) => item.category)).toEqual([
      "vermin",
      "heat",
    ]);
    expect(showcase.landlordRedFlags.map((item) => item.kind)).toEqual([
      "Hot water",
      "Alarm systems",
    ]);
    expect(showcase.applyUrl).toBe("");
  });

  it("uses the citywide violation map to reserve risk-probe slots", () => {
    const inventory = Array.from({ length: 8 }, (_, index) => ({
      lotteryId: index + 1,
      markers: [{ lat: String(40.7 + index / 100), lng: "-73.9" }],
    }));
    const riskIndex = { lat: [40.77], lon: [-73.9], n: [400] };
    const input = { brief: "", householdSize: 2, annualIncome: 75_000 };
    const plan: SearchPlan = {
      boroughs: [], neighborhoods: [], bedrooms: null, maxRent: null,
      subwayLines: [], amenities: [], priorities: [], generatedBy: "rules",
    };

    expect(nearbyViolationHint(inventory[7], riskIndex)).toBeGreaterThan(0);
    expect(chooseMarketplaceCandidates(inventory, input, plan, riskIndex).map((item) => item.lotteryId))
      .toContain(8);
  });

  it("returns no risk hint for missing, malformed, or distant map data", () => {
    expect(nearbyViolationHint({ lotteryId: 1, markers: [] }, null)).toBe(0);
    expect(nearbyViolationHint({ lotteryId: 1, markers: {} as any }, { lat: [40.7], lon: [-73.9], n: [100] })).toBe(0);
    expect(nearbyViolationHint(
      { lotteryId: 1, markers: [{ lat: "bad", lng: "-73.9" }] },
      { lat: [40.7], lon: [-73.9], n: [100] }
    )).toBe(0);
    expect(nearbyViolationHint(
      { lotteryId: 1, markers: [{ lat: "41.7", lng: "-73.9" }] },
      { lat: [40.7], lon: [-73.9], n: [100] }
    )).toBe(0);
  });

  it("bounds concurrent marketplace enrichment work", async () => {
    let active = 0;
    let maximum = 0;
    const values = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return value * 2;
    });
    expect(values).toEqual([2, 4, 6, 8, 10]);
    expect(maximum).toBeLessThanOrEqual(2);
  });

  it("retains an actionable high-risk building as a clearly marked spotlight", () => {
    const clean = Array.from({ length: 7 }, (_, index) => listing({ id: `clean-${index}` }));
    const riskyViolation = violation({ id: "risky", class: "C", description: "ABATE MOLD AND DAMP CONDITION" });
    const risky = listing({
      id: "risky",
      risk: {
        level: "High",
        openCount: 18,
        classCounts: { A: 0, B: 0, C: 18 },
        recentCount: 18,
        residentialUnits: 10,
        explanation: "18 open Class C violations.",
      },
      violations: [riskyViolation],
      precheck: {
        categories: buildPrecheckRequirements([riskyViolation]),
        items: [],
        total: null,
        pricingStatus: "unavailable",
        oneTime: true,
      },
    });
    const plan: SearchPlan = {
      boroughs: [], neighborhoods: [], bedrooms: null, maxRent: null,
      subwayLines: [], amenities: [], priorities: [], generatedBy: "rules",
    };

    const selected = selectMarketplaceListings([...clean, risky], plan);

    expect(selected).toHaveLength(7);
    expect(selected.find((item) => item.id === "risky")?.spotlight).toBe("precheck");
  });

  it("keeps the six strongest results when no violation produces a safe kit", () => {
    const plan: SearchPlan = {
      boroughs: [], neighborhoods: [], bedrooms: null, maxRent: null,
      subwayLines: [], amenities: [], priorities: [], generatedBy: "rules",
    };
    expect(selectMarketplaceListings(
      Array.from({ length: 8 }, (_, index) => listing({ id: String(index) })),
      plan
    )).toHaveLength(6);
  });

  it("caps retained results at ten when several risky buildings are actionable", () => {
    const riskyViolation = violation({ class: "C", description: "ERADICATE MICE" });
    const plan: SearchPlan = {
      boroughs: [], neighborhoods: [], bedrooms: null, maxRent: null,
      subwayLines: [], amenities: [], priorities: [], generatedBy: "rules",
    };
    const selected = selectMarketplaceListings(
      Array.from({ length: 10 }, (_, index) => listing({
        id: `risky-${index}`,
        risk: {
          level: "High",
          openCount: 10 + index,
          classCounts: { A: 0, B: 0, C: 10 + index },
          recentCount: 10 + index,
          residentialUnits: 10,
          explanation: "High risk",
        },
        violations: [riskyViolation],
        precheck: {
          categories: buildPrecheckRequirements([riskyViolation]),
          items: [], total: null, pricingStatus: "unavailable", oneTime: true,
        },
      })),
      plan
    );

    expect(selected).toHaveLength(10);
    expect(selected.filter((item) => item.spotlight === "precheck")).toHaveLength(1);
  });
});
