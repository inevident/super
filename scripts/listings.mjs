// Builds the housing marketplace inventory snapshot.
//
// Tiered on purpose. Tier 1 is structured city data and always works, so the
// marketplace can never render empty. Tier 2 scrapes public re-rental pages for
// the thing tier 1 lacks — actual rents — and is allowed to fail silently.
//
// Snapshot, never live: third-party markup changes without warning and scraping
// from a stage over venue wifi is a guaranteed failure.
//
//   node scripts/listings.mjs

import { writeFileSync } from "node:fs";

const SODA = "https://data.cityofnewyork.us/resource/hg8x-zxpr.json";
const UA = "Mozilla/5.0 (compatible; super-hackathon/1.0)";
const TIER1_CAP = 2500;

const listings = [];
const report = [];

// --- Tier 1: HPD affordable housing by building ----------------------------
{
  const url =
    `${SODA}?$select=project_id,project_name,house_number,street_name,borough,` +
    `postcode,latitude,longitude,all_counted_units,extremely_low_income_units,` +
    `very_low_income_units,low_income_units,moderate_income_units,project_start_date` +
    `&$where=latitude IS NOT NULL AND all_counted_units>0` +
    `&$order=project_id&$limit=${TIER1_CAP}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`tier1 soda ${res.status}`);
  const rows = await res.json();

  for (const r of rows) {
    const addr = `${r.house_number ?? ""} ${r.street_name ?? ""}`.trim();
    if (!addr) continue;
    listings.push({
      id: `hpd-${r.project_id}-${listings.length}`,
      source: "hpd",
      name: (r.project_name ?? "").replace(/\s+/g, " ").trim(),
      address: addr,
      borough: r.borough ?? "",
      zip: r.postcode ?? "",
      lat: Number(r.latitude),
      lon: Number(r.longitude),
      affordable: true,
      units: Number(r.all_counted_units) || 0,
      incomeBands: {
        extremelyLow: Number(r.extremely_low_income_units) || 0,
        veryLow: Number(r.very_low_income_units) || 0,
        low: Number(r.low_income_units) || 0,
        moderate: Number(r.moderate_income_units) || 0,
      },
      started: (r.project_start_date ?? "").slice(0, 10),
    });
  }
  report.push(`tier1 hpd            ${rows.length} rows -> ${listings.length} listings`);
}

// --- Tier 2: public re-rental pages ----------------------------------------
// Only fifthave is known to carry listings in static HTML; the others render
// client-side. Each is attempted independently and never throws.
async function scrape(name, url, parse) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) {
      report.push(`tier2 ${name.padEnd(16)} http ${res.status} — skipped`);
      return;
    }
    const html = await res.text();
    const found = parse(html);
    found.forEach((f, i) => listings.push({ ...f, id: `${name}-${i}`, source: name }));
    report.push(`tier2 ${name.padEnd(16)} ${found.length} listings`);
  } catch (e) {
    report.push(`tier2 ${name.padEnd(16)} failed (${String(e).slice(0, 40)}) — skipped`);
  }
}

const strip = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const money = (s) => Number(String(s).replace(/[^0-9.]/g, "")) || undefined;

await scrape("fifthave", "https://fifthave.org/re-rental-availabilities/", (html) => {
  const text = strip(html);
  // One rigid regex across the whole block only matched 2 of 9 listings — the
  // markup varies between entries. Splitting on the record delimiter and pulling
  // each field independently is far more tolerant. Note inline tags split digits,
  // so "130%" arrives as "13 0%" and numbers must be de-spaced.
  const num = (re, chunk) => {
    const m = re.exec(chunk);
    return m ? Number(m[1].replace(/[\s,]/g, "")) : undefined;
  };

  return text
    .split(/Unit Size:/i)
    .slice(1)
    .flatMap((chunk) => {
      const c = chunk.slice(0, 320);
      const rent = num(/Rent:\s*\$([0-9,\s]+(?:\.[0-9]{2})?)/i, c);
      if (!rent) return [];
      const size = (c.match(/^\s*([A-Za-z0-9 ]{2,24}?)\s*(?:Household|AMI|Rent)/i) || [])[1]?.trim();
      return [
        {
          name: "Fifth Avenue Committee re-rental",
          address: "Park Slope / Gowanus, Brooklyn",
          borough: "Brooklyn",
          affordable: true,
          beds: /studio/i.test(size ?? "") ? 0 : Number((size?.match(/(\d+)/) || [])[1]) || undefined,
          unitSize: size,
          ami: num(/AMI:\s*([0-9][0-9\s]*)%/i, c),
          rent,
          minIncome: num(/Min Income:\s*\$([0-9,\s]+(?:\.[0-9]{2})?)/i, c),
          maxIncome: num(/Max Income:\s*\$([0-9,\s]+(?:\.[0-9]{2})?)/i, c),
          url: "https://fifthave.org/re-rental-availabilities/",
        },
      ];
    });
});

await scrape("nychdc", "https://www.nychdc.com/find-re-rentals", (html) => {
  const text = strip(html);
  const out = [];
  const re = /\$([0-9],?[0-9]{3}(?:\.[0-9]{2})?)/g;
  let m;
  while ((m = re.exec(text)) && out.length < 40) {
    out.push({
      name: "HDC re-rental",
      address: "See listing",
      borough: "",
      affordable: true,
      rent: money(m[1]),
      url: "https://www.nychdc.com/find-re-rentals",
    });
  }
  return out;
});

// --- write -----------------------------------------------------------------
const withRent = listings.filter((l) => l.rent).length;
const out = {
  generated: new Date().toISOString().slice(0, 10),
  count: listings.length,
  withRent,
  listings,
};
writeFileSync("public/listings.json", JSON.stringify(out));

console.log("\n" + report.map((r) => "  " + r).join("\n"));
console.log(`\n  total     : ${listings.length.toLocaleString()} listings`);
console.log(`  with rent : ${withRent}`);
console.log(`  written   : public/listings.json (${Math.round(Buffer.byteLength(JSON.stringify(out)) / 1024)} KB)`);
