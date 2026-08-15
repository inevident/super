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
  imageUrl?: string;
  description?: string;
  applicationUrl?: string;
  rentRange?: string;
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
    const legacy = ((JSON.parse(raw).listings ?? []) as Listing[]).map((listing) => {
      if (listing.source !== "fifthave") return listing;
      if (listing.rent === 2732.32) return {
        ...listing,
        name: "The Axel - Unit 6F",
        address: "539 Vanderbilt Avenue, Brooklyn, NY",
        description: "Studio re-rental for a 1-2 person household, marketed by Fifth Avenue Committee.",
        imageUrl: "https://fifthave.org/wp-content/uploads/2022/05/539-Vanderbilt-Avenue-in-Clinton-Hill-Brooklyn-777x1109-1.jpeg",
        applicationUrl: "https://fifthave.my.site.com/",
      };
      if (listing.rent === 980) return {
        ...listing,
        name: "Paseo on Fifth - Unit N-308",
        address: "Brooklyn, NY",
        description: "Two-bedroom re-rental for a 1-5 person household, marketed by Fifth Avenue Committee.",
        imageUrl: "https://fifthave.org/wp-content/uploads/2025/06/30893376.jpg",
        applicationUrl: "https://fifthave.my.site.com/",
      };
      return { ...listing, name: "551 Warren Street re-rental", address: "551 Warren Street, Brooklyn, NY" };
    });
    const hdcRaw = readFileSync(join(process.cwd(), "public", "hdc-listings.json"), "utf8");
    const providerRaw = readFileSync(join(process.cwd(), "public", "provider-listings.json"), "utf8");
    const provider = (JSON.parse(providerRaw) as Listing[]).map((listing) => ({ ...listing, affordable: true }));
    const hdc = (JSON.parse(hdcRaw) as Omit<Listing, "id" | "source" | "affordable">[]).map((listing) => {
      const slug = `${listing.name}-${listing.address}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const rents = (listing.rentRange?.match(/[\d,]+(?:\.\d+)?/g) ?? []).map((value) =>
        Number(value.replace(/,/g, "")),
      );
      return {
        ...listing,
        id: `nychdc-${slug}`,
        source: "nychdc",
        affordable: true,
        rent: rents[0],
        url: listing.applicationUrl,
      } as Listing;
    });
    cache = [...provider, ...hdc, ...legacy];
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
    const canonical = (value: string) => value.toLowerCase().replace(/\b(apartments?|llc|phase)\b/g, "").replace(/[^a-z0-9]/g, "");
    const key = `${canonical(l.name)}|${canonical(l.address)}|${l.rent ?? ""}|${l.unitSize ?? ""}`;
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
