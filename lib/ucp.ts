// Commerce spine: Shopify Universal Commerce Protocol over raw MCP JSON-RPC.
//
// Notes from the spike, so nobody rediscovers them:
//   - No auth, no signup, no session. A single POST works.
//   - No `initialize` handshake needed against the global catalog.
//   - Results arrive on result.structuredContent, NOT result.content[].text.
//   - Prices are integer minor units (1299 === $12.99).

import type { Need, Product } from "./types";

const ENDPOINT = "https://catalog.shopify.com/api/ucp/mcp";
const AGENT_PROFILE =
  "https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json";
const UCP_TIMEOUT = 12_000;
const CATALOG_TTL = 5 * 60_000;
const catalogCache = new Map<string, { expires: number; products: Product[] }>();

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function call(name: string, args: Record<string, unknown>) {
  const res = await fetchWithTimeout(
    ENDPOINT,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name,
          arguments: {
            ...args,
            meta: {
              "ucp-agent": { profile: AGENT_PROFILE },
              "idempotency-key": crypto.randomUUID(),
            },
          },
        },
      }),
      cache: "no-store",
    },
    UCP_TIMEOUT
  );

  if (!res.ok) throw new Error(`UCP ${res.status}`);

  const text = await res.text();
  // Endpoint returns plain JSON today, but advertises SSE. Handle both.
  const payload =
    text.startsWith("event:") || text.includes("\ndata:")
      ? JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim())
      : JSON.parse(text);

  if (payload.error) throw new Error(payload.error.message ?? "UCP error");
  return payload.result?.structuredContent ?? null;
}

export async function searchCatalog(query: string, zip: string): Promise<Product[]> {
  const key = `${query.trim().toLowerCase()}|${zip || "10001"}`;
  const cached = catalogCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.products;

  const sc = await call("search_catalog", {
    catalog: {
      query,
      context: { postal_code: zip || "10001", address_region: "NY" },
    },
  });

  const products = sc?.result?.products ?? sc?.products ?? [];
  const normalized = products.flatMap((p: any) => {
    const v = p.variants?.[0];
    if (!v?.url || !v?.price) return [];
    let merchant = "";
    try {
      merchant = new URL(v.url).hostname.replace(/^www\./, "");
    } catch {
      return [];
    }
    return [
      {
        title: p.title,
        price: v.price.amount / 100,
        currency: v.price.currency ?? "USD",
        image: p.media?.[0]?.url ?? v.media?.[0]?.url,
        url: v.url,
        merchant,
      } as Product,
    ];
  });
  catalogCache.set(key, { expires: Date.now() + CATALOG_TTL, products: normalized });
  return normalized;
}

// One search per need, in parallel. Sequential is far too slow to demo.
export async function shopFor(needs: Need[], zip: string) {
  return Promise.all(
    needs.map(async (need) => {
      try {
        const products = await searchCatalog(need.query, zip);
        return { need, product: pickBest(products) };
      } catch {
        return { need, product: null };
      }
    })
  );
}

// Cheapest credible result. The ceiling matters: without it the deterministic
// path picked an 80-pint whole-house dehumidifier for a 700 sq ft apartment,
// which is the same mistake the agent's prompt forbids. $150 keeps every item
// plausibly renter-scale; return no product when nothing safe fits.
// A renter cannot install these, whatever the prompt says. Verified needed: the
// agent bought a "First Alert 9120B 120V AC/DC Hardwired" smoke alarm and a
// tankless on-demand water heater, both of which require an electrician.
const NOT_RENTER_INSTALLABLE =
  /hard[\s-]?wired|hardwire|240\s?v|220\s?v|high[\s-]?voltage|whole[\s-]house|requires? installation|professional install|tankless|water heater|electric shower|breaker panel|gas line/i;

export function rentable(products: Product[]): Product[] {
  return products.filter((p) => !NOT_RENTER_INSTALLABLE.test(p.title));
}

export function pickBest(products: Product[]): Product | null {
  if (!products.length) return null;
  const installable = rentable(products);
  const sane = installable.filter((p) => p.price >= 5 && p.price <= 150);
  if (!sane.length) return null;
  return sane.sort((a, b) => a.price - b.price)[0];
}
