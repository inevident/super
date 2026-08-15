import { NextRequest, NextResponse } from "next/server";
import { lookupNearbySubway } from "@/lib/transit";

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address")?.trim();
  if (!address) return NextResponse.json({ stations: [] }, { status: 400 });

  try {
    const stations = await lookupNearbySubway(address);
    return NextResponse.json({ stations });
  } catch {
    return NextResponse.json({ stations: [] }, { status: 502 });
  }
}
