import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getHousingInventory,
  getLotteryDetail,
  getLotterySummary,
  groupUnitOffers,
  summaryBedroomCounts,
  type HousingAdvertisement,
  type HousingLotterySummary,
} from "./housing-connect";
import {
  assessBuilding,
  fetchHousingConnectBuildings,
  resolveAddress,
  sortViolations,
  type HousingConnectBuildingRow,
} from "./nyc";
import { addContextualPrecheck } from "./contextual-precheck";
import { planRenterSearch } from "./planner";
import { buildLandlordRedFlags, buildPrecheckRequirements, pricePrecheckKits } from "./precheck";
import { PRECHECK_SHOWCASE_ID, recordedPrecheckShowcase } from "./showcase";
import type {
  Address,
  BuildingAssessment,
  MarketplaceBuilding,
  MarketplaceEvent,
  MarketplaceListing,
  RenterBrief,
  RiskSummary,
  SearchPlan,
  UnitOffer,
} from "./types";

const UNKNOWN_RISK: RiskSummary = {
  level: "Unavailable",
  openCount: null,
  classCounts: { A: 0, B: 0, C: 0 },
  recentCount: 0,
  residentialUnits: null,
  explanation: "Building record has not been checked yet.",
};

const BOROUGH_CODES: Record<string, string> = {
  MN: "Manhattan",
  BK: "Brooklyn",
  BX: "Bronx",
  QN: "Queens",
  SI: "Staten Island",
};

export type CityRiskIndex = {
  lat: number[];
  lon: number[];
  n: number[];
};

let cityRiskCache: CityRiskIndex | null | undefined;

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function compactText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedAddress(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function abortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
) {
  const output = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (true) {
      throwIfAborted(signal);
      const index = next;
      next += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, run));
  return output;
}

function summaryMarkers(summary: HousingLotterySummary) {
  return Array.isArray(summary.markers) ? summary.markers : [];
}

function summaryRents(summary: HousingLotterySummary) {
  return unique(
    String(summary.rents ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0)
  ).sort((a, b) => a - b);
}

function prelimScore(summary: HousingLotterySummary, input: RenterBrief, plan: SearchPlan) {
  let score = 0;
  const borough = compactText(summary.borough).toLowerCase();
  const neighborhood = compactText(summary.neighborhood).toLowerCase();
  if (plan.boroughs.length) {
    score += plan.boroughs.some((item) => borough.includes(item.toLowerCase())) ? 45 : -35;
  }
  if (plan.neighborhoods.length) {
    score += plan.neighborhoods.some((item) => neighborhood.includes(item.toLowerCase())) ? 35 : -20;
  }
  if (plan.bedrooms) {
    const counts = summaryBedroomCounts(summary);
    const hasBedroom = counts.some(
      (count, bedrooms) => count > 0 && bedrooms >= plan.bedrooms!.min && bedrooms <= plan.bedrooms!.max
    );
    score += hasBedroom ? 35 : -30;
  }
  const minimumIncome = Number(summary.minIncome);
  const maximumIncome = Number(summary.maxIncome);
  if (minimumIncome || maximumIncome) {
    score += input.annualIncome >= minimumIncome && input.annualIncome <= maximumIncome ? 30 : -25;
  }
  const minimumHousehold = Number(summary.minHouseholdSize);
  const maximumHousehold = Number(summary.maxHouseholdSize);
  if (minimumHousehold || maximumHousehold) {
    score += input.householdSize >= minimumHousehold && input.householdSize <= maximumHousehold ? 20 : -20;
  }
  if (plan.maxRent != null) {
    const rents = summaryRents(summary);
    score += rents.some((rent) => rent <= plan.maxRent!) ? 25 : -15;
  }
  const amenities = compactText(summary.amenities).toLowerCase();
  score += plan.amenities.filter((amenity) => amenities.includes(amenity.toLowerCase())).length * 5;
  const trains = compactText(summary.trains).toUpperCase().split(/[^A-Z0-9]+/);
  score += plan.subwayLines.filter((line) => trains.includes(line)).length * 7;
  return score;
}

