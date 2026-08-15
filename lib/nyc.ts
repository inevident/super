// Data spine: address -> BuildingProfile.
// Every endpoint here is keyless and unauthenticated. Verified against production.

import type {
  Address,
  BuildingFacts,
  BuildingProfile,
  FloorBreakdown,
  Footprint,
  Signal,
  TenantComplaints,
} from "./types";

const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2";
const SODA = "https://data.cityofnewyork.us/resource";

// Socrata caps a single page at 1000 rows. Anything at the ceiling is undercounted,
// so we page until exhausted rather than quoting a wrong number on stage.
const PAGE = 1000;
const MAX_PAGES = 5;

export async function suggestAddresses(text: string): Promise<string[]> {
  if (text.trim().length < 3) return [];
  const r = await fetch(
    `${GEOSEARCH}/autocomplete?text=${encodeURIComponent(text)}`,
    { cache: "no-store" }
  );
  if (!r.ok) return [];
  const d = await r.json();
  return (d.features ?? [])
    .filter((f: any) => f.properties?.addendum?.pad?.bbl)
    .map((f: any) => f.properties.label as string)
    .slice(0, 6);
}

export async function resolveAddress(text: string): Promise<Address> {
  const r = await fetch(`${GEOSEARCH}/search?text=${encodeURIComponent(text)}`, {
    cache: "no-store",
  });
  if (!r.ok) throw new Error("address lookup failed");
  const d = await r.json();
  const f = d.features?.find((x: any) => x.properties?.addendum?.pad?.bbl);
  if (!f) throw new Error(`No NYC building found for "${text}"`);
  return {
    label: f.properties.label,
    bbl: f.properties.addendum.pad.bbl,
    bin: f.properties.addendum.pad.bin ?? "",
    borough: f.properties.borough ?? "",
    zip: f.properties.postalcode ?? "",
  };
}

// HPD marks resolution two different ways. Matching only "CLOSED" over-counts open
// violations — verified on BBL 1012030020, where 6 DISMISSED rows inflated the
// headline from 513 to 519. The headline number is the demo; it has to be right.
const RESOLVED = /CLOSED|DISMISSED/;

// Ordered by how much a New Yorker actually cares.
const THEMES: { kind: string; re: RegExp }[] = [
  { kind: "heat", re: /\bHEAT\b/ },
  { kind: "hot water", re: /HOT WATER/ },
  { kind: "vermin", re: /ROACH|MICE|\bRATS?\b|VERMIN|BEDBUG/ },
  { kind: "mold", re: /MOLD|MILDEW/ },
  { kind: "leak", re: /LEAK|WATER DAMAGE|SEEPAGE/ },
  { kind: "lead paint", re: /LEAD|PAINT|PLASTER/ },
  { kind: "smoke alarm", re: /SMOKE DETECT|CARBON MONOXIDE/ },
  { kind: "window guards", re: /WINDOW GUARD/ },
  { kind: "lighting", re: /ADEQUATE LIGHT|ILLUMINATION/ },
];

type Row = {
  novdescription?: string;
  currentstatus?: string;
  inspectiondate?: string;
};

