import { selectModel, type ToolDefinition } from "./agent";
import type { RenterBrief, SearchPlan } from "./types";

const BOROUGHS = ["Manhattan", "Brooklyn", "Bronx", "Queens", "Staten Island"];
const PLAN_TTL = 10 * 60_000;
const planCache = new Map<string, { expires: number; plan: SearchPlan }>();
const NEIGHBORHOODS = [
  "Astoria",
  "Bedford-Stuyvesant",
  "Bushwick",
  "Chelsea",
  "Crown Heights",
  "Downtown Brooklyn",
  "East Harlem",
  "Flushing",
  "Fordham",
  "Harlem",
  "Jackson Heights",
  "Jamaica",
  "Long Island City",
  "Mott Haven",
  "Prospect Heights",
  "Sunnyside",
  "Washington Heights",
  "Williamsburg",
  "Woodside",
];

const AMENITIES = [
  "accessible entrance",
  "air-conditioning",
  "bike storage",
  "dishwasher",
  "elevator",
  "gym",
  "laundry",
  "outdoor space",
  "pets allowed",
  "smoke-free",
];

const PLANNER_TOOLS: ToolDefinition[] = [
  {
    name: "set_search_plan",
    description:
      "Translate a renter's brief into structured filters. Include only constraints or preferences actually stated by the renter.",
    input_schema: {
      type: "object",
      properties: {
        boroughs: { type: "array", items: { type: "string" } },
        neighborhoods: { type: "array", items: { type: "string" } },
        min_bedrooms: { type: ["number", "null"] },
        max_bedrooms: { type: ["number", "null"] },
        max_rent: { type: ["number", "null"] },
        subway_lines: { type: "array", items: { type: "string" } },
        amenities: { type: "array", items: { type: "string" } },
        priorities: { type: "array", items: { type: "string" } },
      },
      required: [
        "boroughs",
        "neighborhoods",
        "min_bedrooms",
        "max_bedrooms",
        "max_rent",
        "subway_lines",
        "amenities",
        "priorities",
      ],
    },
  },
];

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  studio: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

function titleCase(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function bedroomPlan(text: string): SearchPlan["bedrooms"] {
  const lower = text.toLowerCase();
  if (/\bstudio\b/.test(lower)) return { min: 0, max: 0 };
  const match = lower.match(/\b(\d+|one|two|three|four|five|six)[\s-]*(?:bed|bedroom)s?\b/);
  if (!match) return null;
  const number = /^\d+$/.test(match[1]) ? Number(match[1]) : WORD_NUMBERS[match[1]];
  if (!Number.isFinite(number)) return null;
  const prefix = lower.slice(Math.max(0, match.index! - 18), match.index);
  return /at least|minimum|min\.?\s*$|\+\s*$/.test(prefix)
    ? { min: number, max: 6 }
    : { min: number, max: number };
}

function rentCeiling(text: string): number | null {
  const lower = text.toLowerCase();
  const patterns = [
    /(?:under|below|up to|max(?:imum)?|budget(?: of)?)[\s:$]*([0-9][0-9,]{2,5})/i,
    /\$\s*([0-9][0-9,]{2,5})(?:\s*\/\s*mo|\s+monthly|\s+rent)?/i,
  ];
  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (!match) continue;
    const amount = Number(match[1].replace(/,/g, ""));
    if (amount >= 200 && amount <= 20_000) return amount;
  }
  return null;
}

export function parseBriefDeterministically(input: RenterBrief): SearchPlan {
  const text = input.brief.trim();
  const lower = text.toLowerCase();
  const boroughs = BOROUGHS.filter((borough) => lower.includes(borough.toLowerCase()));
  const neighborhoods = NEIGHBORHOODS.filter((neighborhood) =>
    lower.includes(neighborhood.toLowerCase())
  );
  const subwayLines = unique(
    [...lower.matchAll(/\b([1234567acegjlmnqrwzbdf])\s*(?:train|line)\b/gi)].map((m) =>
      m[1].toUpperCase()
    )
  );
  const amenities = AMENITIES.filter((amenity) => {
    const aliases = amenity === "air-conditioning" ? ["air conditioning", "a/c", "ac"] : [amenity];
    return aliases.some((alias) => lower.includes(alias));
  });
  const priorities = unique(
    [
      /cheap|lowest rent|afford/.test(lower) ? "lowest rent" : "",
      /safe|violations?|building record/.test(lower) ? "building safety" : "",
      /subway|train|transit|commute/.test(lower) ? "transit" : "",
      /soon|urgent|quick/.test(lower) ? "deadline" : "",
      ...amenities,
    ].filter(Boolean)
  );

  return {
    boroughs,
    neighborhoods,
    bedrooms: bedroomPlan(text),
    maxRent: rentCeiling(text),
    subwayLines,
    amenities,
    priorities: priorities.length ? priorities : ["eligibility", "building safety", "lowest rent"],
    generatedBy: "rules",
  };
}

