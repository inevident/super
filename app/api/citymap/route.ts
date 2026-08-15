// Citywide violation density. One Socrata aggregation over every open violation
// in NYC, grouped to the building and returned as flat arrays so the payload
// stays small enough to ship to the browser.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SODA = "https://data.cityofnewyork.us/resource";
const OPEN = "currentstatus NOT LIKE '%CLOSED%' AND currentstatus NOT LIKE '%DISMISSED%'";

let cache: { at: number; body: string } | null = null;
const TTL = 10 * 60 * 1000;

export async function GET(req: Request) {
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit")) || 4000, 8000);

  if (cache && Date.now() - cache.at < TTL) {
    return new Response(cache.body, {
      headers: { "content-type": "application/json" },
    });
  }

  const url =
    `${SODA}/wvxf-dwi5.json` +
    `?$select=boro,latitude,longitude,count(violationid) AS n` +
    `&$where=${encodeURIComponent(OPEN + " AND latitude IS NOT NULL")}` +
    `&$group=boro,latitude,longitude&$order=n DESC&$limit=${limit}`;

  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return Response.json({ error: `soda ${r.status}` }, { status: 502 });

  const rows: any[] = await r.json();

  // Flat arrays, coords rounded to ~1m. Cuts the payload roughly in half versus
  // an array of objects.
  const lat: number[] = [];
  const lon: number[] = [];
  const n: number[] = [];
  const boro: number[] = [];
  const BOROS = ["MANHATTAN", "BRONX", "BROOKLYN", "QUEENS", "STATEN ISLAND"];

  for (const row of rows) {
    const la = Number(row.latitude);
    const lo = Number(row.longitude);
    const c = Number(row.n);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || !c) continue;
    lat.push(Math.round(la * 1e5) / 1e5);
    lon.push(Math.round(lo * 1e5) / 1e5);
    n.push(c);
    boro.push(Math.max(0, BOROS.indexOf(String(row.boro).toUpperCase())));
  }

  const body = JSON.stringify({
    count: lat.length,
    total: n.reduce((a, b) => a + b, 0),
    boros: BOROS,
    lat,
    lon,
    n,
    boro,
  });

  cache = { at: Date.now(), body };
  return new Response(body, { headers: { "content-type": "application/json" } });
}
