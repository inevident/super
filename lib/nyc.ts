// NYC public-data spine: address -> physical building -> verified HPD record.

import type {
  Address,
  BuildingAssessment,
  BuildingFacts,
  BuildingProfile,
  FloorBreakdown,
  Footprint,
  RiskSummary,
  Signal,
  TenantComplaints,
  ViolationRecord,
} from "./types";

const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2";
const SODA = "https://data.cityofnewyork.us/resource";
const PAGE = 1000;
const MAX_PAGES = 5;
const PROFILE_TTL = 10 * 60_000;

type ViolationRow = {
  violationid?: string;
  class?: string;
  inspectiondate?: string;
  currentstatus?: string;
  currentstatusdate?: string;
  novdescription?: string;
  apartment?: string;
  story?: string;
  rentimpairing?: string;
  violationstatus?: string;
  bbl?: string;
  bin?: string;
};

export type HousingConnectBuildingRow = {
  lottery_id?: string;
  hc_building_id?: string;
  hpd_building_id?: string;
  house_number?: string;
  street_name?: string;
  borough?: string;
  address_zipcode?: string;
  address_latitude?: string;
  address_longitude?: string;
  address_buildingidentificationnumber?: string;
  address_bbl?: string;
};

const assessmentCache = new Map<string, { expires: number; value: BuildingAssessment }>();
const buildingJoinCache = new Map<string, { expires: number; value: HousingConnectBuildingRow[] }>();

async function fetchJson(url: string, timeoutMs = 6_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`NYC Open Data ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function suggestAddresses(text: string): Promise<string[]> {
  if (text.trim().length < 3) return [];
  try {
    const data = await fetchJson(`${GEOSEARCH}/autocomplete?text=${encodeURIComponent(text)}`, 4_000);
    return (data.features ?? [])
      .filter((feature: any) => feature.properties?.addendum?.pad?.bbl)
      .map((feature: any) => feature.properties.label as string)
      .slice(0, 6);
  } catch {
    return [];
  }
}

export async function resolveAddress(text: string): Promise<Address> {
  const data = await fetchJson(`${GEOSEARCH}/search?text=${encodeURIComponent(text)}`, 5_000);
  const feature = data.features?.find((item: any) => item.properties?.addendum?.pad?.bbl);
  if (!feature) throw new Error(`No NYC building found for "${text}"`);
  return {
    label: feature.properties.label,
    bbl: String(feature.properties.addendum.pad.bbl),
    bin: String(feature.properties.addendum.pad.bin ?? ""),
    borough: String(feature.properties.borough ?? ""),
    zip: String(feature.properties.postalcode ?? ""),
  };
}

export async function fetchHousingConnectBuildings(lotteryId: string | number) {
  const key = String(lotteryId);
  const cached = buildingJoinCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const params = new URLSearchParams({
      lottery_id: key,
      $limit: "100",
      $select:
        "lottery_id,hc_building_id,hpd_building_id,house_number,street_name,borough,address_zipcode,address_latitude,address_longitude,address_buildingidentificationnumber,address_bbl",
    });
    const rows = (await fetchJson(`${SODA}/nibs-na6y.json?${params}`)) as HousingConnectBuildingRow[];
    buildingJoinCache.set(key, { expires: Date.now() + 30 * 60_000, value: rows });
    return rows;
  } catch {
    return [];
  }
}

export async function fetchFacts(bbl: string): Promise<BuildingFacts | null> {
  if (!bbl) return null;
  try {
    const params = new URLSearchParams({
      bbl,
      $limit: "1",
      $select: "numfloors,yearbuilt,unitsres,bldgarea,bldgclass",
    });
    const [row] = await fetchJson(`${SODA}/64uk-42ks.json?${params}`);
    if (!row) return null;
    const floors = Math.round(Number(row.numfloors) || 0);
    const units = Number(row.unitsres) || 0;
    const area = Number(row.bldgarea) || 0;
    const buildingClass = String(row.bldgclass ?? "");
    const yearBuilt = Number(row.yearbuilt) || 0;
    return {
      yearBuilt,
      floors,
      residentialUnits: units,
      buildingArea: area,
      sqftPerUnit: units ? Math.round(area / units) : 0,
      buildingClass,
      walkUp:
        buildingClass.startsWith("C") ||
        (floors > 0 && floors <= 5 && !buildingClass.startsWith("D")),
      preWar: yearBuilt > 0 && yearBuilt < 1945,
      likelyLeadPaint: yearBuilt > 0 && yearBuilt < 1978,
    };
  } catch {
    return null;
  }
}

export async function fetchFootprint(bin: string): Promise<Footprint | null> {
  if (!bin) return null;
  try {
    const params = new URLSearchParams({
      bin,
      $limit: "1",
      $select: "the_geom,height_roof,ground_elevation",
    });
    const [row] = await fetchJson(`${SODA}/5zhs-2jue.json?${params}`);
    const geometry = row?.the_geom;
    if (!geometry?.coordinates) return null;
    const ring =
      geometry.type === "MultiPolygon" ? geometry.coordinates[0]?.[0] : geometry.coordinates[0];
    if (!Array.isArray(ring) || ring.length < 3) return null;
    return {
      ring: ring.slice(0, 64) as [number, number][],
      heightRoof: Number(row.height_roof) || 0,
      groundElevation: Number(row.ground_elevation) || 0,
    };
  } catch {
    return null;
  }
}

async function fetch311(zip: string) {
  if (!zip) return [];
  try {
    const since = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const params = new URLSearchParams({
      $select: "complaint_type,count(unique_key) AS n",
      $where: `incident_zip='${zip.replace(/'/g, "")}' AND created_date>'${since}'`,
      $group: "complaint_type",
      $order: "n DESC",
      $limit: "6",
    });
    const rows = await fetchJson(`${SODA}/erm2-nwe9.json?${params}`);
    return rows.map((row: any) => ({ complaint: row.complaint_type, count: Number(row.n) }));
  } catch {
    return [];
  }
}

