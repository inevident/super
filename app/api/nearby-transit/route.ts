import { NextRequest, NextResponse } from "next/server";

type Entrance = {
  stop_name?: string;
  constituent_station_name?: string;
  daytime_routes?: string;
  entrance_latitude?: string;
  entrance_longitude?: string;
};

const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
const ENTRANCES = "https://data.ny.gov/resource/i9wp-a4ja.json?$limit=3000";

function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address")?.trim();
  if (!address) return NextResponse.json({ stations: [] }, { status: 400 });

  try {
    const [geoResponse, entrancesResponse] = await Promise.all([
      fetch(`${GEOSEARCH}?text=${encodeURIComponent(address)}`, { cache: "no-store" }),
      fetch(ENTRANCES, { next: { revalidate: 86400 } }),
    ]);
    if (!geoResponse.ok || !entrancesResponse.ok) throw new Error("Transit data unavailable");
    const geo = await geoResponse.json();
    const [lon, lat] = geo.features?.[0]?.geometry?.coordinates ?? [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return NextResponse.json({ stations: [] });

    const entrances = await entrancesResponse.json() as Entrance[];
    const unique = new Map<string, { name: string; routes: string[]; distanceMiles: number }>();
    for (const entrance of entrances) {
      const stationLat = Number(entrance.entrance_latitude);
      const stationLon = Number(entrance.entrance_longitude);
      const name = entrance.constituent_station_name || entrance.stop_name;
      if (!name || !Number.isFinite(stationLat) || !Number.isFinite(stationLon)) continue;
      const distance = distanceMiles(lat, lon, stationLat, stationLon);
      const current = unique.get(name);
      if (!current || distance < current.distanceMiles) unique.set(name, { name, routes: (entrance.daytime_routes ?? "").split(/\s+/).filter(Boolean), distanceMiles: distance });
    }
    const stations = [...unique.values()].sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, 3);
    return NextResponse.json({ stations });
  } catch {
    return NextResponse.json({ stations: [] }, { status: 502 });
  }
}
