type Entrance = {
  stop_name?: string;
  constituent_station_name?: string;
  daytime_routes?: string;
  entrance_latitude?: string;
  entrance_longitude?: string;
};

export type NearbyStation = { name: string; routes: string[]; distanceMiles: number };

const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
const ENTRANCES = "https://data.ny.gov/resource/i9wp-a4ja.json?$limit=3000";

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function lookupNearbySubway(address: string, latitude?: number | null, longitude?: number | null): Promise<NearbyStation[]> {
  try {
    let lat = latitude;
    let lon = longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const geoResponse = await fetchWithTimeout(`${GEOSEARCH}?text=${encodeURIComponent(address)}`, { cache: "no-store" });
      if (!geoResponse.ok) return [];
      const geo = await geoResponse.json();
      [lon, lat] = geo.features?.[0]?.geometry?.coordinates ?? [];
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

    const entrancesResponse = await fetchWithTimeout(ENTRANCES, { next: { revalidate: 86400 } });
    if (!entrancesResponse.ok) return [];
    const entrances = await entrancesResponse.json() as Entrance[];
    const stations = new Map<string, NearbyStation>();
    for (const entrance of entrances) {
      const stationLat = Number(entrance.entrance_latitude);
      const stationLon = Number(entrance.entrance_longitude);
      const name = entrance.constituent_station_name || entrance.stop_name;
      if (!name || !Number.isFinite(stationLat) || !Number.isFinite(stationLon)) continue;
      const distance = distanceMiles(lat!, lon!, stationLat, stationLon);
      const current = stations.get(name);
      if (!current || distance < current.distanceMiles) {
        stations.set(name, { name, routes: (entrance.daytime_routes ?? "").split(/\s+/).filter(Boolean), distanceMiles: distance });
      }
    }
    return [...stations.values()].sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, 3);
  } catch {
    return [];
  }
}