async function fetchViolations(bbl: string): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${SODA}/wvxf-dwi5.json?bbl=${bbl}` +
      `&$limit=${PAGE}&$offset=${page * PAGE}` +
      `&$select=novdescription,currentstatus,inspectiondate` +
      `&$order=inspectiondate DESC`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) break;
    const batch: Row[] = await r.json();
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function fetch311(zip: string) {
  if (!zip) return [];
  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const url =
    `${SODA}/erm2-nwe9.json?$select=complaint_type,count(unique_key) AS n` +
    `&$where=incident_zip='${zip}' AND created_date>'${since}'` +
    `&$group=complaint_type&$order=n DESC&$limit=6`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return [];
  const d = await r.json();
  return d.map((x: any) => ({ complaint: x.complaint_type, count: Number(x.n) }));
}

// PLUTO — the physical building. Keyless, keyed on the same BBL.
export async function fetchFacts(bbl: string): Promise<BuildingFacts | null> {
  const url =
    `${SODA}/64uk-42ks.json?bbl=${bbl}&$limit=1` +
    `&$select=numfloors,yearbuilt,unitsres,bldgarea,bldgclass`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  const [row] = await r.json();
  if (!row) return null;

  const floors = Math.round(Number(row.numfloors) || 0);
  const units = Number(row.unitsres) || 0;
  const area = Number(row.bldgarea) || 0;
  const cls = String(row.bldgclass ?? "");
  const yearBuilt = Number(row.yearbuilt) || 0;

  return {
    yearBuilt,
    floors,
    residentialUnits: units,
    buildingArea: area,
    sqftPerUnit: units ? Math.round(area / units) : 0,
    buildingClass: cls,
    // NYC building class: C = walk-up apartments, D = elevator apartments.
    walkUp: cls.startsWith("C") || (floors > 0 && floors <= 5 && !cls.startsWith("D")),
    preWar: yearBuilt > 0 && yearBuilt < 1945,
    likelyLeadPaint: yearBuilt > 0 && yearBuilt < 1978,
  };
}

// Real footprint geometry. Many BINs have no row, so this degrades to null and
// the massing simply does not render.
export async function fetchFootprint(bin: string): Promise<Footprint | null> {
  if (!bin) return null;
  const url =
    `${SODA}/5zhs-2jue.json?bin=${bin}&$limit=1` +
    `&$select=the_geom,height_roof,ground_elevation`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  const [row] = await r.json();
  const geom = row?.the_geom;
  if (!geom?.coordinates) return null;

  // MultiPolygon nests one level deeper than Polygon. Outer ring only.
  const ring =
    geom.type === "MultiPolygon" ? geom.coordinates[0]?.[0] : geom.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 3) return null;

  return {
    ring: ring.slice(0, 64) as [number, number][],
    heightRoof: Number(row.height_roof) || 0,
    groundElevation: Number(row.ground_elevation) || 0,
  };
}

// Tenant-filed complaints (ygpa-z7cr). Note this dataset uses underscored field
// names, unlike wvxf-dwi5. Aggregated server-side rather than counting rows.
export async function fetchComplaints(bbl: string): Promise<TenantComplaints | null> {
  if (!bbl) return null;
  const base = `${SODA}/ygpa-z7cr.json?$where=bbl='${bbl}'`;

  const [byCat, totals] = await Promise.all([
    fetch(`${base}&$select=major_category,count(problem_id) AS n&$group=major_category&$order=n DESC&$limit=6`, {
      cache: "no-store",
    }).then((r) => (r.ok ? r.json() : [])),
    fetch(`${base}&$select=count(problem_id) AS n,min(received_date) AS first,max(received_date) AS last`, {
      cache: "no-store",
    }).then((r) => (r.ok ? r.json() : [])),
  ]);

  const total = Number(totals?.[0]?.n) || 0;
  if (!total) return null;

  const first = String(totals[0].first ?? "").slice(0, 4);
  const last = String(totals[0].last ?? "").slice(0, 4);

  return {
    total,
    span: first && last ? (first === last ? first : `${first}\u2013${last}`) : "",
    top: byCat
      .filter((r: any) => r.major_category)
      .map((r: any) => ({ category: String(r.major_category), count: Number(r.n) })),
  };
}

const STORY_RE = /(\d+)(?:st|nd|rd|th)\s+STORY/i;
const APT_RE = /\bAPT\s+([0-9A-Z]+)/i;

function parseFloors(rows: { novdescription?: string }[]): FloorBreakdown {
  const counts: Record<number, number> = {};
  const apts: Record<string, number> = {};
  let parsed = 0;

  for (const r of rows) {
    const d = r.novdescription ?? "";
    const m = STORY_RE.exec(d);
    if (m) {
      const n = Number(m[1]);
      // Guard against absurd parses from odd text.
      if (n >= 1 && n <= 120) {
        counts[n] = (counts[n] ?? 0) + 1;
        parsed++;
      }
    }
    const a = APT_RE.exec(d);
    if (a) {
      const apt = a[1].toUpperCase();
      apts[apt] = (apts[apt] ?? 0) + 1;
    }
  }

  const floorEntries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const aptEntries = Object.entries(apts).sort((a, b) => b[1] - a[1]);

  return {
    counts,
    parsed,
    worstFloor: floorEntries.length ? Number(floorEntries[0][0]) : null,
    worstUnit: aptEntries.length
      ? { apt: aptEntries[0][0], count: aptEntries[0][1] }
      : null,
  };
}

export async function buildProfile(address: Address): Promise<BuildingProfile> {
  const [{ rows, truncated }, neighborhood, facts, footprint, complaints] =
    await Promise.all([
      fetchViolations(address.bbl),
      fetch311(address.zip),
      fetchFacts(address.bbl),
      fetchFootprint(address.bin),
      fetchComplaints(address.bbl),
    ]);

  const open = rows.filter((v) => !RESOLVED.test(v.currentstatus ?? ""));

  const signals: Signal[] = [];
  for (const { kind, re } of THEMES) {
    const hits = open.filter((v) => re.test((v.novdescription ?? "").toUpperCase()));
    if (!hits.length) continue;
    const years = hits
      .map((h) => h.inspectiondate?.slice(0, 4))
      .filter(Boolean)
      .sort() as string[];
    signals.push({
      kind,
      count: hits.length,
      window: years.length ? `since ${years[0]}` : "",
      sample: cleanDescription(hits[0].novdescription ?? ""),
    });
  }
  signals.sort((a, b) => b.count - a.count);

  return {
    address,
    totalViolations: rows.length,
    openViolations: open.length,
    truncated,
    signals,
    neighborhood,
    facts,
    footprint,
    floors: parseFloors(open),
    complaints,
  };
}

// HPD text is prefixed with statute boilerplate. Strip it so the demo reads clean.
function cleanDescription(s: string) {
  return s
    .replace(/^[§\s\w.\-]*ADM CODE\s*/i, "")
    .replace(/^\([A-Z]\)\s*§?\s*HMC:?\s*/i, "")
    .replace(/^§?\s*[\d.\-]+\s*HMC:?\s*/i, "")
    // HPD encodes apostrophes as 0x1A. Left raw it renders as a stray glyph.
    .replace(//g, "'")
    .replace(/[ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
