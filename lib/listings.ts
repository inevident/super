// Housing inventory, read from the snapshot built by scripts/listings.mjs.
// Loaded once at module scope — it is a static file and never changes at runtime.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

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
  listedDate?: string;
  url?: string;
  imageUrl?: string;
  imageUrls?: string[];
  description?: string;
  applicationUrl?: string;
  rentRange?: string;
};

export type Query = {
  borough?: string;
  boroughs?: string[];
  annualIncome?: number;
  sortBy?: string;
  actionableOnly?: boolean;
  maxRent?: number;
  minBeds?: number;
  minUnits?: number;
  withRentOnly?: boolean;
  limit?: number;
};

let cache: Listing[] | null = null;

function readSnapshot(name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "public", name), "utf8"));
  } catch {
    return null;
  }
}

function stableSnapshotId(prefix: string, values: unknown[]) {
  const slug = values
    .slice(0, 2)
    .map((value) => String(value ?? ""))
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 130) || "listing";
  const hash = createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 10);
  return `${prefix}-${slug}-${hash}`;
}

export function normalizeListingRecord(value: unknown, sourceOverride?: string, idOverride?: string): Listing | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const source = String(sourceOverride ?? raw.source ?? "").trim().toLowerCase();
  const id = String(idOverride ?? raw.id ?? "").trim();
  const name = String(raw.name ?? "").trim();
  const address = String(raw.address ?? "").trim();
  const borough = String(raw.borough ?? "").trim();
  if (!source || !/^[a-z0-9-]{1,180}$/.test(id) || !name || !address || !borough) return null;
  const number = (key: string) => {
    if (raw[key] == null || raw[key] === "") return undefined;
    const parsed = Number(raw[key]);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const string = (key: string) => raw[key] == null ? undefined : String(raw[key]).trim() || undefined;
  return {
    ...(raw as Listing),
    id,
    source,
    name,
    address,
    borough,
    affordable: raw.affordable == null ? true : Boolean(raw.affordable),
    zip: string("zip"),
    lat: number("lat"),
    lon: number("lon"),
    units: number("units"),
    beds: number("beds"),
    rent: number("rent"),
    ami: number("ami"),
    minIncome: number("minIncome"),
    maxIncome: number("maxIncome"),
    unitSize: string("unitSize"),
    started: string("started"),
    listedDate: string("listedDate"),
    url: string("url"),
    imageUrl: string("imageUrl"),
    imageUrls: Array.isArray(raw.imageUrls)
      ? raw.imageUrls.map(String).map((item) => item.trim()).filter(Boolean)
      : undefined,
    description: string("description"),
    applicationUrl: string("applicationUrl"),
    rentRange: string("rentRange"),
  };
}

function normalizeLegacyListing(listing: Listing) {
  if (listing.source !== "fifthave") return listing;
  let normalized = listing;
  if (listing.rent === 2732.32) normalized = {
    ...listing,
    name: "The Axel - Unit 6F",
    address: "539 Vanderbilt Avenue, Brooklyn, NY",
    description: "Studio re-rental for a 1-2 person household, marketed by Fifth Avenue Committee.",
    imageUrl: "https://fifthave.org/wp-content/uploads/2022/05/539-Vanderbilt-Avenue-in-Clinton-Hill-Brooklyn-777x1109-1.jpeg",
    applicationUrl: "https://fifthave.my.site.com/",
  };
  if (listing.rent === 980) normalized = {
    ...listing,
    name: "Paseo on Fifth - Unit N-308",
    address: "Brooklyn, NY",
    description: "Two-bedroom re-rental for a 1-5 person household, marketed by Fifth Avenue Committee.",
    imageUrl: "https://fifthave.org/wp-content/uploads/2025/06/30893376.jpg",
    applicationUrl: "https://fifthave.my.site.com/",
  };
  if (normalized === listing) normalized = {
    ...listing,
    name: "551 Warren Street re-rental",
    address: "551 Warren Street, Brooklyn, NY",
  };
  return {
    ...normalized,
    id: stableSnapshotId("fifthave", [
      normalized.name,
      normalized.address,
      normalized.unitSize,
      normalized.rent,
      normalized.minIncome,
      normalized.maxIncome,
    ]),
  };
}

