import type {
  LandlordRedFlag,
  MarketplaceListing,
  PrecheckCategory,
  PrecheckRequirement,
  ViolationRecord,
} from "./types";
import { pickBest, searchCatalog } from "./ucp";

const SAFE: Array<{
  category: PrecheckCategory;
  label: string;
  query: string;
  pattern: RegExp;
  supplemental?: boolean;
}> = [
  {
    category: "heat",
    label: "Portable space heater",
    query: "portable electric space heater apartment",
    pattern: /\bHEAT(?:ING)?\b|RADIATOR/i,
  },
  {
    category: "mold",
    label: "Dehumidifier",
    query: "small room dehumidifier apartment",
    pattern: /MOLD|MILDEW|DAMP|EXCESS MOISTURE/i,
  },
  {
    category: "vermin",
    label: "Enclosed traps",
    query: "enclosed reusable mouse trap station indoor",
    pattern: /ROACH|MICE|\bRATS?\b|VERMIN|BEDBUG|PEST/i,
  },
  {
    category: "leaks",
    label: "Leak detector",
    query: "water leak detector alarm apartment",
    pattern: /LEAK|WATER DAMAGE|SEEPAGE/i,
  },
  {
    category: "lead-dust",
    label: "True HEPA purifier",
    query: "compact true hepa air purifier small room",
    pattern: /\bLEAD\b/i,
    supplemental: true,
  },
];

const PRODUCT_TITLE_MATCH: Record<PrecheckCategory, RegExp> = {
  heat: /\b(?:space|ceramic) heater\b/i,
  mold: /\bdehumidifier\b/i,
  vermin: /\b(?:enclosed|covered|multi[\s-]?catch|catch[\s-]?and[\s-]?release|trap station|electric (?:mouse|rat) trap)\b/i,
  leaks: /\b(?:leak detector|water sensor|leak alarm)\b/i,
  "lead-dust": /\btrue\s+hepa\b/i,
  privacy: /\b(?:(?:blackout|privacy).*(?:curtain|shade|blind|window film)|(?:curtain|shade|blind|window film).*?(?:blackout|privacy))\b/i,
  drafts: /\b(?:window insulation|draft stopper|draft blocker|weatherstrip|weather strip)\b/i,
  noise: /\b(?:white noise|sound machine)\b/i,
  storage: /\b(?:under[\s-]?bed storage|storage (?:bin|bag|container))\b/i,
};

// Shopify's catalog search is already scoped to the requirement query, but
// merchant titles are inconsistent (for example, many real HEPA purifiers do
// not include the word "true"). Prefer the exact rules above, then allow a
// category-relevant, renter-safe result at the hackathon's 70% match floor.
const APPROXIMATE_PRODUCT_TITLE_MATCH: Record<PrecheckCategory, RegExp> = {
  heat: /\b(?:heater|radiator)\b/i,
  mold: /\b(?:dehumidifier|moisture absorber)\b/i,
  vermin: /\b(?:trap|traps|interceptor|catcher|pest station)\b/i,
  leaks: /\b(?:(?:water|leak|moisture).*(?:detector|sensor|alarm)|(?:detector|sensor|alarm).*(?:water|leak|moisture))\b/i,
  "lead-dust": /\b(?:air purifier|air cleaner|hepa purifier)\b/i,
  privacy: /\b(?:curtain|shade|blind|window film)\b/i,
  drafts: /\b(?:insulation|draft|weatherstrip|weather strip)\b/i,
  noise: /\b(?:white noise|sound machine|sleep sound)\b/i,
  storage: /\b(?:storage|organizer)\b/i,
};

export const APPROXIMATE_PRECHECK_MATCH = 0.7;

const PRODUCT_TITLE_REJECT: Partial<Record<PrecheckCategory, RegExp>> = {
  vermin: /\b(?:glue|sticky|adhesive|poison|pesticide|insecticide|rodenticide)\b/i,
  heat: /\b(?:propane|natural gas|kerosene|butane|fuel(?:ed)?)\b/i,
  "lead-dust": /\b(?:replacement|filter only|filter pack|filter cartridge)\b/i,
  privacy: /\b(?:corded|bracket|screws?|required hardware|mounting hardware|permanent|drill[\s-]?mount)\b/i,
};

const TEMPORARY_PRIVACY = /\b(?:no[\s-]?drill|temporary|static[\s-]?cling|peel[\s-]?(?:and|&)[\s-]?stick|self[\s-]?adhesive)\b/i;

