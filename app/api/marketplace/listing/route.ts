import {
  marketplaceListingPostResponse,
  marketplaceListingResponse,
} from "@/lib/marketplace-listing-response";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  return marketplaceListingResponse(request);
}

export async function POST(request: Request) {
  return marketplaceListingPostResponse(request);
}
