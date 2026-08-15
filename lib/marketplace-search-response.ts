import { runMarketplaceSearch } from "@/lib/marketplace";
import { parseRenterBrief } from "@/lib/renter-brief";
import type { MarketplaceEvent, RenterBrief } from "@/lib/types";

export type MarketplaceSearchRunner = (
  input: RenterBrief,
  emit: (event: MarketplaceEvent) => void,
  options?: { signal?: AbortSignal }
) => Promise<unknown>;

const MAX_ACTIVE_SEARCHES = 4;
const MAX_SEARCHES_PER_MINUTE = 30;
let activeSearches = 0;
const recentSearches = new Map<string, number[]>();

function clientKey(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local";
}

function searchLimitResponse(request: Request) {
  const now = Date.now();
  const key = clientKey(request);
  const recent = (recentSearches.get(key) ?? []).filter((time) => now - time < 60_000);
  if (activeSearches >= MAX_ACTIVE_SEARCHES || recent.length >= MAX_SEARCHES_PER_MINUTE) {
    return Response.json(
      { error: "Super is checking several buildings right now. Try again in a moment." },
      { status: 429, headers: { "retry-after": "5" } }
    );
  }
  recent.push(now);
  recentSearches.set(key, recent);
  return null;
}

export async function marketplaceSearchResponse(
  request: Request,
  runner: MarketplaceSearchRunner = runMarketplaceSearch
) {
  let input: RenterBrief | null = null;
  try {
    input = parseRenterBrief(await request.json());
  } catch {}
  if (!input) {
    return Response.json(
      { error: "Enter a brief, household size, and valid annual household income." },
      { status: 400 }
    );
  }

  const limited = searchLimitResponse(request);
  if (limited) return limited;

  activeSearches += 1;
  const searchAbort = new AbortController();
  const abortFromRequest = () => searchAbort.abort(request.signal.reason);
  request.signal.addEventListener("abort", abortFromRequest, { once: true });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeSearches = Math.max(0, activeSearches - 1);
    request.signal.removeEventListener("abort", abortFromRequest);
  };

  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
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
        await runner(input!, send, { signal: searchAbort.signal });
        send({ stage: "done" });
      } catch (error: unknown) {
        if (searchAbort.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Marketplace search failed";
        send({ stage: "error", message });
      } finally {
        close();
        release();
      }
    },
    cancel() {
      closed = true;
      searchAbort.abort();
      release();
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
