import { selectModel, type ModelClient, type ToolDefinition } from "./agent";
import { isDevelopmentPhotoSource } from "./image-policy";
import type {
  MarketplaceListing,
  PrecheckBasis,
  PrecheckCategory,
  PrecheckRequirement,
} from "./types";

type ContextCategory = Extract<PrecheckCategory, "privacy" | "drafts" | "noise" | "storage">;

const CONTEXT_CATALOG: Record<
  ContextCategory,
  Pick<PrecheckRequirement, "category" | "label" | "query">
> = {
  privacy: {
    category: "privacy",
    label: "No-drill privacy shade",
    query: "temporary no drill blackout privacy window shade apartment renter",
  },
  drafts: {
    category: "drafts",
    label: "Removable window insulation kit",
    query: "removable window insulation kit apartment renter",
  },
  noise: {
    category: "noise",
    label: "Compact white-noise machine",
    query: "compact white noise sound machine apartment",
  },
  storage: {
    category: "storage",
    label: "Under-bed storage bins",
    query: "under bed storage bins small apartment",
  },
};

const PHOTO_CONTEXT_TOOLS: ToolDefinition[] = [
  {
    name: "set_photo_recommendations",
    description:
      "Return optional renter-scale move-in items supported by visible cues in the supplied development photos.",
    input_schema: {
      type: "object",
      properties: {
        recommendations: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              listing_id: { type: "string" },
              category: { type: "string", enum: ["privacy", "storage"] },
              evidence: {
                type: "string",
                description: "A short, literal description of the visible cue. Do not infer measurements or safety conditions.",
              },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["listing_id", "category", "evidence", "confidence"],
          },
        },
      },
      required: ["recommendations"],
    },
  },
];

const CONTEXT_TTL = 20 * 60_000;
const contextCache = new Map<
  string,
  { expires: number; recommendations: Record<string, PrecheckRequirement[]> }
>();

function compact(value: unknown, maximum = 160) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function contextRequirement(
  category: ContextCategory,
  basis: PrecheckBasis,
  reason: string
): PrecheckRequirement {
  return {
    ...CONTEXT_CATALOG[category],
    reason,
    violationCount: 0,
    basis,
    optional: true,
  };
}

export function buildDeterministicContextRequirements(
  listing: MarketplaceListing
): PrecheckRequirement[] {
  const suggestions: PrecheckRequirement[] = [];
  const facts = listing.profile?.facts;
  const offers = listing.offers.filter(
    (offer) => !listing.matchedOfferIds.length || listing.matchedOfferIds.includes(offer.id)
  );
  const compactUnit = Boolean(
    (facts?.sqftPerUnit && facts.sqftPerUnit <= 650) || offers.some((offer) => offer.bedrooms === 0)
  );

  if (compactUnit) {
    const evidence = facts?.sqftPerUnit
      ? `PLUTO estimates about ${Math.round(facts.sqftPerUnit).toLocaleString()} square feet per unit.`
      : "The matched inventory includes a studio layout.";
    suggestions.push(
      contextRequirement(
        "storage",
        "building",
        `${evidence} Optional under-bed storage preserves floor space.`
      )
    );
  }

  if (facts?.preWar || (facts?.yearBuilt && facts.yearBuilt < 1940)) {
    suggestions.push(
      contextRequirement(
        "drafts",
        "building",
        `The current structure dates to ${facts.yearBuilt || "the pre-war era"}; removable window film is an optional seasonal fit item.`
      )
    );
  }

  if (listing.transit.length) {
    const lines = listing.transit.slice(0, 4).join(" · ");
    suggestions.push(
      contextRequirement(
        "noise",
        "location",
        `${lines} transit is listed nearby; a white-noise machine is an optional sleep aid, not a building-condition claim.`
      )
    );
  }

  return suggestions.slice(0, 3);
}

function photoPrompt(listings: MarketplaceListing[]) {
  const content: any[] = [
    {
      type: "text",
      text: JSON.stringify(
        listings.map((listing) => ({
          id: listing.id,
          address: listing.address,
          neighborhood: listing.neighborhood,
          borough: listing.borough,
          bedrooms: listing.offers.map((offer) => offer.label),
          developmentPhotoWarning: "Marketing/development photo; exact unit may differ",
        }))
      ),
    },
  ];
  for (const listing of listings) {
    const photos = [...new Set([listing.photo, ...listing.photos])]
      .filter(isDevelopmentPhotoSource)
      .slice(0, 3);
    photos.forEach((photo, index) => {
      content.push({
        type: "text",
        text: `Development photo ${index + 1} for listing_id ${listing.id}:`,
      });
      content.push({ type: "image_url", image_url: { url: photo } });
    });
  }
  return content;
}

