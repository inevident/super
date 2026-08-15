import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { UnitIncomeBand, UnitOffer } from "./types";

const API = "https://a806-housingconnectapi.nyc.gov/HPDPublicAPI/api";
const SEARCH_URL = `${API}/Lottery/SearchLotteries`;
const DETAIL_URL = `${API}/Lottery/GetLotteryAdvertisement`;
const SEARCH_TTL = 5 * 60_000;
const DETAIL_TTL = 10 * 60_000;

const SEARCH_BODY = {
  UnitTypes: [],
  NearbyPlaces: [],
  NearbySubways: [],
  Amenities: [],
  Applied: null,
  HPDUserId: null,
  Boroughs: [],
  Neighborhoods: [],
  HouseholdSize: null,
  Income: "",
  HouseholdType: 2,
  OwnerTypes: [],
  PreferanceTypes: [],
  LotteryTypes: [],
  Min: null,
  Max: null,
  RentalSubsidy: null,
};

export type HousingMarker = {
  name?: string;
  lat?: string;
  lng?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
};

export type HousingLotterySummary = {
  lotteryId: number;
  lotteryName?: string;
  lotteryDescription?: string;
  rents?: string | null;
  maxIncome?: number;
  minIncome?: number;
  minHouseholdSize?: number;
  maxHouseholdSize?: number;
  lotteryEndDate?: string;
  defaultPhotoStream?: string;
  trains?: string;
  markers?: HousingMarker[];
  borough?: string;
  neighborhood?: string;
  amenities?: string;
  studios?: number;
  oneBR?: number;
  twoBR?: number;
  threeBR?: number;
  fourBR?: number;
  fiveBR?: number;
  sixBR?: number;
  units?: number;
  [key: string]: unknown;
};

export type HousingAdvertisement = {
  lotteryId: number;
  lotteryName?: string;
  lotteryDescription?: string;
  endDate?: string;
  photos?: { item1?: string; item2?: string; item3?: number }[];
  lotteryBuildings?: Array<{
    buildingId?: number;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    latitude?: string;
    longitude?: string;
    nearbyPlaces?: Array<{
      nearbyPlaceName?: string;
      placeType?: string;
      trainName?: string | null;
    }>;
  }>;
  amenities?: { name?: string; isBuildingLevel?: boolean }[];
  units?: Record<string, any>[];
  [key: string]: unknown;
};

export type HousingInventory = {
  rentals: HousingLotterySummary[];
  source: "live" | "snapshot";
};

type Snapshot = {
  capturedAt?: string;
  rentals?: HousingLotterySummary[];
  details?: Record<string, HousingAdvertisement | null>;
};

let inventoryCache: { expires: number; value: HousingInventory } | null = null;
const detailCache = new Map<
  string,
  { expires: number; value: { detail: HousingAdvertisement; source: "live" | "snapshot" } }
>();
let snapshotCache: Snapshot | null = null;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

function snapshot(): Snapshot {
  if (snapshotCache) return snapshotCache;
  try {
    snapshotCache = JSON.parse(
      readFileSync(join(process.cwd(), "public", "housing-connect-snapshot.json"), "utf8")
    ) as Snapshot;
  } catch {
    snapshotCache = { rentals: [], details: {} };
  }
  return snapshotCache;
}

export async function getHousingInventory(): Promise<HousingInventory> {
  if (inventoryCache && inventoryCache.expires > Date.now()) return inventoryCache.value;

  try {
    const response = await fetchWithTimeout(
      SEARCH_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(SEARCH_BODY),
      },
      8_000
    );
    if (!response.ok) throw new Error(`Housing Connect ${response.status}`);
    const body = await response.json();
    const rentals = Array.isArray(body?.rentals) ? body.rentals : [];
    if (!rentals.length) throw new Error("Housing Connect returned no active rentals");
    const value: HousingInventory = { rentals, source: "live" };
    inventoryCache = { expires: Date.now() + SEARCH_TTL, value };
    return value;
  } catch {
    const rentals = snapshot().rentals ?? [];
    if (!rentals.length) throw new Error("Housing Connect is temporarily unavailable");
    const value: HousingInventory = { rentals, source: "snapshot" };
    inventoryCache = { expires: Date.now() + 60_000, value };
    return value;
  }
}

