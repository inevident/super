import { DEMO_PROFILE } from "./fixtures";
import type {
  LandlordRedFlag,
  MarketplaceListing,
  PrecheckRequirement,
  ViolationRecord,
} from "./types";

export const PRECHECK_SHOWCASE_ID = "recorded-33-west-89th";

const SAFE_SIGNAL: Record<string, Omit<PrecheckRequirement, "reason" | "violationCount">> = {
  vermin: {
    category: "vermin",
    label: "Enclosed traps",
    query: "enclosed reusable mouse trap station indoor",
    basis: "violation",
  },
  heat: {
    category: "heat",
    label: "Portable space heater",
    query: "portable electric space heater apartment",
    basis: "violation",
  },
};

const LANDLORD_SIGNAL: Record<string, Omit<LandlordRedFlag, "count">> = {
  "hot water": {
    kind: "Hot water",
    summary: "The owner must restore reliable hot water; this is not a renter-installable fix.",
  },
  "smoke alarm": {
    kind: "Alarm systems",
    summary: "Required alarms and fire systems are the owner's responsibility.",
  },
};

function sampleViolation(kind: string, count: number, window: string, description: string): ViolationRecord {
  return {
    id: `recorded-${kind.replace(/[^a-z]+/g, "-")}`,
    class: "Unknown",
    inspectionDate: "",
    status: `Recorded open sample · ${window}`,
    currentStatusDate: "",
    floor: "",
    apartment: "",
    rentImpairing: false,
    description: `${description} (${count} recorded ${kind} signals.)`,
    bbl: DEMO_PROFILE.address.bbl,
    bin: DEMO_PROFILE.address.bin,
  };
}

export function recordedPrecheckShowcase(): MarketplaceListing {
  const categories = DEMO_PROFILE.signals.flatMap((signal) => {
    const mapping = SAFE_SIGNAL[signal.kind];
    if (!mapping) return [];
    return [{
      ...mapping,
      violationCount: signal.count,
      reason: `${signal.count} recorded open ${signal.kind} signals.${mapping.supplemental ? " Supplemental only; this does not remediate lead paint." : ""}`,
    }];
  });
  const landlordRedFlags = DEMO_PROFILE.signals.flatMap((signal) => {
    const mapping = LANDLORD_SIGNAL[signal.kind];
    return mapping ? [{ ...mapping, count: signal.count }] : [];
  });
  const violations = DEMO_PROFILE.signals.map((signal) =>
    sampleViolation(signal.kind, signal.count, signal.window, signal.sample)
  );
  const ring = DEMO_PROFILE.footprint?.ring ?? [];
  const latitude = ring.length ? ring.reduce((sum, point) => sum + point[1], 0) / ring.length : null;
  const longitude = ring.length ? ring.reduce((sum, point) => sum + point[0], 0) / ring.length : null;

  return {
    id: PRECHECK_SHOWCASE_ID,
    spotlight: "precheck",
    title: "33 West 89th Street · recorded Precheck",
    description: "A recorded NYC building case study used to demonstrate violation analysis and safe Shopify mitigation matching.",
    borough: "Manhattan",
    neighborhood: "Upper West Side",
    address: "33 West 89th Street",
    latitude,
    longitude,
    deadline: "",
    units: DEMO_PROFILE.facts?.residentialUnits ?? 0,
    photo: null,
    photos: [],
    amenities: [],
    transit: [],
    nearby: [],
    buildings: [{
      address: "33 West 89th Street",
      city: "New York",
      zip: DEMO_PROFILE.address.zip,
      latitude,
      longitude,
      bbl: DEMO_PROFILE.address.bbl,
      bin: DEMO_PROFILE.address.bin,
    }],
    offers: [],
    matchedOfferIds: [],
    eligibility: { status: "unknown", reasons: ["Recorded case study — not an active rental listing"] },
    matchExplanation: "This recorded case keeps the violation-to-Shopify workflow demonstrable when active lotteries are clean or HPD is unavailable.",
    risk: {
      level: "High",
      openCount: DEMO_PROFILE.openViolations,
      classCounts: { A: 0, B: 0, C: 0 },
      recentCount: 0,
      residentialUnits: DEMO_PROFILE.facts?.residentialUnits ?? null,
      explanation: `${DEMO_PROFILE.openViolations} open violations were captured across ${DEMO_PROFILE.facts?.residentialUnits ?? "the"} residential units in this recorded case.`,
    },
    precheck: { categories, items: [], total: null, pricingStatus: "unavailable", oneTime: true },
    landlordRedFlags,
    violations,
    excludedHistoricalViolations: [],
    profile: DEMO_PROFILE,
    applyUrl: "",
    provider: "recorded",
    providerLabel: "Recorded public-data case",
    source: "showcase",
  };
}