function parsePhotoRecommendations(
  listings: MarketplaceListing[],
  response: Awaited<ReturnType<ModelClient>>
) {
  const listingIds = new Set(listings.map((listing) => listing.id));
  const byListing: Record<string, PrecheckRequirement[]> = {};
  const toolUse = response.content.find(
    (block: any) => block.type === "tool_use" && block.name === "set_photo_recommendations"
  );
  const raw = Array.isArray(toolUse?.input?.recommendations)
    ? toolUse.input.recommendations
    : [];

  for (const recommendation of raw) {
    const id = compact(recommendation?.listing_id, 180);
    const category = compact(recommendation?.category, 30) as ContextCategory;
    const confidence = compact(recommendation?.confidence, 20);
    const evidence = compact(recommendation?.evidence);
    if (!listingIds.has(id) || !["privacy", "storage"].includes(category)) continue;
    if (!evidence || !["high", "medium"].includes(confidence)) continue;
    const existing = byListing[id] ?? [];
    if (existing.some((item) => item.category === category) || existing.length >= 2) continue;
    existing.push(
      contextRequirement(
        category,
        "photo",
        category === "privacy"
          ? "A development photo shows an exposed window area. Exact unit may differ; confirm dimensions before buying."
          : "A development photo shows a compact room layout. Exact unit may differ; confirm dimensions before buying."
      )
    );
    byListing[id] = existing;
  }
  return byListing;
}

async function photoRecommendations(
  listings: MarketplaceListing[],
  model: ModelClient | null,
  signal?: AbortSignal
): Promise<{
  status: "not-run" | "complete" | "unavailable";
  recommendations: Record<string, PrecheckRequirement[]>;
}> {
  if (!listings.length) return { status: "not-run", recommendations: {} };
  if (!model) return { status: "unavailable", recommendations: {} };
  try {
    const response = await model(
      [{ role: "user", content: photoPrompt(listings) }],
      [
        "You inspect NYC development marketing photos for optional move-in fit items.",
        "The photos may not depict the exact available unit. Never claim that they do.",
        "Only use literal visible cues: uncovered or highly exposed windows may support a no-drill privacy shade; a visibly compact room with limited storage may support under-bed bins.",
        "Do not diagnose violations, defects, noise, orientation, floor, safety, dimensions, or neighborhood conditions from an image.",
        "Recommend at most two items per listing and use set_photo_recommendations once. Return an empty array when no cue is clear.",
      ].join("\n"),
      {
        forceTool: "set_photo_recommendations",
        requireTool: true,
        deadlineMs: 9_000,
        perModelTimeoutMs: 4_500,
        signal,
      }
    );
    return { status: "complete", recommendations: parsePhotoRecommendations(listings, response) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "unavailable", recommendations: {} };
  }
}

export async function addContextualPrecheck(
  listings: MarketplaceListing[],
  injectedModel?: ModelClient | null,
  signal?: AbortSignal
) {
  if (signal?.aborted) throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
  const photoListings = listings
    .filter(
      (listing) =>
        [listing.photo, ...listing.photos].some(isDevelopmentPhotoSource) &&
        listing.source !== "showcase"
    )
    .slice(0, 4);
  const cacheKey = JSON.stringify(
    photoListings.map((listing) => [
      listing.id,
      [...new Set([listing.photo, ...listing.photos])].filter(isDevelopmentPhotoSource).slice(0, 3),
      listing.profile?.facts?.yearBuilt,
    ])
  );
  const useCache = injectedModel === undefined;
  const cached = useCache ? contextCache.get(cacheKey) : null;
  let photoByListing = cached?.expires && cached.expires > Date.now()
    ? cached.recommendations
    : null;
  let photoAnalysisStatus: "not-run" | "complete" | "unavailable" = photoByListing
    ? "complete"
    : "not-run";

  if (!photoByListing) {
    const model = injectedModel === undefined ? selectModel(PHOTO_CONTEXT_TOOLS) : injectedModel;
    const photoResult = await photoRecommendations(photoListings, model, signal);
    photoByListing = photoResult.recommendations;
    photoAnalysisStatus = photoResult.status;
    if (useCache && photoResult.status === "complete") {
      contextCache.set(cacheKey, {
        expires: Date.now() + CONTEXT_TTL,
        recommendations: photoByListing,
      });
    }
  }

  return listings.map((listing) => {
    const existing = listing.precheck.categories;
    const seen = new Set(existing.map((item) => item.category));
    const contextual = [
      ...buildDeterministicContextRequirements(listing),
      ...(photoByListing?.[listing.id] ?? []),
    ].filter((requirement) => {
      if (seen.has(requirement.category)) return false;
      seen.add(requirement.category);
      return true;
    });
    const room = Math.max(0, 5 - existing.length);
    return {
      ...listing,
      precheck: {
        ...listing.precheck,
        categories: [...existing, ...contextual.slice(0, room)],
        photoAnalysisStatus,
      },
    };
  });
}