export function productMatchesPrecheck(
  category: PrecheckCategory,
  title: string,
  query = ""
) {
  const rejected = PRODUCT_TITLE_REJECT[category];
  if (rejected?.test(title) || !PRODUCT_TITLE_MATCH[category].test(title)) return false;
  if (category === "privacy" && !TEMPORARY_PRIVACY.test(title)) return false;
  if (category === "vermin") {
    const target = query.toLowerCase();
    if (/\b(?:mouse|mice|rat|rodent)\b/.test(target) && !/\b(?:mouse|mice|rat|rodent)\b/i.test(title)) return false;
    if (/\b(?:roach|cockroach)\b/.test(target) && !/\b(?:roach|cockroach)\b/i.test(title)) return false;
    if (/\bbed[\s-]?bug\b/.test(target) && !/\bbed[\s-]?bug\b/i.test(title)) return false;
  }
  return true;
}

function verminProductConflictsWithQuery(title: string, query: string) {
  const target = query.toLowerCase();
  const asksForRodent = /\b(?:mouse|mice|rat|rodent)\b/.test(target);
  const asksForRoach = /\b(?:roach|cockroach)\b/.test(target);
  const asksForBedbug = /\bbed[\s-]?bug\b/.test(target);
  const mentionsRodent = /\b(?:mouse|mice|rat|rodent)\b/i.test(title);
  const mentionsRoach = /\b(?:roach|cockroach)\b/i.test(title);
  const mentionsBedbug = /\bbed[\s-]?bug\b/i.test(title);
  const mentionsSpecificPest = mentionsRodent || mentionsRoach || mentionsBedbug;
  if (!mentionsSpecificPest) return false;
  if (asksForRodent) return !mentionsRodent;
  if (asksForRoach) return !mentionsRoach;
  if (asksForBedbug) return !mentionsBedbug;
  return false;
}

export function precheckProductMatchScore(
  category: PrecheckCategory,
  title: string,
  query = ""
) {
  if (productMatchesPrecheck(category, title, query)) return 1;
  if (PRODUCT_TITLE_REJECT[category]?.test(title)) return 0;
  if (category === "vermin" && verminProductConflictsWithQuery(title, query)) return 0;
  return APPROXIMATE_PRODUCT_TITLE_MATCH[category].test(title)
    ? APPROXIMATE_PRECHECK_MATCH
    : 0;
}

export function pickPrecheckProduct(
  category: PrecheckCategory,
  products: Parameters<typeof pickBest>[0],
  query = ""
) {
  const scored = products
    .map((product) => ({ product, score: precheckProductMatchScore(category, product.title, query) }))
    .filter((candidate) => candidate.score >= APPROXIMATE_PRECHECK_MATCH);
  const scores = [...new Set(scored.map((candidate) => candidate.score))].sort((a, b) => b - a);
  for (const score of scores) {
    const product = pickBest(
      scored.filter((candidate) => candidate.score === score).map((candidate) => candidate.product)
    );
    if (product) return product;
  }
  return null;
}

const LANDLORD: Array<{ kind: string; pattern: RegExp; summary: string }> = [
  {
    kind: "Hot water",
    pattern: /HOT WATER/i,
    summary: "The owner must restore reliable hot water; this is not a renter-installable fix.",
  },
  {
    kind: "Gas",
    pattern: /\bGAS\b|GAS LINE|GAS SUPPLY/i,
    summary: "Gas work requires the owner and licensed professionals.",
  },
  {
    kind: "Electrical",
    pattern: /ELECTRIC|WIRING|OUTLET|CIRCUIT|BREAKER/i,
    summary: "Building electrical work belongs to the owner and a licensed electrician.",
  },
  {
    kind: "Structural",
    pattern: /STRUCTUR|FOUNDATION|LOAD.BEAR|COLLAPSE|FACADE/i,
    summary: "Structural conditions require owner-led repair and inspection.",
  },
  {
    kind: "Fire egress",
    pattern: /FIRE ESCAPE|EGRESS|MEANS OF EGRESS|SELF.CLOSING DOOR/i,
    summary: "Fire-egress defects require immediate owner action.",
  },
  {
    kind: "Window guards",
    pattern: /WINDOW GUARD/i,
    summary: "The owner must provide compliant window guards where required.",
  },
  {
    kind: "Alarm systems",
    pattern: /SMOKE DETECT|CARBON MONOXIDE|FIRE ALARM|SPRINKLER/i,
    summary: "Required alarms and fire systems are the owner's responsibility.",
  },
];

function descriptions(records: ViolationRecord[]) {
  return records.map((record) => record.description.toUpperCase());
}

