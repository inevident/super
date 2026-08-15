type Entrance = {
  stop_name?: string;
  constituent_station_name?: string;
  daytime_routes?: string;
  entrance_latitude?: string;
  entrance_longitude?: string;
};

type ParsedEntrance = {
  name: string;
  routes: string[];
  latitude: number;
  longitude: number;
};

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type NearbyStation = {
  name: string;
  routes: string[];
  distanceMiles: number;
};

const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
const ENTRANCES = new URL("https://data.ny.gov/resource/i9wp-a4ja.json");
ENTRANCES.search = new URLSearchParams({
  $select: "stop_name,constituent_station_name,daytime_routes,entrance_latitude,entrance_longitude",
  $limit: "3000",
}).toString();

const ENTRANCE_TTL = 24 * 60 * 60_000;
const RESULT_TTL = 15 * 60_000;
const MAX_NEARBY_DISTANCE_MILES = 1;
let entranceCache: { expires: number; rows: ParsedEntrance[] } | null = null;
let entranceRequest: Promise<ParsedEntrance[]> | null = null;
const resultCache = new Map<string, { expires: number; stations: NearbyStation[] }>();

function abortError() {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

function finiteCoordinate(value: unknown): number | null {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function withinNyc(latitude: number, longitude: number) {
  return latitude >= 40.45 && latitude <= 40.95 && longitude >= -74.30 && longitude <= -73.65;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  fetcher: Fetcher,
  timeoutMs = 7_000
) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function parseEntrances(rows: Entrance[]) {
  return rows.flatMap((row): ParsedEntrance[] => {
    const name = String(row.constituent_station_name || row.stop_name || "").trim();
    const latitude = finiteCoordinate(row.entrance_latitude);
    const longitude = finiteCoordinate(row.entrance_longitude);
    if (!name || latitude == null || longitude == null) return [];
    const routes = [...new Set(
      String(row.daytime_routes ?? "")
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter(Boolean)
    )];
    return [{ name, routes, latitude, longitude }];
  });
}

async function getEntrances(signal: AbortSignal | undefined, fetcher: Fetcher) {
  if (entranceCache && entranceCache.expires > Date.now()) return entranceCache.rows;
  if (!entranceRequest) {
    entranceRequest = (async () => {
      const response = await fetchWithTimeout(ENTRANCES.href, { cache: "no-store" }, undefined, fetcher);
      if (!response.ok) throw new Error(`Subway entrances ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error("Subway entrances returned an invalid payload");
      const rows = parseEntrances(body);
      entranceCache = { expires: Date.now() + ENTRANCE_TTL, rows };
      return rows;
    })().finally(() => {
      entranceRequest = null;
    });
  }
  return waitWithSignal(entranceRequest, signal);
}

function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = Math.PI / 180;
  const latitudeDelta = (lat2 - lat1) * radians;
  const longitudeDelta = (lon2 - lon1) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function lookupNearbySubway(
  address: string,
  latitude?: number | null,
  longitude?: number | null,
  signal?: AbortSignal,
  fetcher: Fetcher = fetch
): Promise<NearbyStation[]> {
  if (signal?.aborted) throw abortError();
  let lat = finiteCoordinate(latitude);
  let lon = finiteCoordinate(longitude);
  if (lat == null || lon == null || !withinNyc(lat, lon)) {
    const response = await fetchWithTimeout(
      `${GEOSEARCH}?text=${encodeURIComponent(address)}`,
      { cache: "no-store" },
      signal,
      fetcher
    );
    if (!response.ok) throw new Error(`NYC Geosearch ${response.status}`);
    const body = await response.json();
    const coordinates = body?.features?.[0]?.geometry?.coordinates;
    lon = finiteCoordinate(coordinates?.[0]);
    lat = finiteCoordinate(coordinates?.[1]);
    if (lat == null || lon == null || !withinNyc(lat, lon)) return [];
  }

  const cacheKey = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.stations;
  const entrances = await getEntrances(signal, fetcher);
  if (signal?.aborted) throw abortError();
  const stations = new Map<string, NearbyStation>();
  for (const entrance of entrances) {
    const distance = distanceMiles(lat, lon, entrance.latitude, entrance.longitude);
    const current = stations.get(entrance.name);
    if (!current || distance < current.distanceMiles) {
      stations.set(entrance.name, {
        name: entrance.name,
        routes: entrance.routes,
        distanceMiles: distance,
      });
    }
  }
  const nearest = [...stations.values()]
    .filter((station) => station.distanceMiles <= MAX_NEARBY_DISTANCE_MILES)
    .sort((a, b) => a.distanceMiles - b.distanceMiles)
    .slice(0, 3);
  resultCache.set(cacheKey, { expires: Date.now() + RESULT_TTL, stations: nearest });
  return nearest;
}

export function resetTransitCacheForTests() {
  entranceCache = null;
  entranceRequest = null;
  resultCache.clear();
}
