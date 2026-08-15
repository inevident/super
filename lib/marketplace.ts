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
import { isListingPhotoSource } from "./image-policy";
import { getListing, searchListings, type Listing } from "./listings";
import { parseBriefDeterministically, planRenterSearch } from "./planner";
import { buildLandlordRedFlags, buildPrecheckRequirements, pricePrecheckKits } from "./precheck";
import { PRECHECK_SHOWCASE_ID, recordedPrecheckShowcase } from "./showcase";
import { lookupNearbySubway } from "./transit";
import type {
  Address,
  BuildingAssessment,
  MarketplaceBuilding,
  MarketplaceEvent,
  MarketplaceListing,
  MarketplaceProvider,
  PrecheckKit,
  PrecheckRequirement,
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

const HOUSING_CONNECT_CANDIDATE_LIMIT = 8;
const PROVIDER_CANDIDATE_LIMIT = 4;
const MARKETPLACE_RESULT_LIMIT = 10;

const PROVIDERS: Record<
  Exclude<MarketplaceProvider, "housing-connect" | "recorded">,
  { label: string; hosts: Set<string> }
> = {
  nychdc: {
    label: "NYC Housing Development Corporation",
    hosts: new Set(["nychdc.com", "www.nychdc.com"]),
  },
  fifthave: {
    label: "Fifth Avenue Committee",
    hosts: new Set(["fifthave.org", "www.fifthave.org", "fifthave.my.site.com"]),
  },
  reside: {
    label: "Reside New York",
    hosts: new Set(["airtable.com", "www.airtable.com", "residenewyork.com", "www.residenewyork.com"]),
  },
  langsam: {
    label: "Langsam Property Services",
    hosts: new Set(["admin.clientsolution.com"]),
  },
};

type ExternalProvider = keyof typeof PROVIDERS;

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

function hasSpecificStreetAddress(value: string) {
  return /\b\d{1,5}(?:-\d{1,5})?\b/.test(value) &&
    /\b(?:avenue|ave|boulevard|blvd|broadway|court|ct|drive|dr|lane|ln|place|pl|road|rd|street|st|terrace|way)\b/i.test(value);
}

function hasMultipleBuildingAddresses(value: string) {
  return /\b\d{3,5}\s*(?:,|\s+(?:and|&)\s+)\s*\d{1,5}\b/i.test(value) ||
    /\b\d{3,5}\s+(?:-|–|—)\s+\d{3,5}\b/.test(value) ||
    /\b(?:avenue|ave|boulevard|blvd|court|ct|drive|dr|lane|ln|place|pl|road|rd|street|st|terrace|way)\s*&\s*\d{1,5}\b/i.test(value);
}

function finiteNumber(value: unknown): number | null {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function providerForSource(value: unknown): ExternalProvider | null {
  const source = compactText(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDERS, source)
    ? (source as ExternalProvider)
    : null;
}

export function safeProviderApplyUrl(source: unknown, ...values: unknown[]) {
  const provider = providerForSource(source);
  if (!provider) return "";
  for (const value of values) {
    try {
      const url = new URL(compactText(value));
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !PROVIDERS[provider].hosts.has(url.hostname.toLowerCase())
      ) continue;
      if (provider === "nychdc" && !url.pathname.startsWith("/sites/default/files/")) continue;
      return url.href;
    } catch {
      // Try the next provider-published URL.
    }
  }
  return "";
}

function moneyValues(value: unknown) {
  return unique(
    (compactText(value).match(/[\d,]+(?:\.\d+)?/g) ?? [])
      .map((amount) => Number(amount.replace(/,/g, "")))
      .filter((amount) => Number.isFinite(amount) && amount >= 200 && amount <= 20_000)
  ).sort((a, b) => a - b);
}

function providerLayouts(unitSize: unknown, beds: unknown) {
  const text = compactText(unitSize);
  const layouts: Array<{ bedrooms: number; label: string }> = [];
  if (/\bstudio\b/i.test(text)) layouts.push({ bedrooms: 0, label: "Studio" });
  for (const match of text.matchAll(/\b(\d+)\s*[- ]?bedrooms?\b/gi)) {
    const bedrooms = Number(match[1]);
    if (Number.isFinite(bedrooms) && bedrooms >= 0 && bedrooms <= 10) {
      layouts.push({ bedrooms, label: `${bedrooms} Bedroom` });
    }
  }
  const statedBeds = finiteNumber(beds);
  if (!layouts.length && statedBeds != null && statedBeds >= 0 && statedBeds <= 10) {
    layouts.push({
      bedrooms: statedBeds,
      label: statedBeds === 0 ? "Studio" : `${statedBeds} Bedroom`,
    });
  }
  const seen = new Set<number>();
  return layouts
    .sort((a, b) => a.bedrooms - b.bedrooms)
    .filter((layout) => {
      if (seen.has(layout.bedrooms)) return false;
      seen.add(layout.bedrooms);
      return true;
    });
}

function providerHouseholdRange(description: unknown) {
  const text = compactText(description);
  const match = text.match(
    /(?:household(?:\s+size)?(?:\s+of)?\s*)?(\d+)\s*(?:-|–|—|to)\s*(\d+)\s*(?:person|people|household)?/i
  );
  if (!match || !/(?:person|people|household)/i.test(match[0])) return null;
  const minimum = Number(match[1]);
  const maximum = Number(match[2]);
  return minimum > 0 && maximum >= minimum ? { minimum, maximum } : null;
}

function providerTransit(description: unknown) {
  const lines = new Set<string>();
  const text = compactText(description);
  const allowed = new Set("1 2 3 4 5 6 7 A C E B D F M G J Z L N Q R W S".split(" "));
  for (const match of text.matchAll(/(?:near|by|access to)[^.]{0,90}?\btrains?\b/gi)) {
    compactText(match[0])
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((token) => allowed.has(token))
      .forEach((token) => lines.add(token));
  }
  return [...lines];
}

function providerAmenities(description: unknown) {
  const text = compactText(description).toLowerCase();
  const catalog: Array<[string, RegExp]> = [
    ["Elevator", /\belevator\b/],
    ["Laundry", /\blaundry\b/],
    ["Fitness center", /\b(?:fitness|gym|exercise)\b/],
    ["Bike storage", /\bbike (?:room|storage|parking)\b/],
    ["Outdoor space", /\b(?:terrace|courtyard|roof deck|rooftop|outdoor)\b/],
    ["Pet friendly", /\bpet friendly\b/],
    ["Doorman or attended lobby", /\b(?:doorman|attended lobby|concierge)\b/],
    ["Community room", /\b(?:community|recreation|multipurpose) room\b/],
    ["Parking", /\bparking\b/],
    ["Air conditioning", /\b(?:air conditioning|air-conditioned|a\/c)\b/],
  ];
  return catalog.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function providerNeighborhood(listing: Listing) {
  const parts = compactText(listing.address).split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return "";
  const borough = compactText(listing.borough).replace(/^the\s+/i, "").toLowerCase();
  if (parts.length === 2 && !/\d/.test(parts[0])) return parts[0];
  const candidates = parts.slice(1, -1);
  return candidates.find((part) => {
    const normalized = part.replace(/^the\s+/i, "").toLowerCase();
    return normalized && normalized !== borough && !/^ny\s*\d*$/i.test(part) && !/^\d{5}$/.test(part);
  }) ?? "";
}

export function providerUnitOffers(listing: Listing, input: RenterBrief): UnitOffer[] {
  const layouts = providerLayouts(listing.unitSize, listing.beds);
  const household = providerHouseholdRange(listing.description);
  const publishedRents = moneyValues(listing.rentRange);
  const statedRent = finiteNumber(listing.rent);
  const rents = publishedRents.length
    ? publishedRents
    : statedRent != null && statedRent >= 200
      ? [statedRent]
      : [];
  const minimumIncome = finiteNumber(listing.minIncome);
  const maximumIncome = finiteNumber(listing.maxIncome);
  const incomeBands = minimumIncome != null && minimumIncome > 0 &&
      maximumIncome != null && maximumIncome >= minimumIncome
    ? [{ householdSize: input.householdSize, minimumIncome, maximumIncome }]
    : [];
  const normalizedLayouts = layouts.length
    ? layouts
    : [{ bedrooms: -1, label: compactText(listing.unitSize) || "Unit size needs verification" }];
  const minimumRent = rents[0] ?? null;
  const maximumRent = rents.length > 1 ? rents[rents.length - 1] : null;
  return normalizedLayouts.map((layout, index) => ({
    id: `${compactText(listing.id)}-offer-${layout.bedrooms >= 0 ? layout.bedrooms : index}`,
    layoutTypeId: layout.bedrooms < 0 ? 0 : layout.bedrooms + 1,
    bedrooms: layout.bedrooms,
    label: layout.label,
    rent: minimumRent,
    rentMaximum: maximumRent,
    count: normalizedLayouts.length === 1 ? Math.max(0, finiteNumber(listing.units) ?? 0) : 0,
    address: compactText(listing.address),
    ami: finiteNumber(listing.ami),
    minimumHouseholdSize: household?.minimum ?? 0,
    maximumHouseholdSize: household?.maximum ?? 0,
    incomeBands,
  }));
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
  if (plan.bedrooms && offer.bedrooms < 0) {
    reasons.push("Bedroom layout needs verification");
  } else if (plan.bedrooms && (offer.bedrooms < plan.bedrooms.min || offer.bedrooms > plan.bedrooms.max)) {
    reasons.push(`Needs ${plan.bedrooms.min === plan.bedrooms.max ? plan.bedrooms.min : `${plan.bedrooms.min}+`} bedrooms`);
  }
  if (offer.minimumHouseholdSize <= 0 && offer.maximumHouseholdSize <= 0) {
    reasons.push("Household-size rule is unavailable");
  } else if (
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
  } else if (
    plan.maxRent != null &&
    offer.rent != null &&
    offer.rentMaximum != null &&
    offer.rentMaximum > plan.maxRent
  ) {
    reasons.push("Exact rent for this layout needs verification");
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
  if (plan.boroughs.length && !borough) {
    locationReasons.push("Borough needs verification");
  } else if (plan.boroughs.length && !plan.boroughs.some((item) => borough.toLowerCase().includes(item.toLowerCase()))) {
    locationReasons.push(`Outside ${plan.boroughs.join(" or ")}`);
  }
  if (plan.neighborhoods.length && !neighborhood) {
    locationReasons.push("Neighborhood needs verification");
  } else if (
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
      .filter(isListingPhotoSource)
  );
  if (!photos.length && isListingPhotoSource(summary.defaultPhotoStream)) {
    photos.push(String(summary.defaultPhotoStream));
  }
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
    provider: "housing-connect",
    providerLabel: "NYC Housing Connect",
    source,
  };
}

export function providerListingBase(
  listing: Listing,
  input: RenterBrief,
  plan: SearchPlan
): MarketplaceListing | null {
  const provider = providerForSource(listing?.source);
  const id = compactText(listing?.id);
  const title = compactText(listing?.name);
  const address = compactText(listing?.address);
  const borough = compactText(listing?.borough);
  if (!provider || !/^[a-zA-Z0-9-]{1,180}$/.test(id) || !title || !address || !borough) return null;

  const offers = providerUnitOffers(listing, input);
  const neighborhood = providerNeighborhood(listing);
  const eligibility = evaluateEligibility(offers, borough, neighborhood, input, plan);
  const photos = unique([...(Array.isArray(listing.imageUrls) ? listing.imageUrls : []), listing.imageUrl ?? ""])
    .map(compactText)
    .filter(isListingPhotoSource);
  const latitude = finiteNumber(listing.lat);
  const longitude = finiteNumber(listing.lon);
  const zip = compactText(listing.zip) || address.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || "";
  const description = compactText(listing.description) ||
    `Affordable re-rental opportunity published by ${PROVIDERS[provider].label}. Verify current availability and terms with the provider.`;
  const applicationUrl = safeProviderApplyUrl(
    provider,
    listing.applicationUrl,
    listing.url
  );

  return {
    id,
    title,
    description,
    borough,
    neighborhood,
    address,
    latitude,
    longitude,
    deadline: "",
    units: Math.max(0, finiteNumber(listing.units) ?? 0),
    photo: photos[0] ?? null,
    photos,
    amenities: providerAmenities(description),
    transit: providerTransit(description),
    nearby: [],
    buildings: [{
      address,
      city: borough,
      zip,
      latitude,
      longitude,
      bbl: "",
      bin: "",
    }],
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
    applyUrl: applicationUrl,
    provider,
    providerLabel: PROVIDERS[provider].label,
    source: "snapshot",
  };
}

function providerPreliminaryScore(listing: Listing, input: RenterBrief, plan: SearchPlan) {
  let score = 0;
  const borough = compactText(listing.borough).toLowerCase();
  if (plan.boroughs.length) {
    score += plan.boroughs.some((item) => borough.includes(item.toLowerCase())) ? 55 : -35;
  }
  const layouts = providerLayouts(listing.unitSize, listing.beds);
  if (plan.bedrooms) {
    score += layouts.some((layout) =>
      layout.bedrooms >= plan.bedrooms!.min && layout.bedrooms <= plan.bedrooms!.max
    ) ? 40 : layouts.length ? -30 : -5;
  }
  const rent = finiteNumber(listing.rent) ?? moneyValues(listing.rentRange)[0] ?? null;
  if (plan.maxRent != null && rent != null) score += rent <= plan.maxRent ? 30 : -20;
  const minimumIncome = finiteNumber(listing.minIncome);
  const maximumIncome = finiteNumber(listing.maxIncome);
  if (minimumIncome != null && maximumIncome != null) {
    score += input.annualIncome >= minimumIncome && input.annualIncome <= maximumIncome ? 30 : -18;
  }
  const text = `${listing.description ?? ""} ${listing.unitSize ?? ""}`.toLowerCase();
  score += plan.amenities.filter((amenity) => text.includes(amenity.toLowerCase())).length * 6;
  const transit = providerTransit(text);
  score += plan.subwayLines.filter((line) => transit.includes(line)).length * 8;
  return score;
}

export function chooseProviderCandidates(
  listings: Listing[],
  input: RenterBrief,
  plan: SearchPlan,
  limit = PROVIDER_CANDIDATE_LIMIT
) {
  const ranked = listings
    .filter((listing) => providerForSource(listing.source))
    .sort((a, b) => providerPreliminaryScore(b, input, plan) - providerPreliminaryScore(a, input, plan));
  const firstPerProvider: Listing[] = [];
  const seenProviders = new Set<string>();
  for (const listing of ranked) {
    const provider = providerForSource(listing.source);
    if (!provider || seenProviders.has(provider)) continue;
    seenProviders.add(provider);
    firstPerProvider.push(listing);
  }
  const retainedIds = unique([...firstPerProvider, ...ranked].map((listing) => listing.id)).slice(0, limit);
  return retainedIds.map((id) => ranked.find((listing) => listing.id === id)!);
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
  if (!hasSpecificStreetAddress(building.address)) {
    return { building, address: null };
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
    const prefix = listing.eligibility.status === "unknown" ? "Verify eligibility" : "Near match";
    return `${prefix}: ${listing.eligibility.reasons.join("; ") || "eligibility needs verification"}.`;
  }
  const offer = listing.offers.find((item) => listing.matchedOfferIds.includes(item.id));
  const offerText = offer
    ? `${offer.label}${offer.rent != null ? ` at $${offer.rent.toLocaleString()}/month` : ""}`
    : "an eligible unit";
  const risk = listing.risk.level === "Unavailable" ? "building record unavailable" : `${listing.risk.level.toLowerCase()} building risk`;
  return `Your household and income fit ${offerText}; ${risk}.`;
}

function footprintCenter(assessment: BuildingAssessment | undefined) {
  const ring = assessment?.profile?.footprint?.ring ?? [];
  if (!ring.length) return null;
  const latitude = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const longitude = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

export function initialRecordPrecheck(
  categories: PrecheckRequirement[],
  completeRecord: boolean
): PrecheckKit {
  if (categories.length) {
    return { categories, items: [], total: null, pricingStatus: "unavailable", oneTime: true };
  }
  return completeRecord
    ? { categories: [], items: [], total: 0, pricingStatus: "priced", oneTime: true }
    : { categories: [], items: [], total: null, pricingStatus: "unavailable", oneTime: true };
}

export async function enrichListing(
  listing: MarketplaceListing,
  signal?: AbortSignal
): Promise<MarketplaceListing> {
  throwIfAborted(signal);
  const joins = listing.provider === "housing-connect"
    ? await fetchHousingConnectBuildings(listing.id, signal)
    : [];
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
  const completeRecord = assessments.length > 0 &&
    assessments.length === identities.length &&
    assessments.every((assessment) => assessment.recordAvailable) &&
    !hasMultipleBuildingAddresses(listing.address);
  const aggregate = aggregateRisk(assessments);
  const risk: RiskSummary = completeRecord
    ? aggregate
    : {
        ...aggregate,
        level: aggregate.level === "Low" ? "Unavailable" : aggregate.level,
        explanation: aggregate.level === "Unavailable"
          ? "The complete building record could not be verified; this listing was not treated as clean."
          : `${aggregate.explanation} Record coverage is incomplete for this listing.`,
      };
  const center = footprintCenter(assessments.find((assessment) => assessment.profile?.footprint));
  const buildings = identities.map((identity, index) => ({
    ...identity.building,
    latitude: identity.building.latitude ?? (index === 0 ? center?.latitude ?? null : null),
    longitude: identity.building.longitude ?? (index === 0 ? center?.longitude ?? null : null),
  }));
  const primaryBuilding = buildings[0];
  let subwayStations: Awaited<ReturnType<typeof lookupNearbySubway>> = [];
  if (
    !listing.transit.length &&
    primaryBuilding &&
    (primaryBuilding.latitude != null || hasSpecificStreetAddress(primaryBuilding.address))
  ) {
    try {
      subwayStations = await lookupNearbySubway(
        `${primaryBuilding.address}, ${primaryBuilding.city || listing.borough}, NY ${primaryBuilding.zip}`,
        primaryBuilding.latitude,
        primaryBuilding.longitude,
        signal
      );
    } catch (error) {
      throwIfAborted(signal);
    }
  }
  const transit = subwayStations.length
    ? unique(subwayStations.flatMap((station) => station.routes))
    : listing.transit;
  const enriched: MarketplaceListing = {
    ...listing,
    latitude: listing.latitude ?? primaryBuilding?.latitude ?? center?.latitude ?? null,
    longitude: listing.longitude ?? primaryBuilding?.longitude ?? center?.longitude ?? null,
    buildings,
    transit,
    nearby: subwayStations.length
      ? subwayStations.map((station) => ({
          name: station.name,
          type: "Subway",
          train: station.routes.join(" "),
        }))
      : listing.nearby,
    risk,
    precheck: initialRecordPrecheck(categories, completeRecord),
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
  const relevantOffers = matched.length ? matched : listing.offers;
  const rent = Math.min(...relevantOffers.map((offer) => offer.rent ?? Number.MAX_SAFE_INTEGER));
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
  const providerRepresentatives = [...new Set(
    ranked
      .filter((listing) => listing.provider !== "housing-connect" && listing.provider !== "recorded")
      .map((listing) => listing.provider)
  )].flatMap((provider) => ranked.find((listing) => listing.provider === provider) ?? []);
  const retained = unique([
    ...ranked.slice(0, coreLimit).map((listing) => listing.id),
    ...providerRepresentatives.map((listing) => listing.id),
    ...actionable.map((listing) => listing.id),
  ])
    .slice(0, MARKETPLACE_RESULT_LIMIT)
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
  const providerInventory = searchListings({
    actionableOnly: true,
    annualIncome: input.annualIncome,
    limit: 100,
  }).filter((listing) => providerForSource(listing.source));
  const providerLabels = unique(
    providerInventory.flatMap((listing) => {
      const provider = providerForSource(listing.source);
      return provider ? [PROVIDERS[provider].label] : [];
    })
  );
  emit({
    stage: "inventory",
    message: `Found ${inventory.rentals.length} Housing Connect lotteries and ${providerInventory.length} provider re-rentals across ${providerLabels.length} additional sources`,
    count: inventory.rentals.length + providerInventory.length,
    source: inventory.source,
    housingConnectCount: inventory.rentals.length,
    providerCount: providerInventory.length,
    providers: providerLabels,
  });
  const housingCandidates = chooseMarketplaceCandidates(inventory.rentals, input, plan)
    .slice(0, HOUSING_CONNECT_CANDIDATE_LIMIT);
  const providerCandidates = chooseProviderCandidates(providerInventory, input, plan);
  const totalCandidates = housingCandidates.length + providerCandidates.length;
  emit({
    stage: "inspecting",
    message: "Reading published unit, rent, household, and income requirements",
    completed: 0,
    total: totalCandidates,
  });
  const housingBases = await mapWithConcurrency(
    housingCandidates,
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
  const providerBases = providerCandidates
    .map((listing) => providerListingBase(listing, input, plan))
    .filter((listing): listing is MarketplaceListing => Boolean(listing));
  const bases = [...housingBases, ...providerBases];
  let completed = 0;
  const inspected = await mapWithConcurrency(
    bases,
    2,
    async (listing) => {
      const result = await enrichListing(listing, signal);
      completed += 1;
      emit({
        stage: "inspecting",
        message: `Checked ${completed} of ${bases.length} listings against NYC building records`,
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
  const near = sorted.filter((listing) => listing.eligibility.status === "near");
  const unknown = sorted.filter((listing) => listing.eligibility.status === "unknown");
  emit({ stage: "results", exact, near, unknown, showcase });
  return { plan, exact, near, unknown, showcase };
}

export async function getMarketplaceListing(id: string, input?: RenterBrief, signal?: AbortSignal) {
  if (id === PRECHECK_SHOWCASE_ID) {
    const [contextualized] = await addContextualPrecheck([recordedPrecheckShowcase()], undefined, signal);
    return (await pricePrecheckKits([contextualized], undefined, signal))[0];
  }
  if (!/^\d+$/.test(id)) {
    const external = getListing(id);
    if (!external || !providerForSource(external.source)) return null;
    const renter = input ?? {
      brief: "",
      householdSize: 1,
      annualIncome: Math.max(1, finiteNumber(external.minIncome) ?? 1),
    };
    const plan = input
      ? await planRenterSearch(renter, signal)
      : parseBriefDeterministically(renter);
    const base = providerListingBase(external, renter, plan);
    if (!base) return null;
    const enriched = await enrichListing(base, signal);
    const [contextualized] = await addContextualPrecheck([enriched], undefined, signal);
    return (await pricePrecheckKits([contextualized], undefined, signal))[0];
  }
  const found = await getLotterySummary(id, signal);
  if (!found) return null;
  const renter = input ?? {
    brief: "",
    householdSize: Math.max(1, Number(found.summary.minHouseholdSize) || 1),
    annualIncome: Math.max(1, Number(found.summary.minIncome) || 1),
  };
  const plan = input
    ? await planRenterSearch(renter, signal)
    : parseBriefDeterministically(renter);
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
