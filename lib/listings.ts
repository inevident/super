// Housing inventory, read from the snapshot built by scripts/listings.mjs.
// Loaded once at module scope — it is a static file and never changes at runtime.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Listing = {
  id: string;
  source: "hpd" | "fifthave" | "nychdc" | string;
  name: string;
  address: string;
  borough: string;
  zip?: string;
  lat?: number;
  lon?: number;
  affordable: boolean;
  units?: number;
  beds?: number;
  unitSize?: string;
  rent?: number;
  ami?: number;
  minIncome?: number;
  maxIncome?: number;
  incomeBands?: { extremelyLow: number; veryLow: number; low: number; moderate: number };
  started?: string;
  url?: string;
};

export type Query = {
  borough?: string;
  maxRent?: number;
  minBeds?: number;
  minUnits?: number;
  withRentOnly?: boolean;
  limit?: number;
};

let cache: Listing[] | null = null;

export function allListings(): Listing[] {
  if (cache) return cache;
  try {
    const raw = readFileSync(join(process.cwd(), "public", "listings.json"), "utf8");
    cache = (JSON.parse(raw).listings ?? []) as Listing[];
  } catch {
    cache = [];
  }
  return cache;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

export function searchListings(q: Query): Listing[] {
  const limit = Math.min(q.limit ?? 12, 40);
  let out = allListings();

  if (q.borough) {
    const want = norm(q.borough);
    out = out.filter((l) => norm(l.borough).includes(want) || want.includes(norm(l.borough || "x")));
  }
  if (q.withRentOnly) out = out.filter((l) => typeof l.rent === "number");
  if (typeof q.maxRent === "number") {
    // Listings without a published rent are not silently treated as cheap.
    out = out.filter((l) => typeof l.rent === "number" && l.rent <= q.maxRent!);
  }
  if (typeof q.minBeds === "number") out = out.filter((l) => (l.beds ?? -1) >= q.minBeds!);
  if (typeof q.minUnits === "number") out = out.filter((l) => (l.units ?? 0) >= q.minUnits!);

  // Listings with a real rent first — they are the ones a renter can act on.
  out = [...out].sort((a, b) => {
    const ar = a.rent ? 0 : 1;
    const br = b.rent ? 0 : 1;
    if (ar !== br) return ar - br;
    return (b.units ?? 0) - (a.units ?? 0);
  });

  // Re-rental pages repeat the same unit many times. Collapse exact duplicates
  // so the results are not five identical studios.
  const seen = new Set<string>();
  const deduped = out.filter((l) => {
    const key = `${l.source}|${l.name}|${l.rent ?? ""}|${l.unitSize ?? ""}|${l.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.slice(0, limit);
}

export function summarise(l: Listing) {
  return {
    id: l.id,
    name: l.name || l.address,
    address: l.address,
    borough: l.borough,
    rent: l.rent,
    unitSize: l.unitSize,
    units: l.units,
    ami: l.ami,
    affordable: l.affordable,
    source: l.source,
  };
}