function sanitizePlan(raw: Record<string, unknown>, fallback: SearchPlan): SearchPlan {
  const boroughs = unique(
    (Array.isArray(raw.boroughs) ? raw.boroughs : [])
      .map((value) => titleCase(String(value)))
      .map((value) => BOROUGHS.find((borough) => borough.toLowerCase() === value.toLowerCase()))
      .filter((value): value is string => Boolean(value))
  );
  const minBedrooms = raw.min_bedrooms == null ? Number.NaN : Number(raw.min_bedrooms);
  const maxBedrooms = raw.max_bedrooms == null ? Number.NaN : Number(raw.max_bedrooms);
  const bedrooms =
    Number.isFinite(minBedrooms) && minBedrooms >= 0
      ? {
          min: Math.min(6, Math.round(minBedrooms)),
          max: Number.isFinite(maxBedrooms)
            ? Math.max(Math.round(minBedrooms), Math.min(6, Math.round(maxBedrooms)))
            : Math.min(6, Math.round(minBedrooms)),
        }
      : fallback.bedrooms;
  const maxRent = Number(raw.max_rent);

  return {
    boroughs: boroughs.length ? boroughs : fallback.boroughs,
    neighborhoods: unique(
      (Array.isArray(raw.neighborhoods) ? raw.neighborhoods : [])
        .map((value) => String(value).trim())
        .filter(Boolean)
        .slice(0, 5)
    ),
    bedrooms,
    maxRent: Number.isFinite(maxRent) && maxRent >= 200 && maxRent <= 20_000 ? maxRent : fallback.maxRent,
    subwayLines: unique(
      (Array.isArray(raw.subway_lines) ? raw.subway_lines : [])
        .map((value) => String(value).toUpperCase().replace(/[^A-Z0-9]/g, ""))
        .filter((value) => /^[1234567ACEGJLMNQRWZBDF]$/.test(value))
    ),
    amenities: unique(
      (Array.isArray(raw.amenities) ? raw.amenities : [])
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8)
    ),
    priorities: unique(
      (Array.isArray(raw.priorities) ? raw.priorities : [])
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 6)
    ),
    generatedBy: "agent",
  };
}

export async function planRenterSearch(input: RenterBrief, signal?: AbortSignal): Promise<SearchPlan> {
  if (signal?.aborted) throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
  const cacheKey = JSON.stringify([
    input.brief.trim().toLowerCase(),
    input.householdSize,
    input.annualIncome,
  ]);
  const cached = planCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.plan;
  const remember = (plan: SearchPlan) => {
    planCache.set(cacheKey, { expires: Date.now() + PLAN_TTL, plan });
    return plan;
  };
  const fallback = parseBriefDeterministically(input);
  const model = selectModel(PLANNER_TOOLS);
  if (!model) return remember(fallback);

  try {
    const response = await model(
      [
        {
          role: "user",
          content: JSON.stringify({
            brief: input.brief,
            householdSize: input.householdSize,
            annualIncome: input.annualIncome,
          }),
        },
      ],
      [
        "You convert an NYC renter's words into a search plan.",
        "Do not decide eligibility and do not infer income, household size, or unstated requirements.",
        "Use set_search_plan once. Bedrooms are exact unless the renter says at least or minimum.",
      ].join("\n"),
      {
        forceTool: "set_search_plan",
        requireTool: true,
        deadlineMs: 8_000,
        perModelTimeoutMs: 4_000,
        signal,
      }
    );
    const use = response.content.find(
      (block: any) => block.type === "tool_use" && block.name === "set_search_plan"
    );
    return remember(use?.input ? sanitizePlan(use.input, fallback) : fallback);
  } catch (error) {
    if (signal?.aborted) throw error;
    return remember(fallback);
  }
}