function cityRiskIndex() {
  if (cityRiskCache !== undefined) return cityRiskCache;
  try {
    const parsed = JSON.parse(readFileSync(join(process.cwd(), "public", "citymap.json"), "utf8"));
    cityRiskCache = Array.isArray(parsed.lat) && Array.isArray(parsed.lon) && Array.isArray(parsed.n)
      ? { lat: parsed.lat, lon: parsed.lon, n: parsed.n }
      : null;
  } catch {
    cityRiskCache = null;
  }
  return cityRiskCache;
}

export function nearbyViolationHint(summary: HousingLotterySummary, index: CityRiskIndex | null) {
  if (!index) return 0;
  let best = 0;
  for (const marker of summaryMarkers(summary)) {
    const latitude = Number(marker.lat);
    const longitude = Number(marker.lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    for (let position = 0; position < index.n.length; position += 1) {
      const northSouthMiles = (latitude - Number(index.lat[position])) * 69;
      const eastWestMiles = (longitude - Number(index.lon[position])) * 53;
      const distanceMiles = Math.hypot(northSouthMiles, eastWestMiles);
      if (distanceMiles <= 0.05) {
        best = Math.max(best, Number(index.n[position]) * (1 - distanceMiles / 0.05));
      }
    }
  }
  return best;
}

export function chooseMarketplaceCandidates(
  inventory: HousingLotterySummary[],
  input: RenterBrief,
  plan: SearchPlan,
  index: CityRiskIndex | null = cityRiskIndex()
) {
  const ranked = [...inventory].sort((a, b) => prelimScore(b, input, plan) - prelimScore(a, input, plan));
  const core = ranked.slice(0, 6);
  const coreIds = new Set(core.map((summary) => String(summary.lotteryId)));
  const inRequestedArea = (summary: HousingLotterySummary) =>
    !plan.boroughs.length || plan.boroughs.some((borough) =>
      compactText(summary.borough).toLowerCase().includes(borough.toLowerCase())
    );
  const probes = ranked
    .filter((summary) => !coreIds.has(String(summary.lotteryId)) && inRequestedArea(summary))
    .map((summary) => ({ summary, hint: nearbyViolationHint(summary, index) }))
    .filter((item) => item.hint > 0)
    .sort((a, b) => b.hint - a.hint)
    .slice(0, 2)
    .map((item) => item.summary);
  const ids = unique([...core, ...probes, ...ranked].map((summary) => String(summary.lotteryId))).slice(0, 8);
  return ids.map((id) => ranked.find((summary) => String(summary.lotteryId) === id)!);
}

function fallbackOffers(summary: HousingLotterySummary): UnitOffer[] {
  const rents = summaryRents(summary);
  const counts = summaryBedroomCounts(summary);
  return counts.flatMap((count, bedrooms) => {
    if (!count) return [];
    const layoutTypeId = bedrooms === 0 ? 1 : Math.min(7, bedrooms + 1);
    return [
      {
        id: `summary-${summary.lotteryId}-${bedrooms}`,
        layoutTypeId,
        bedrooms,
        label: bedrooms === 0 ? "Studio" : `${bedrooms} Bedroom`,
        rent: rents[Math.min(bedrooms, Math.max(0, rents.length - 1))] ?? null,
        count,
        address: compactText(summaryMarkers(summary)[0]?.address),
        ami: null,
        minimumHouseholdSize: Number(summary.minHouseholdSize) || 0,
        maximumHouseholdSize: Number(summary.maxHouseholdSize) || 0,
        incomeBands: [],
      },
    ];
  });
}

function detailBuildings(detail: HousingAdvertisement | null, summary: HousingLotterySummary) {
  const buildings = Array.isArray(detail?.lotteryBuildings) ? detail.lotteryBuildings : [];
  if (buildings.length) {
    return buildings.map((building) => ({
      address: compactText(building.address),
      city: compactText(building.city),
      zip: compactText(building.zip),
      latitude: finiteNumber(building.latitude),
      longitude: finiteNumber(building.longitude),
      nearbyPlaces: Array.isArray(building.nearbyPlaces) ? building.nearbyPlaces : [],
    }));
  }
  return summaryMarkers(summary).map((marker) => ({
    address: compactText(marker.address),
    city: compactText(marker.city),
    zip: compactText(marker.zip),
    latitude: finiteNumber(marker.lat),
    longitude: finiteNumber(marker.lng),
    nearbyPlaces: [],
  }));
}

function evaluateOffer(offer: UnitOffer, input: RenterBrief, plan: SearchPlan) {
  const reasons: string[] = [];
  if (plan.bedrooms && (offer.bedrooms < plan.bedrooms.min || offer.bedrooms > plan.bedrooms.max)) {
    reasons.push(`Needs ${plan.bedrooms.min === plan.bedrooms.max ? plan.bedrooms.min : `${plan.bedrooms.min}+`} bedrooms`);
  }
  if (
    input.householdSize < offer.minimumHouseholdSize ||
    (offer.maximumHouseholdSize > 0 && input.householdSize > offer.maximumHouseholdSize)
  ) {
    reasons.push(`Household size must be ${offer.minimumHouseholdSize}–${offer.maximumHouseholdSize}`);
  }
  const band = offer.incomeBands.find((item) => item.householdSize === input.householdSize);
  if (!band) {
    reasons.push("Exact income band is unavailable");
  } else if (input.annualIncome < band.minimumIncome) {
    reasons.push(`Income is $${(band.minimumIncome - input.annualIncome).toLocaleString()} below this band`);
  } else if (input.annualIncome > band.maximumIncome) {
    reasons.push(`Income is $${(input.annualIncome - band.maximumIncome).toLocaleString()} above this band`);
  }
  if (plan.maxRent != null && offer.rent != null && offer.rent > plan.maxRent) {
    reasons.push(`Rent is $${(offer.rent - plan.maxRent).toLocaleString()} over budget`);
  }
  if (plan.maxRent != null && offer.rent == null) reasons.push("Rent needs verification");
  return reasons;
}

export function evaluateEligibility(
  offers: UnitOffer[],
  borough: string,
  neighborhood: string,
  input: RenterBrief,
  plan: SearchPlan
) {
  const locationReasons: string[] = [];
  if (plan.boroughs.length && !plan.boroughs.some((item) => borough.toLowerCase().includes(item.toLowerCase()))) {
    locationReasons.push(`Outside ${plan.boroughs.join(" or ")}`);
  }
  if (
    plan.neighborhoods.length &&
    !plan.neighborhoods.some((item) => neighborhood.toLowerCase().includes(item.toLowerCase()))
  ) {
    locationReasons.push(`Outside ${plan.neighborhoods.join(" or ")}`);
  }
  if (!offers.length) {
    return { status: "unknown" as const, reasons: ["Unit requirements are unavailable"], matchedOfferIds: [] };
  }
  const evaluations = offers.map((offer) => ({ offer, reasons: [...locationReasons, ...evaluateOffer(offer, input, plan)] }));
  const matches = evaluations.filter((item) => !item.reasons.length).map((item) => item.offer.id);
  if (matches.length) return { status: "eligible" as const, reasons: [], matchedOfferIds: matches };
  const nearest = [...evaluations].sort((a, b) => a.reasons.length - b.reasons.length)[0];
  const unknownOnly = nearest.reasons.every((reason) => /unavailable|verification/.test(reason.toLowerCase()));
  return {
    status: unknownOnly ? ("unknown" as const) : ("near" as const),
    reasons: unique(nearest.reasons).slice(0, 3),
    matchedOfferIds: [],
  };
}

function listingBase(
  summary: HousingLotterySummary,
  detail: HousingAdvertisement | null,
  input: RenterBrief,
  plan: SearchPlan,
  source: "live" | "snapshot"
): MarketplaceListing {
  const rawBuildings = detailBuildings(detail, summary);
  const firstBuilding = rawBuildings[0];
  const offers = Array.isArray(detail?.units) && detail.units.length
    ? groupUnitOffers(detail.units)
    : fallbackOffers(summary);
  const borough = compactText(summary.borough || firstBuilding?.city);
  const neighborhood = compactText(summary.neighborhood);
  const eligibility = evaluateEligibility(offers, borough, neighborhood, input, plan);
  const photos = unique(
    (Array.isArray(detail?.photos) ? detail.photos : [])
      .map((photo) => compactText(photo.item1))
      .filter((photo) => /^https:\/\//.test(photo))
  );
  if (!photos.length && summary.defaultPhotoStream) photos.push(String(summary.defaultPhotoStream));
  const amenities = unique(
    (Array.isArray(detail?.amenities) && detail.amenities.length
      ? detail.amenities.map((amenity) => compactText(amenity.name))
      : compactText(summary.amenities).split(","))
      .map(compactText)
      .filter(Boolean)
  );
  const nearby = rawBuildings.flatMap((building) =>
    building.nearbyPlaces.map((place: any) => ({
      name: compactText(place.nearbyPlaceName),
      type: compactText(place.placeType),
      train: compactText(place.trainName),
    }))
  );
  const transit = unique([
    ...compactText(summary.trains).split(/[,\s]+/).filter(Boolean),
    ...nearby.flatMap((place) => place.train.split(/[,\s]+/).filter(Boolean)),
  ]);
  return {
    id: String(summary.lotteryId),
    title: compactText(detail?.lotteryName || summary.lotteryName) || "Housing Connect opportunity",
    description: compactText(summary.lotteryDescription || detail?.lotteryDescription),
    borough,
    neighborhood,
    address: firstBuilding?.address || "Address available on Housing Connect",
    latitude: firstBuilding?.latitude ?? null,
    longitude: firstBuilding?.longitude ?? null,
    deadline: compactText(detail?.endDate || summary.lotteryEndDate),
    units: Number(summary.units) || offers.reduce((sum, offer) => sum + offer.count, 0),
    photo: photos[0] ?? null,
    photos,
    amenities,
    transit,
    nearby,
    buildings: rawBuildings.map((building) => ({
      address: building.address,
      city: building.city,
      zip: building.zip,
      latitude: building.latitude,
      longitude: building.longitude,
      bbl: "",
      bin: "",
    })),
    offers,
    matchedOfferIds: eligibility.matchedOfferIds,
    eligibility: { status: eligibility.status, reasons: eligibility.reasons },
    matchExplanation: "Super is checking the building record.",
    risk: UNKNOWN_RISK,
    precheck: { categories: [], items: [], total: null, pricingStatus: "unavailable", oneTime: true },
    landlordRedFlags: [],
    violations: [],
    excludedHistoricalViolations: [],
    profile: null,
    applyUrl: `https://housingconnect.nyc.gov/PublicWeb/details/${summary.lotteryId}`,
    source,
  };
}

function findJoin(
  building: MarketplaceBuilding,
  rows: HousingConnectBuildingRow[]
): HousingConnectBuildingRow | undefined {
  const wanted = normalizedAddress(building.address);
  return rows.find((row) => {
    const joined = normalizedAddress(`${row.house_number ?? ""} ${row.street_name ?? ""}`);
    return joined && (joined === wanted || wanted.includes(joined) || joined.includes(wanted));
  });
}

async function identifyBuilding(
  building: MarketplaceBuilding,
  borough: string,
  joins: HousingConnectBuildingRow[],
  signal?: AbortSignal
): Promise<{ building: MarketplaceBuilding; address: Address | null }> {
  const joined = findJoin(building, joins);
  if (joined?.address_bbl) {
    const resolvedBorough = BOROUGH_CODES[String(joined.borough ?? "").toUpperCase()] || borough;
    return {
      building: {
        ...building,
        zip: String(joined.address_zipcode ?? building.zip),
        latitude: finiteNumber(joined.address_latitude) ?? building.latitude,
        longitude: finiteNumber(joined.address_longitude) ?? building.longitude,
        bbl: String(joined.address_bbl),
        bin: String(joined.address_buildingidentificationnumber ?? ""),
      },
      address: {
        label: `${building.address}, ${resolvedBorough}, NY ${joined.address_zipcode ?? building.zip}`,
        bbl: String(joined.address_bbl),
        bin: String(joined.address_buildingidentificationnumber ?? ""),
        borough: resolvedBorough,
        zip: String(joined.address_zipcode ?? building.zip),
      },
    };
  }
  try {
    const address = await resolveAddress(
      `${building.address}, ${building.city || borough}, NY ${building.zip}`,
      signal
    );
    return { building: { ...building, bbl: address.bbl, bin: address.bin, zip: address.zip || building.zip }, address };
  } catch {
    throwIfAborted(signal);
    return { building, address: null };
  }
}

function unavailableAssessment(): BuildingAssessment {
  return {
    profile: null,
    violations: [],
    excludedHistoricalViolations: [],
    risk: { ...UNKNOWN_RISK, explanation: "No BBL/BIN match was available; this building was not treated as clean." },
    recordAvailable: false,
  };
}

function aggregateRisk(assessments: BuildingAssessment[]): RiskSummary {
  if (!assessments.length) return UNKNOWN_RISK;
  const priority: Record<RiskSummary["level"], number> = { High: 4, Moderate: 3, Unavailable: 2, Low: 1 };
  const worst = [...assessments].sort((a, b) => priority[b.risk.level] - priority[a.risk.level])[0].risk;
  const available = assessments.filter((assessment) => assessment.recordAvailable);
  if (!available.length) return worst;
  const totals = available.reduce(
    (sum, assessment) => ({
      open: sum.open + (assessment.risk.openCount ?? 0),
      A: sum.A + assessment.risk.classCounts.A,
      B: sum.B + assessment.risk.classCounts.B,
      C: sum.C + assessment.risk.classCounts.C,
      recent: sum.recent + assessment.risk.recentCount,
      units: sum.units + (assessment.risk.residentialUnits ?? 0),
    }),
    { open: 0, A: 0, B: 0, C: 0, recent: 0, units: 0 }
  );
  return {
    level: worst.level,
    openCount: totals.open,
    classCounts: { A: totals.A, B: totals.B, C: totals.C },
    recentCount: totals.recent,
    residentialUnits: totals.units || null,
    explanation:
      assessments.length > 1
        ? `${totals.open} open violations across ${available.length} checked building${available.length === 1 ? "" : "s"}; worst rating is ${worst.level}.`
        : worst.explanation,
  };
}

function explanation(listing: MarketplaceListing) {
  if (listing.eligibility.status !== "eligible") {
    return `Near match: ${listing.eligibility.reasons.join("; ") || "eligibility needs verification"}.`;
  }
  const offer = listing.offers.find((item) => listing.matchedOfferIds.includes(item.id));
  const offerText = offer
    ? `${offer.label}${offer.rent != null ? ` at $${offer.rent.toLocaleString()}/month` : ""}`
    : "an eligible unit";
  const risk = listing.risk.level === "Unavailable" ? "building record unavailable" : `${listing.risk.level.toLowerCase()} building risk`;
  return `Your household and income fit ${offerText}; ${risk}.`;
}

export async function enrichListing(
  listing: MarketplaceListing,
  signal?: AbortSignal
): Promise<MarketplaceListing> {
  throwIfAborted(signal);
  const joins = await fetchHousingConnectBuildings(listing.id, signal);
  const identities = await mapWithConcurrency(
    listing.buildings,
    2,
    (building) => identifyBuilding(building, listing.borough, joins, signal),
    signal
  );
  const assessments = await mapWithConcurrency(
    identities,
    2,
    async ({ address }) => {
      throwIfAborted(signal);
      if (!address) return unavailableAssessment();
      try {
        return await assessBuilding(address, signal);
      } catch {
        throwIfAborted(signal);
        return unavailableAssessment();
      }
    },
    signal
  );
  const violations = sortViolations(assessments.flatMap((assessment) => assessment.violations));
  const historical = sortViolations(
    assessments.flatMap((assessment) => assessment.excludedHistoricalViolations)
  );
  const categories = buildPrecheckRequirements(violations);
  const enriched: MarketplaceListing = {
    ...listing,
    buildings: identities.map((identity) => identity.building),
    risk: aggregateRisk(assessments),
    precheck: categories.length
      ? { categories, items: [], total: null, pricingStatus: "unavailable", oneTime: true }
      : { categories: [], items: [], total: 0, pricingStatus: "priced", oneTime: true },
    landlordRedFlags: buildLandlordRedFlags(violations),
    violations,
    excludedHistoricalViolations: historical,
    profile: assessments.find((assessment) => assessment.profile)?.profile ?? null,
  };
  return { ...enriched, matchExplanation: explanation(enriched) };
}

function finalScore(listing: MarketplaceListing, plan: SearchPlan) {
  let score = listing.eligibility.status === "eligible" ? 1000 : listing.eligibility.status === "near" ? 300 : 100;
  score -= listing.eligibility.reasons.length * 80;
  score += listing.risk.level === "Low" ? 100 : listing.risk.level === "Moderate" ? 30 : listing.risk.level === "High" ? -120 : -20;
  const matched = listing.offers.filter((offer) => listing.matchedOfferIds.includes(offer.id));
  const rent = Math.min(...matched.map((offer) => offer.rent ?? Number.MAX_SAFE_INTEGER));
  if (Number.isFinite(rent) && rent < Number.MAX_SAFE_INTEGER) score += Math.max(0, 100 - rent / 40);
  score += plan.amenities.filter((amenity) => listing.amenities.join(" ").toLowerCase().includes(amenity)).length * 10;
  score += plan.subwayLines.filter((line) => listing.transit.includes(line)).length * 12;
  return score;
}

function precheckSpotlightScore(listing: MarketplaceListing) {
  const risk = { High: 4, Moderate: 3, Low: 2, Unavailable: 1 }[listing.risk.level];
  return risk * 10_000 + (listing.risk.openCount ?? 0) * 10 + listing.precheck.categories.length;
}

export function selectMarketplaceListings(
  inspected: MarketplaceListing[],
  plan: SearchPlan,
  coreLimit = 6
) {
  const ranked = [...inspected].sort((a, b) => finalScore(b, plan) - finalScore(a, plan));
  const actionable = ranked
    .filter((listing) => listing.precheck.categories.length > 0 && listing.violations.length > 0)
    .sort((a, b) => precheckSpotlightScore(b) - precheckSpotlightScore(a));
  const retained = unique([
    ...ranked.slice(0, coreLimit).map((listing) => listing.id),
    ...actionable.map((listing) => listing.id),
  ])
    .slice(0, 8)
    .map((id) => ranked.find((listing) => listing.id === id)!);
  const spotlightId = actionable[0]?.id;
  return retained.map((listing) => ({
    ...listing,
    spotlight: listing.id === spotlightId ? ("precheck" as const) : undefined,
  }));
}

export type MarketplaceEmitter = (event: MarketplaceEvent) => void;

export async function runMarketplaceSearch(
  input: RenterBrief,
  emit: MarketplaceEmitter,
  options: { signal?: AbortSignal } = {}
) {
  const { signal } = options;
  throwIfAborted(signal);
  emit({ stage: "planning", message: "Turning your brief into a search plan" });
  const plan = await planRenterSearch(input, signal);
  throwIfAborted(signal);
  emit({ stage: "plan", plan });

  const inventory = await getHousingInventory(signal);
  emit({
    stage: "inventory",
    message: `Found ${inventory.rentals.length} active Housing Connect rental opportunities`,
    count: inventory.rentals.length,
    source: inventory.source,
  });
  const candidates = chooseMarketplaceCandidates(inventory.rentals, input, plan);
  emit({ stage: "inspecting", message: "Reading exact unit and income bands", completed: 0, total: candidates.length });
  const bases = await mapWithConcurrency(
    candidates,
    4,
    async (summary) => {
      const detailResult = await getLotteryDetail(summary.lotteryId, signal);
      return listingBase(
        summary,
        detailResult?.detail ?? null,
        input,
        plan,
        detailResult?.source ?? inventory.source
      );
    },
    signal
  );
  let completed = 0;
  const inspected = await mapWithConcurrency(
    bases,
    2,
    async (listing) => {
      const result = await enrichListing(listing, signal);
      completed += 1;
      emit({
        stage: "inspecting",
        message: `Checked ${completed} of ${bases.length} building records`,
        completed,
        total: bases.length,
      });
      emit({ stage: "listing", listing: result });
      return result;
    },
    signal
  );
  const selected = selectMarketplaceListings(inspected, plan);

  emit({ stage: "pricing", message: "Tailoring and pricing one shared set of safe move-in items" });
  const recorded = selected.some((listing) => listing.spotlight === "precheck")
    ? null
    : recordedPrecheckShowcase();
  // Keep the search fast. Public building facts and transit tailor the cards;
  // the bounded image-model pass runs when a renter opens one listing detail.
  const contextualized = await addContextualPrecheck(
    recorded ? [...selected, recorded] : selected,
    null,
    signal
  );
  const pricedAll = await pricePrecheckKits(contextualized, undefined, signal);
  const showcase = pricedAll.find((listing) => listing.source === "showcase");
  const priced = pricedAll.filter((listing) => listing.source !== "showcase");
  const sorted = priced.sort((a, b) => finalScore(b, plan) - finalScore(a, plan));
  const exact = sorted.filter((listing) => listing.eligibility.status === "eligible");
  const near = sorted.filter((listing) => listing.eligibility.status !== "eligible");
  emit({ stage: "results", exact, near, showcase });
  return { plan, exact, near, showcase };
}

export async function getMarketplaceListing(id: string, input?: RenterBrief, signal?: AbortSignal) {
  if (id === PRECHECK_SHOWCASE_ID) {
    const [contextualized] = await addContextualPrecheck([recordedPrecheckShowcase()], undefined, signal);
    return (await pricePrecheckKits([contextualized], undefined, signal))[0];
  }
  const found = await getLotterySummary(id, signal);
  if (!found) return null;
  const renter = input ?? {
    brief: "",
    householdSize: Math.max(1, Number(found.summary.minHouseholdSize) || 1),
    annualIncome: Math.max(1, Number(found.summary.minIncome) || 1),
  };
  const plan = await planRenterSearch(renter, signal);
  const detailResult = await getLotteryDetail(id, signal);
  const base = listingBase(
    found.summary,
    detailResult?.detail ?? null,
    renter,
    plan,
    detailResult?.source ?? found.source
  );
  const enriched = await enrichListing(base, signal);
  const [contextualized] = await addContextualPrecheck([enriched], undefined, signal);
  return (await pricePrecheckKits([contextualized], undefined, signal))[0];
}