export async function fetchComplaints(bbl: string): Promise<TenantComplaints | null> {
  if (!bbl) return null;
  try {
    const where = `bbl='${bbl.replace(/'/g, "")}'`;
    const categoryParams = new URLSearchParams({
      $where: where,
      $select: "major_category,count(problem_id) AS n",
      $group: "major_category",
      $order: "n DESC",
      $limit: "6",
    });
    const totalParams = new URLSearchParams({
      $where: where,
      $select: "count(problem_id) AS n,min(received_date) AS first,max(received_date) AS last",
    });
    const [byCategory, totals] = await Promise.all([
      fetchJson(`${SODA}/ygpa-z7cr.json?${categoryParams}`),
      fetchJson(`${SODA}/ygpa-z7cr.json?${totalParams}`),
    ]);
    const total = Number(totals?.[0]?.n) || 0;
    if (!total) return null;
    const first = String(totals[0].first ?? "").slice(0, 4);
    const last = String(totals[0].last ?? "").slice(0, 4);
    return {
      total,
      span: first && last ? (first === last ? first : `${first}–${last}`) : "",
      top: byCategory
        .filter((row: any) => row.major_category)
        .map((row: any) => ({ category: String(row.major_category), count: Number(row.n) })),
    };
  } catch {
    return null;
  }
}

async function fetchOpenViolationRows(bbl: string) {
  const rows: ViolationRow[] = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        bbl,
        violationstatus: "Open",
        $limit: String(PAGE),
        $offset: String(page * PAGE),
        $select:
          "violationid,class,inspectiondate,currentstatus,currentstatusdate,novdescription,apartment,story,rentimpairing,violationstatus,bbl,bin",
        $order: "inspectiondate DESC",
      });
      const batch = (await fetchJson(`${SODA}/wvxf-dwi5.json?${params}`, 8_000)) as ViolationRow[];
      rows.push(...batch);
      if (batch.length < PAGE) return { rows, available: true, truncated: false };
    }
    return { rows, available: true, truncated: true };
  } catch {
    return { rows: [], available: false, truncated: false };
  }
}

async function fetchTotalViolationCount(bbl: string) {
  try {
    const params = new URLSearchParams({ bbl, $select: "count(violationid) AS n" });
    const rows = await fetchJson(`${SODA}/wvxf-dwi5.json?${params}`);
    return Number(rows?.[0]?.n) || 0;
  } catch {
    return null;
  }
}

function truthyFlag(value: unknown) {
  return /^(y|yes|true|1)$/i.test(String(value ?? "").trim());
}

