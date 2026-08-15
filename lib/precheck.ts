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
    query: "enclosed indoor pest traps mice roach",
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
    const count = text.filter((description) => {
      if (/HOT WATER/i.test(description) && mapping.category === "heat") return false;
      if (LANDLORD.some((item) => item.pattern.test(description)) && mapping.category !== "heat") {
        // A life-safety/building-system violation is never converted into a kit
        // item just because it also contains a generic word such as "water".
        return false;
      }
      return mapping.pattern.test(description);
    }).length;
    if (!count) return [];
    const suffix = mapping.supplemental
      ? " Supplemental only; this does not remediate lead paint."
      : "";
    return [
      {
        category: mapping.category,
        label: mapping.label,
        query: mapping.query,
        violationCount: count,
        reason: `${count} open ${mapping.category.replace("-", " ")} violation${count === 1 ? "" : "s"}.${suffix}`,
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

export async function pricePrecheckKits(listings: MarketplaceListing[]) {
  const uniqueRequirements = new Map<PrecheckCategory, PrecheckRequirement>();
  for (const listing of listings) {
    for (const requirement of listing.precheck.categories) {
      if (!uniqueRequirements.has(requirement.category)) {
        uniqueRequirements.set(requirement.category, requirement);
      }
    }
  }

  // There are exactly five allowed categories, so this is a hard global ceiling
  // even when six listings need the same products.
  const requirements = [...uniqueRequirements.values()].slice(0, 5);
  const zip = listings.flatMap((listing) => listing.buildings.map((building) => building.zip)).find(Boolean) ?? "10001";
  const priced = await Promise.all(
    requirements.map(async (requirement) => {
      try {
        const products = await searchCatalog(requirement.query, zip);
        return { category: requirement.category, product: pickBest(products) };
      } catch {
        return { category: requirement.category, product: null };
      }
    })
  );
  const products = new Map(priced.map((result) => [result.category, result.product]));

  return listings.map((listing) => {
    const categories = listing.precheck.categories;
    if (!categories.length) {
      return {
        ...listing,
        precheck: { categories: [], items: [], total: 0, pricingStatus: "priced" as const, oneTime: true as const },
      };
    }
    const items = categories.map((requirement) => ({
      ...requirement,
      product: products.get(requirement.category) ?? null,
    }));
    const complete = items.every((item) => item.product);
    return {
      ...listing,
      precheck: {
        categories,
        items,
        total: complete
          ? items.reduce((sum, item) => sum + (item.product?.price ?? 0), 0)
          : null,
        pricingStatus: complete ? ("priced" as const) : ("unavailable" as const),
        oneTime: true as const,
      },
    };
  });
}
