# Super

An agentic NYC rental marketplace that checks whether a household qualifies, then checks the building before the renter applies.

Super searches active affordable-housing opportunities, verifies household and income bands deterministically, reads NYC HPD records, and builds a Shopify move-in kit from safe renter-scale needs.

Built for The New York City Hackathon, August 15, 2026.

## What Super does

1. Turns a renter's natural-language brief into borough, neighborhood, bedroom, rent, subway, and amenity preferences.
2. Searches active NYC Housing Connect inventory and groups duplicate unit rows into readable offers.
3. Enforces household size, income, bedroom, and rent requirements in code. The model can explain a match but cannot override eligibility.
4. Resolves each address to NYC building identifiers and checks current HPD violations, PLUTO facts, complaints, and building massing.
5. Ranks safer eligible listings while retaining a clearly labeled violation-backed Precheck example for the Shopify workflow.
6. Prices safe items through Shopify's global catalog. The Violation Precheck total includes only documented-condition mitigations; optional building, transit, and development-photo fit items are labeled and priced separately.

## Agent and model behavior

OpenRouter stays server-side. The primary model is `google/gemma-4-31b-it:free`; a rate limit, provider timeout, or missing required tool call falls through immediately to `openai/gpt-oss-20b:free`, then the remaining configured fallback models. Authentication, billing, and bad-request errors fail directly instead of multiplying requests. If no model responds, brief parsing and eligibility still work through deterministic rules.

When a renter opens a listing, Super can inspect up to three allowlisted development photos for limited visible cues such as exposed windows or a compact room. Photo suggestions are optional, explicitly note that the exact unit may differ, and never diagnose safety conditions from an image. Model evidence is converted into server-owned explanation text before it reaches the UI.

## Safety contract

Violation-backed Shopify mappings are deliberately narrow:

- Heat → portable space heater
- Mold or damp → dehumidifier
- Vermin → enclosed traps
- Leaks → leak detector
- Lead dust → true HEPA purifier, labeled supplemental

Hot water, gas, electrical, structural, fire-egress, window-guard, and alarm violations remain landlord-action red flags. They never become shopping recommendations. Catalog results are checked again by product title so glue traps, hardwired products, high-voltage equipment, and mismatched categories cannot re-enter as fallbacks.

Optional apartment-fit categories include no-drill privacy shades, removable window insulation, compact white-noise machines, and under-bed storage. Their source is shown as Building fit, Location fit, or Photo-informed instead of HPD violation.

## Run locally

```bash
npm install
npm run dev
```

Create `.env.local` with an OpenRouter key to enable model planning and photo analysis:

```bash
OPENROUTER_API_KEY=your_key_here
```

NYC Housing Connect, NYC Open Data, Geosearch, and Shopify catalog search are keyless. Without OpenRouter, Super falls back to deterministic planning and skips photo analysis.

## Verify

```bash
npm test -- --run
npm run typecheck
npm run build
```

## Main modules

- `app/components/Marketplace.tsx` — list/map marketplace and listing detail panel
- `lib/marketplace.ts` — search, deterministic eligibility, ranking, HPD enrichment, and SSE events
- `lib/housing-connect.ts` — live Housing Connect adapter with snapshot fallback
- `lib/nyc.ts` — address resolution, HPD records, PLUTO, complaints, and building geometry
- `lib/contextual-precheck.ts` — bounded building, location, and development-photo recommendations
- `lib/precheck.ts` — safe category mapping, product validation, and shared Shopify pricing
- `lib/agent.ts` — OpenRouter/Anthropic clients, tool calling, and model failover
- `lib/ucp.ts` — Shopify catalog client over UCP MCP JSON-RPC
- `lib/showcase.ts` — transparent recorded building case used when live inventory has no actionable violation kit

## Team workflow

Three people, one owner per seam:

- Data and inventory
- Agent and commerce
- Marketplace surface and story

Trunk-based: keep changes small, test before pushing, and treat the marketplace implementation on `main` as the integration source of truth.
