import { getMarketplaceListing } from "./marketplace";
import { parseRenterBrief } from "./renter-brief";
import type { MarketplaceListing, RenterBrief } from "./types";

export type MarketplaceListingGetter = (
  id: string,
  input?: RenterBrief,
  signal?: AbortSignal
) => Promise<MarketplaceListing | null>;

function validListingId(id: string) {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,178}[a-zA-Z0-9])?$/.test(id);
}

async function listingResponse(
  request: Request,
  id: string,
  input: RenterBrief | undefined,
  getter: MarketplaceListingGetter
) {
  try {
    const listing = await getter(id, input, request.signal);
    if (!listing) return Response.json({ error: "Listing not found" }, { status: 404 });
    return Response.json(listing, {
      headers: { "cache-control": "private, max-age=60, stale-while-revalidate=300" },
    });
  } catch {
    return Response.json({ error: "Listing temporarily unavailable" }, { status: 502 });
  }
}

export async function marketplaceListingResponse(
  request: Request,
  getter: MarketplaceListingGetter = getMarketplaceListing
) {
  const params = new URL(request.url).searchParams;
  const id = String(params.get("id") ?? "").trim();
  if (!validListingId(id)) {
    return Response.json({ error: "Invalid listing id" }, { status: 400 });
  }

  const hasRenterContext = ["brief", "householdSize", "annualIncome"].some((key) => params.has(key));
  const input = hasRenterContext
    ? parseRenterBrief({
        brief: params.get("brief") ?? "",
        householdSize: params.get("householdSize"),
        annualIncome: params.get("annualIncome"),
      }, { requireBrief: false })
    : undefined;
  if (hasRenterContext && !input) {
    return Response.json({ error: "Invalid renter context" }, { status: 400 });
  }
  const validatedInput: RenterBrief | undefined = input ?? undefined;

  return listingResponse(request, id, validatedInput, getter);
}

export async function marketplaceListingPostResponse(
  request: Request,
  getter: MarketplaceListingGetter = getMarketplaceListing
) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
  const id = String(body?.id ?? "").trim();
  if (!validListingId(id)) return Response.json({ error: "Invalid listing id" }, { status: 400 });
  const input = parseRenterBrief(body?.input, { requireBrief: false });
  if (!input) return Response.json({ error: "Invalid renter context" }, { status: 400 });
  return listingResponse(request, id, input, getter);
}