export async function getLotteryDetail(
  lotteryId: string | number
): Promise<{ detail: HousingAdvertisement; source: "live" | "snapshot" } | null> {
  const key = String(lotteryId);
  const cached = detailCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  try {
    const response = await fetchWithTimeout(
      `${DETAIL_URL}?lotteryId=${encodeURIComponent(key)}`,
      { headers: { accept: "application/json" } },
      7_000
    );
    if (!response.ok) throw new Error(`Housing Connect detail ${response.status}`);
    const detail = (await response.json()) as HousingAdvertisement;
    if (!detail?.lotteryId) throw new Error("Missing Housing Connect advertisement");
    const value = { detail, source: "live" as const };
    detailCache.set(key, { expires: Date.now() + DETAIL_TTL, value });
    return value;
  } catch {
    const detail = snapshot().details?.[key];
    if (!detail) return null;
    const value = { detail, source: "snapshot" as const };
    detailCache.set(key, { expires: Date.now() + 60_000, value });
    return value;
  }
}

export async function getLotterySummary(lotteryId: string | number) {
  const inventory = await getHousingInventory();
  const summary = inventory.rentals.find((item) => String(item.lotteryId) === String(lotteryId));
  return summary ? { summary, source: inventory.source } : null;
}

export function bedroomsForLayout(layoutTypeId: number) {
  if (layoutTypeId <= 1) return 0;
  if (layoutTypeId >= 7) return 6;
  return layoutTypeId - 1;
}

function numberOrZero(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function incomeBands(unit: Record<string, any>): UnitIncomeBand[] {
  const rows = Array.isArray(unit.unitIncome) ? unit.unitIncome : [];
  return rows
    .map((row: Record<string, any>) => ({
      householdSize: numberOrZero(row.houseHoldSize ?? row.householdSize),
      minimumIncome: numberOrZero(row.minimumIncome),
      maximumIncome: numberOrZero(row.maximumIncome),
    }))
    .filter((row: UnitIncomeBand) => row.householdSize > 0 && row.maximumIncome > 0)
    .sort((a: UnitIncomeBand, b: UnitIncomeBand) => a.householdSize - b.householdSize);
}

export function groupUnitOffers(units: Record<string, any>[] = []): UnitOffer[] {
  const grouped = new Map<string, UnitOffer>();

  for (const unit of units) {
    const layoutTypeId = numberOrZero(unit.unitLayoutTypeId);
    const bedrooms = bedroomsForLayout(layoutTypeId);
    const rentValue = Number(unit.actualRent);
    const rent = Number.isFinite(rentValue) && rentValue >= 0 ? rentValue : null;
    const bands = incomeBands(unit);
    const minimumHouseholdSize = numberOrZero(unit.minimumHouseholdSize);
    const maximumHouseholdSize = numberOrZero(unit.maximumHouseholdSize);
    const amiValue = Number(unit.unitRegulatoryMechanismAmi);
    const ami = Number.isFinite(amiValue) && amiValue > 0 ? amiValue : null;
    const address = String(unit.address ?? "").trim();
    const label = String(unit.unitLayoutTypeName ?? (bedrooms ? `${bedrooms} Bedroom` : "Studio")).trim();
    const bandKey = bands
      .map((band) => `${band.householdSize}:${band.minimumIncome}:${band.maximumIncome}`)
      .join(",");
    const key = [
      layoutTypeId,
      rent ?? "unknown",
      address.toUpperCase(),
      ami ?? "",
      minimumHouseholdSize,
      maximumHouseholdSize,
      bandKey,
    ].join("|");
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    grouped.set(key, {
      id: `offer-${grouped.size + 1}-${layoutTypeId}-${rent ?? "na"}`,
      layoutTypeId,
      bedrooms,
      label,
      rent,
      count: 1,
      address,
      ami,
      minimumHouseholdSize,
      maximumHouseholdSize,
      incomeBands: bands,
    });
  }

  return [...grouped.values()].sort((a, b) => {
    if (a.bedrooms !== b.bedrooms) return a.bedrooms - b.bedrooms;
    return (a.rent ?? Number.MAX_SAFE_INTEGER) - (b.rent ?? Number.MAX_SAFE_INTEGER);
  });
}

export function summaryBedroomCounts(summary: HousingLotterySummary) {
  return [
    numberOrZero(summary.studios),
    numberOrZero(summary.oneBR),
    numberOrZero(summary.twoBR),
    numberOrZero(summary.threeBR),
    numberOrZero(summary.fourBR),
    numberOrZero(summary.fiveBR),
    numberOrZero(summary.sixBR),
  ];
}
