// Preprocesses the NYC street centerline into a compact snapshot for the city
// heat map's ground plane.
//
// Registration is the whole game here: the streets must land in exactly the same
// local metre space as the violation columns, or the city will float off its own
// streets. So the projection origin and centring offset are derived from
// public/citymap.json using the identical arithmetic CityMap.tsx performs.
//
//   node scripts/streets.mjs

import { readFileSync, writeFileSync } from "node:fs";

const SODA = "https://data.cityofnewyork.us/resource/inkn-q76z.json";
const PAGE = 50000;
const KINDS = ["1", "2", "3"]; // street, highway, bridge — no alleys/ramps/driveways

const city = JSON.parse(readFileSync("public/citymap.json", "utf8"));

// --- mirror CityMap.tsx exactly -------------------------------------------
const lat0 = city.lat.reduce((a, b) => a + b, 0) / city.count;
const lon0 = city.lon.reduce((a, b) => a + b, 0) / city.count;
const cosLat = Math.cos((lat0 * Math.PI) / 180);
const project = (lon, lat) => [(lon - lon0) * 111320 * cosLat, (lat - lat0) * 110540];

const cxs = city.lon.map((lo) => (lo - lon0) * 111320 * cosLat);
const cys = city.lat.map((la) => (la - lat0) * 110540);
const cx = (Math.max(...cxs) + Math.min(...cxs)) / 2;
const cy = (Math.max(...cys) + Math.min(...cys)) / 2;
// --------------------------------------------------------------------------

const where = `rw_type in(${KINDS.map((k) => `'${k}'`).join(",")})`;

const xs = [];
const ys = [];
const lens = []; // points per polyline, so the client can walk the flat arrays

let offset = 0;
let segments = 0;

for (let page = 0; page < 10; page++) {
  const url =
    `${SODA}?$select=the_geom&$where=${encodeURIComponent(where)}` +
    `&$limit=${PAGE}&$offset=${offset}`;
  process.stdout.write(`  page ${page + 1} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`soda ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  console.log(`${rows.length} rows`);
  if (!rows.length) break;

  for (const row of rows) {
    const geom = row.the_geom;
    if (!geom?.coordinates) continue;
    const lines = geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];
    for (const line of lines) {
      if (!Array.isArray(line) || line.length < 2) continue;
      let kept = 0;
      for (const pt of line) {
        const [px, py] = project(pt[0], pt[1]);
        // Whole metres. Sub-metre precision is invisible at city scale and
        // roughly halves the file.
        xs.push(Math.round(px - cx));
        ys.push(Math.round(py - cy));
        kept++;
      }
      lens.push(kept);
      segments++;
    }
  }

  offset += rows.length;
  if (rows.length < PAGE) break;
}

const out = { segments, points: xs.length, xs, ys, lens };
writeFileSync("public/streets.json", JSON.stringify(out));

const kb = Math.round(Buffer.byteLength(JSON.stringify(out)) / 1024);
console.log(`\n  segments : ${segments.toLocaleString()}`);
console.log(`  points   : ${xs.length.toLocaleString()}`);
// Spread would blow the stack at 320k args.
const range = (a) => a.reduce((r, v) => [Math.min(r[0], v), Math.max(r[1], v)], [Infinity, -Infinity]);
const [x0, x1] = range(xs);
const [y0, y1] = range(ys);
console.log(`  bbox     : x ${x0}..${x1}  y ${y0}..${y1}`);
console.log(`  written  : public/streets.json (${kb} KB raw)`);
