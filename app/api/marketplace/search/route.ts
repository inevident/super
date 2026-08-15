import { marketplaceSearchResponse } from "@/lib/marketplace-search-response";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  return marketplaceSearchResponse(request);
}
