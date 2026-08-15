import { suggestAddresses } from "@/lib/nyc";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const text = new URL(req.url).searchParams.get("q") ?? "";
  try {
    return Response.json({ suggestions: await suggestAddresses(text) });
  } catch {
    return Response.json({ suggestions: [] });
  }
}
