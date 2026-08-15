import { getMarketplaceListing } from "./marketplace";
import { parseRenterBrief } from "./renter-brief";
import { PRECHECK_SHOWCASE_ID } from "./showcase";
import type { MarketplaceListing, RenterBrief } from "./types";

export type MarketplaceListingGetter = (
  id: string,
  input?: RenterBrief,
  signal?: AbortSignal
) => Promise<MarketplaceListing | null>;

export async function marketplaceListingResponse(
  request: Request,
  getter: MarketplaceListingGetter = getMarketplaceListing
) {
  const params = new URL(request.url).searchParams;
  const id = String(params.get("id") ?? "").trim();
  if (!/^\d+$/.test(id) && id !== PRECHECK_SHOWCASE_ID) {
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

  try {
    const listing = await getter(id, validatedInput, request.signal);
    if (!listing) return Response.json({ error: "Listing not found" }, { status: 404 });
    return Response.json(listing, {
      headers: { "cache-control": "private, max-age=60, stale-while-revalidate=300" },
    });
  } catch {
    return Response.json({ error: "Listing temporarily unavailable" }, { status: 502 });
  }
}