export function buildPrecheckRequirements(records: ViolationRecord[]): PrecheckRequirement[] {
  const text = descriptions(records);
  return SAFE.flatMap((mapping) => {
    const hits = text.filter((description) => {
      if (/HOT WATER/i.test(description) && mapping.category === "heat") return false;
      if (LANDLORD.some((item) => item.pattern.test(description)) && mapping.category !== "heat") {
        // A life-safety/building-system violation is never converted into a kit
        // item just because it also contains a generic word such as "water".
        return false;
      }
      return mapping.pattern.test(description);
    });
    const count = hits.length;
    if (!count) return [];
    let query = mapping.query;
    if (mapping.category === "vermin") {
      if (hits.some((description) => /\b(?:MICE|MOUSE|RATS?|RODENT)\b/.test(description))) {
        query = "enclosed reusable mouse trap station indoor";
      } else if (hits.some((description) => /\b(?:ROACH|COCKROACH)\b/.test(description))) {
        query = "enclosed roach trap station indoor apartment";
      } else if (hits.some((description) => /\bBEDBUG|BED BUG\b/.test(description))) {
        query = "enclosed bed bug interceptor trap apartment";
      }
    }
    const suffix = mapping.supplemental
      ? " Supplemental only; this does not remediate lead paint."
      : "";
    return [
      {
        category: mapping.category,
        label: mapping.label,
        query,
        violationCount: count,
        reason: `${count} open ${mapping.category.replace("-", " ")} violation${count === 1 ? "" : "s"}.${suffix}`,
        basis: "violation" as const,
        supplemental: mapping.supplemental,
      },
    ];
  });
}

export function buildLandlordRedFlags(records: ViolationRecord[]): LandlordRedFlag[] {
  const text = descriptions(records);
  return LANDLORD.flatMap((mapping) => {
    const count = text.filter((description) => mapping.pattern.test(description)).length;
    return count ? [{ kind: mapping.kind, count, summary: mapping.summary }] : [];
  });
}

export function selectPrecheckCatalogRequirements(listings: MarketplaceListing[]) {
  return selectPrecheckCatalogTasks(listings).map((task) => task.requirement);
}

export type PrecheckCatalogTask = {
  key: string;
  zip: string;
  requirement: PrecheckRequirement;
};

function listingZip(listing: MarketplaceListing) {
  return listing.buildings.map((building) => building.zip).find(Boolean) ?? "10001";
}

function catalogTaskKey(requirement: PrecheckRequirement, zip: string) {
  return `${requirement.category}|${zip}|${requirement.query.trim().toLowerCase()}`;
}

export function selectPrecheckCatalogTasks(listings: MarketplaceListing[]) {
  const uniqueRequirements = new Map<string, PrecheckCatalogTask>();
  for (const listing of listings) {
    const zip = listingZip(listing);
    for (const requirement of listing.precheck.categories) {
      const key = catalogTaskKey(requirement, zip);
      if (!uniqueRequirements.has(key)) {
        uniqueRequirements.set(key, { key, zip, requirement });
      }
    }
  }

  // Keep a hard five-search ceiling across every shortlisted listing. Violation
  // mitigations win the shared slots before optional building/photo/location fit.
  const basisPriority = { violation: 0, building: 1, photo: 2, location: 3 } as const;
  return [...uniqueRequirements.values()]
    .sort((a, b) => basisPriority[a.requirement.basis] - basisPriority[b.requirement.basis])
    .slice(0, 5);
}

export async function pricePrecheckKits(
  listings: MarketplaceListing[],
  catalogSearch: typeof searchCatalog = searchCatalog,
  signal?: AbortSignal
) {
  const tasks = selectPrecheckCatalogTasks(listings);
  const priced = await Promise.all(
    tasks.map(async ({ key, requirement, zip }) => {
      try {
        const products = signal
          ? await catalogSearch(requirement.query, zip, signal)
          : await catalogSearch(requirement.query, zip);
        return {
          key,
          product: pickPrecheckProduct(requirement.category, products, requirement.query),
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { key, product: null };
      }
    })
  );
  const products = new Map(priced.map((result) => [result.key, result.product]));

  return listings.map((listing) => {
    const categories = listing.precheck.categories;
    const hasKnownViolationBasis = categories.some((category) => category.basis === "violation");
    const recordUnavailable = listing.risk.level === "Unavailable" && !hasKnownViolationBasis;
    if (!categories.length) {
      return {
        ...listing,
        precheck: recordUnavailable
          ? { categories: [], items: [], total: null, pricingStatus: "unavailable" as const, oneTime: true as const }
          : { categories: [], items: [], total: 0, pricingStatus: "priced" as const, oneTime: true as const },
      };
    }
    const zip = listingZip(listing);
    const items = categories.map((requirement) => ({
      ...requirement,
      product: products.get(catalogTaskKey(requirement, zip)) ?? null,
    }));
    const requiredItems = items.filter((item) => !item.optional);
    const complete = requiredItems.every((item) => item.product);
    return {
      ...listing,
      precheck: {
        categories,
        items,
        total: complete && !recordUnavailable
          ? Math.round(requiredItems.reduce((sum, item) => sum + (item.product?.price ?? 0), 0) * 100) / 100
          : null,
        pricingStatus: complete && !recordUnavailable ? ("priced" as const) : ("unavailable" as const),
        oneTime: true as const,
      },
    };
  });
}