function cleanDescription(value: string) {
  return value
    .replace(/^[§\s\w.\-]*ADM CODE\s*/i, "")
    .replace(/^\([A-Z]\)\s*§?\s*HMC:?\s*/i, "")
    .replace(/^§?\s*[\d.\-]+\s*HMC:?\s*/i, "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);
}

function violationRecord(row: ViolationRow): ViolationRecord {
  const className = String(row.class ?? "").toUpperCase();
  return {
    id: String(row.violationid ?? ""),
    class: className === "A" || className === "B" || className === "C" ? className : "Unknown",
    inspectionDate: String(row.inspectiondate ?? ""),
    status: String(row.violationstatus ?? row.currentstatus ?? "Open"),
    currentStatusDate: String(row.currentstatusdate ?? ""),
    floor: String(row.story ?? "").trim(),
    apartment: String(row.apartment ?? "").trim(),
    rentImpairing: truthyFlag(row.rentimpairing),
    description: cleanDescription(String(row.novdescription ?? "")),
    bbl: String(row.bbl ?? ""),
    bin: String(row.bin ?? ""),
  };
}

export function sortViolations(records: ViolationRecord[]) {
  const severity = { C: 0, B: 1, A: 2, Unknown: 3 } as const;
  return [...records].sort((a, b) => {
    const classOrder = severity[a.class] - severity[b.class];
    if (classOrder) return classOrder;
    return Date.parse(b.inspectionDate || "1970-01-01") - Date.parse(a.inspectionDate || "1970-01-01");
  });
}

export function filterRedevelopmentViolations(records: ViolationRecord[], yearBuilt: number) {
  if (!yearBuilt) return { current: sortViolations(records), historical: [] as ViolationRecord[] };
  const current: ViolationRecord[] = [];
  const historical: ViolationRecord[] = [];
  for (const record of records) {
    const year = Number(record.inspectionDate.slice(0, 4));
    if (year > 0 && year < yearBuilt) historical.push(record);
    else current.push(record);
  }
  return { current: sortViolations(current), historical: sortViolations(historical) };
}

export function calculateRisk(
  records: ViolationRecord[],
  residentialUnits: number | null,
  recordAvailable = true,
  now = new Date()
): RiskSummary {
  if (!recordAvailable) {
    return {
      level: "Unavailable",
      openCount: null,
      classCounts: { A: 0, B: 0, C: 0 },
      recentCount: 0,
      residentialUnits,
      explanation: "HPD record unavailable; this building was not treated as clean.",
    };
  }
  const classCounts = { A: 0, B: 0, C: 0 };
  let recentCount = 0;
  let weighted = 0;
  const recentCutoff = new Date(now);
  recentCutoff.setFullYear(recentCutoff.getFullYear() - 3);
  for (const record of records) {
    if (record.class !== "Unknown") classCounts[record.class] += 1;
    const inspected = new Date(record.inspectionDate);
    const recent = Number.isFinite(inspected.getTime()) && inspected >= recentCutoff;
    if (recent) recentCount += 1;
    const severity = record.class === "C" ? 8 : record.class === "B" ? 3 : 1;
    weighted += severity * (recent ? 1.5 : 1) + (record.rentImpairing ? 4 : 0);
  }
  const units = Math.max(1, residentialUnits ?? 1);
  const perUnit = weighted / units;
  let level: RiskSummary["level"] = "Low";
  if (
    classCounts.C >= Math.max(2, Math.ceil(units * 0.05)) ||
    perUnit >= 3 ||
    records.filter((record) => record.rentImpairing).length >= 2
  ) {
    level = "High";
  } else if (classCounts.B > 0 || classCounts.C > 0 || perUnit >= 0.5 || records.length >= units) {
    level = "Moderate";
  }
  const explanation = !records.length
    ? "No open HPD violations found for the current structure."
    : `${records.length} open: ${classCounts.C} Class C, ${classCounts.B} Class B, ${recentCount} inspected in the last three years.`;
  return {
    level,
    openCount: records.length,
    classCounts,
    recentCount,
    residentialUnits,
    explanation,
  };
}

const STORY_RE = /(\d+)(?:st|nd|rd|th)\s+STORY/i;
const APT_RE = /\bAPT\s+([0-9A-Z]+)/i;

function parseFloorNumber(record: ViolationRecord) {
  const direct = Number(record.floor.replace(/[^0-9]/g, ""));
  if (direct >= 1 && direct <= 120) return direct;
  const match = STORY_RE.exec(record.description);
  const parsed = Number(match?.[1]);
  return parsed >= 1 && parsed <= 120 ? parsed : null;
}

function parseFloors(records: ViolationRecord[]): FloorBreakdown {
  const counts: Record<number, number> = {};
  const apartments: Record<string, number> = {};
  let parsed = 0;
  for (const record of records) {
    const floor = parseFloorNumber(record);
    if (floor) {
      counts[floor] = (counts[floor] ?? 0) + 1;
      parsed += 1;
    }
    const apartment = record.apartment || APT_RE.exec(record.description)?.[1] || "";
    if (apartment) apartments[apartment.toUpperCase()] = (apartments[apartment.toUpperCase()] ?? 0) + 1;
  }
  const floors = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const units = Object.entries(apartments).sort((a, b) => b[1] - a[1]);
  return {
    counts,
    parsed,
    worstFloor: floors.length ? Number(floors[0][0]) : null,
    worstUnit: units.length ? { apt: units[0][0], count: units[0][1] } : null,
  };
}

const THEMES: { kind: string; pattern: RegExp }[] = [
  { kind: "hot water", pattern: /HOT WATER/i },
  { kind: "heat", pattern: /\bHEAT(?:ING)?\b|RADIATOR/i },
  { kind: "vermin", pattern: /ROACH|MICE|\bRATS?\b|VERMIN|BEDBUG/i },
  { kind: "mold", pattern: /MOLD|MILDEW|DAMP/i },
  { kind: "leak", pattern: /LEAK|WATER DAMAGE|SEEPAGE/i },
  { kind: "lead paint", pattern: /\bLEAD\b|PAINT|PLASTER/i },
  { kind: "smoke alarm", pattern: /SMOKE DETECT|CARBON MONOXIDE|FIRE ALARM/i },
  { kind: "window guards", pattern: /WINDOW GUARD/i },
  { kind: "lighting", pattern: /ADEQUATE LIGHT|ILLUMINATION/i },
];

function buildSignals(records: ViolationRecord[]): Signal[] {
  return THEMES.flatMap(({ kind, pattern }) => {
    const hits = records.filter((record) => pattern.test(record.description));
    if (!hits.length) return [];
    const years = hits.map((record) => record.inspectionDate.slice(0, 4)).filter(Boolean).sort();
    return [{ kind, count: hits.length, window: years.length ? `since ${years[0]}` : "", sample: hits[0].description }];
  }).sort((a, b) => b.count - a.count);
}

async function buildAssessment(address: Address): Promise<BuildingAssessment> {
  const [violationResult, totalCount, neighborhood, facts, footprint, complaints] = await Promise.all([
    fetchOpenViolationRows(address.bbl),
    fetchTotalViolationCount(address.bbl),
    fetch311(address.zip),
    fetchFacts(address.bbl),
    fetchFootprint(address.bin),
    fetchComplaints(address.bbl),
  ]);
  const allOpen = violationResult.rows.map(violationRecord);
  const { current, historical } = filterRedevelopmentViolations(allOpen, facts?.yearBuilt ?? 0);
  const risk = calculateRisk(current, facts?.residentialUnits ?? null, violationResult.available);
  const profile: BuildingProfile = {
    address,
    totalViolations: totalCount ?? allOpen.length,
    openViolations: current.length,
    truncated: violationResult.truncated,
    signals: buildSignals(current),
    neighborhood,
    facts,
    footprint,
    floors: parseFloors(current),
    complaints,
  };
  return {
    profile,
    violations: current,
    excludedHistoricalViolations: historical,
    risk,
    recordAvailable: violationResult.available,
  };
}

export async function assessBuilding(address: Address): Promise<BuildingAssessment> {
  const key = address.bbl || `${address.label}|${address.zip}`;
  const cached = assessmentCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = await buildAssessment(address);
  assessmentCache.set(key, { expires: Date.now() + PROFILE_TTL, value });
  return value;
}

export async function buildProfile(address: Address): Promise<BuildingProfile> {
  const assessment = await assessBuilding(address);
  if (!assessment.profile) throw new Error("Building record unavailable");
  return assessment.profile;
}
