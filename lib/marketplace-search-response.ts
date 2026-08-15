import { runMarketplaceSearch } from "@/lib/marketplace";
import type { MarketplaceEvent, RenterBrief } from "@/lib/types";

export type MarketplaceSearchRunner = (
  input: RenterBrief,
  emit: (event: MarketplaceEvent) => void
) => Promise<unknown>;

function renterBrief(value: unknown): RenterBrief | null {
  const candidate = value as Record<string, unknown> | null;
  const brief = String(candidate?.brief ?? "").trim().slice(0, 600);
  const householdSize = Number(candidate?.householdSize);
  const annualIncome = Number(candidate?.annualIncome);
  if (!brief || !Number.isInteger(householdSize) || householdSize < 1 || householdSize > 20) return null;
  if (!Number.isFinite(annualIncome) || annualIncome < 0 || annualIncome > 10_000_000) return null;
  return { brief, householdSize, annualIncome: Math.round(annualIncome) };
}

export async function marketplaceSearchResponse(
  request: Request,
  runner: MarketplaceSearchRunner = runMarketplaceSearch
) {
  let input: RenterBrief | null = null;
  try {
    input = renterBrief(await request.json());
  } catch {}
  if (!input) {
    return Response.json(
      { error: "Enter a brief, household size, and valid annual household income." },
      { status: 400 }
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: MarketplaceEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      try {
        await runner(input!, send);
        send({ stage: "done" });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Marketplace search failed";
        send({ stage: "error", message });
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