export function allListings(): Listing[] {
  if (cache) return cache;
  const legacySnapshot = readSnapshot("listings.json");
  const legacyRows = legacySnapshot && typeof legacySnapshot === "object" &&
      Array.isArray((legacySnapshot as any).listings)
    ? (legacySnapshot as any).listings
    : [];
  const legacy = legacyRows
    .map((row: unknown) => normalizeListingRecord(row))
    .filter((listing: Listing | null): listing is Listing => Boolean(listing))
    .map(normalizeLegacyListing);

  const providerSnapshot = readSnapshot("provider-listings.json");
  const provider = (Array.isArray(providerSnapshot) ? providerSnapshot : [])
    .map((row) => normalizeListingRecord(row))
    .filter((listing): listing is Listing => Boolean(listing));

  const hdcSnapshot = readSnapshot("hdc-listings.json");
  const hdc = (Array.isArray(hdcSnapshot) ? hdcSnapshot : []).flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return [];
    const raw = row as Record<string, unknown>;
    const id = stableSnapshotId("nychdc", [raw.name, raw.address, raw.applicationUrl]);
    const rents = (String(raw.rentRange ?? "").match(/[\d,]+(?:\.\d+)?/g) ?? [])
      .map((value) => Number(value.replace(/,/g, "")))
      .filter(Number.isFinite);
    const listing = normalizeListingRecord({
      ...raw,
      id,
      source: "nychdc",
      affordable: true,
      rent: rents[0],
      url: raw.applicationUrl,
    });
    return listing ? [listing] : [];
  });

  try {
    const publicationDate = (listing: Listing) => {
      const source = `${listing.applicationUrl ?? ""} ${listing.imageUrl ?? ""} ${listing.url ?? ""}`;
      const match = source.match(/\/(20\d{2})[-/](0?[1-9]|1[0-2])(?:[-/](0?[1-9]|[12]\d|3[01]))?/);
      if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${(match[3] ?? "01").padStart(2, "0")}`;
      return listing.started?.slice(0, 10);
    };
    const seen = new Set<string>();
    cache = [...provider, ...hdc, ...legacy]
      .map((listing) => ({ ...listing, listedDate: listing.listedDate ?? publicationDate(listing) }))
      .filter((listing) => {
        if (seen.has(listing.id)) return false;
        seen.add(listing.id);
        return true;
      });
  } catch {
    cache = [...provider, ...hdc, ...legacy];
  }
  return cache;
}

export function getListing(id: string): Listing | null {
  return allListings().find((listing) => listing.id === id) ?? null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

export function searchListings(q: Query): Listing[] {
  const limit = Math.min(q.limit ?? 12, 100);
  let out = allListings();

  if (q.actionableOnly) out = out.filter((listing) => listing.source !== "hpd" || Boolean(listing.rent || listing.applicationUrl || listing.url));

  const wantedBoroughs = q.boroughs?.length ? q.boroughs : q.borough ? [q.borough] : [];
  if (wantedBoroughs.length) {
    const wanted = wantedBoroughs.map(norm);
    out = out.filter((l) => wanted.some((want) => norm(l.borough).includes(want) || want.includes(norm(l.borough || "x"))));
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
    if ((q.sortBy ?? "newest listed").includes("newest")) {
      const dateDifference = Date.parse(b.listedDate ?? "1970-01-01") - Date.parse(a.listedDate ?? "1970-01-01");
      if (dateDifference) return dateDifference;
    }
    if (q.annualIncome) {
      const incomeScore = (listing: Listing) => {
        if (listing.minIncome || listing.maxIncome) {
          if (q.annualIncome! < (listing.minIncome ?? 0)) return (listing.minIncome! - q.annualIncome!) / q.annualIncome!;
          if (q.annualIncome! > (listing.maxIncome ?? Infinity)) return (q.annualIncome! - listing.maxIncome!) / q.annualIncome!;
          return 0;
        }
        if (listing.rent) return Math.abs(Math.log(q.annualIncome! / (listing.rent * 40)));
        return 2;
      };
      const incomeDifference = incomeScore(a) - incomeScore(b);
      if (incomeDifference) return incomeDifference;
    }
    const ar = a.rent ? 0 : 1;
    const br = b.rent ? 0 : 1;
    if (ar !== br) return ar - br;
    if (q.sortBy?.includes("cheapest")) return (a.rent ?? Infinity) - (b.rent ?? Infinity);
    const ag = (a.imageUrls?.length ?? 0) > 1 ? 0 : 1;
    const bg = (b.imageUrls?.length ?? 0) > 1 ? 0 : 1;
    if (ag !== bg) return ag - bg;
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
