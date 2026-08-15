import { getMarketplaceListing } from "@/lib/marketplace";
import type { RenterBrief } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = String(params.get("id") ?? "").trim();
  if (!/^[a-zA-Z0-9-]{1,180}$/.test(id)) return Response.json({ error: "Invalid listing id" }, { status: 400 });

  const householdSize = Number(params.get("householdSize"));
  const annualIncome = Number(params.get("annualIncome"));
  const brief = String(params.get("brief") ?? "").slice(0, 600);
  const input: RenterBrief | undefined =
    Number.isInteger(householdSize) && householdSize > 0 && Number.isFinite(annualIncome)
      ? { brief, householdSize, annualIncome }
      : undefined;

  try {
    const listing = await getMarketplaceListing(id, input);
    if (!listing) return Response.json({ error: "Listing not found" }, { status: 404 });
    return Response.json(listing, {
      headers: { "cache-control": "private, max-age=60, stale-while-revalidate=300" },
    });
  } catch (error: any) {
    return Response.json({ error: error?.message ?? "Listing unavailable" }, { status: 502 });
  }
}
