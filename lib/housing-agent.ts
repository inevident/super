// The housing agent: searches inventory, then checks each candidate's building
// against the city's violation record before recommending it.
//
// Reuses the model client, failover and forced-tool machinery from lib/agent.ts —
// only the tools and the prompt change.

import type { AgentStep } from "./types";
import type { ModelClient } from "./agent";
import { searchListings, summarise, type Listing } from "./listings";
import { resolveAddress, buildProfile } from "./nyc";

export type Shortlisted = {
  listing: Listing;
  reason: string;
  openViolations?: number;
  worstFloor?: number | null;
};

export const HOUSING_TOOLS = [
  {
    name: "search_listings",
    description:
      "Search NYC housing inventory, including HPD affordable buildings and " +
      "re-rental openings. Returns matching listings with rent where published.",
    input_schema: {
      type: "object" as const,
      properties: {
        borough: { type: "string", description: "Manhattan, Brooklyn, Bronx, Queens, Staten Island." },
        max_rent: { type: "number", description: "Monthly rent ceiling in dollars." },
        min_beds: { type: "number", description: "0 for studio." },
        with_rent_only: { type: "boolean", description: "Only listings with a published rent." },
      },
      required: [],
    },
  },
  {
    name: "check_building",
    description:
      "Look up a building's real public record before recommending it: open HPD " +
      "violations, which floor they are on, and tenant-filed complaints. ALWAYS " +
      "call this before shortlisting anything.",
    input_schema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Street address, e.g. '729 Van Sinderen Avenue, Brooklyn'." },
      },
      required: ["address"],
    },
  },
  {
    name: "shortlist",
    description:
      "Recommend one listing to the renter, after checking its building. Call once " +
      "per recommendation, up to 4.",
    input_schema: {
      type: "object" as const,
      properties: {
        listing_id: { type: "string", description: "The exact id from a search result." },
        reason: {
          type: "string",
          description:
            "One sentence under 25 words citing the building's actual record — the " +
            "open violation count, or that it came back clean.",
        },
      },
      required: ["listing_id", "reason"],
    },
  },
];

export function housingPrompt() {
  return [
    "You help someone find somewhere to live in New York City.",
    "",
    "You have something no listings site has: the building's real public record.",
    "Use it. A cheap apartment in a building with 700 open violations is not a",
    "good deal, and saying so is the entire point of this product.",
    "",
    "PROCESS:",
    "1. search_listings for what the renter asked for.",
    "2. check_building on candidates before recommending them. Never skip this.",
    "3. shortlist 3-4 that survive the check.",
    "",
    "RULES:",
    "- If a building has a heavy violation record, say so plainly and do not",
    "  shortlist it. Rejecting a bad building out loud is valuable, not a failure.",
    "- Every reason must cite the actual number you saw from check_building.",
    "- Never invent a rent, an address, or a violation count. Only use returned data.",
    "- Many affordable listings have no published rent. Say that rather than",
    "  guessing, and judge them on units and income band instead.",
    "- Be dry and concrete. Under 25 words per reason. Never alarmist.",
  ].join("\n");
}

export async function runHousingAgent(
  brief: string,
  callModel: ModelClient,
  onStep: (s: AgentStep) => void,
  maxTurns = 12
): Promise<Shortlisted[]> {
  const messages: any[] = [{ role: "user", content: `Renter's brief: ${brief}` }];
  const shortlist: Shortlisted[] = [];
  const seen = new Map<string, Listing>();
  const checked = new Map<string, { open: number; worstFloor: number | null }>();
  let searches = 0;
  let nudged = false;
  let forceNext = false;
  let forcedSearch = false;
  let forceName = "shortlist";

  for (let turn = 0; turn < maxTurns; turn++) {
    let res;
    try {
      res = await callModel(
        messages,
        housingPrompt(),
        forceNext ? { forceTool: forceName } : undefined
      );
    } catch (e: any) {
      onStep({ type: "thought", text: `Model unavailable (${e?.message ?? "error"}).` });
      break;
    }
    forceNext = false;
    forceName = "shortlist";
    messages.push({ role: "assistant", content: res.content });

    for (const b of res.content) {
      if (b.type === "text" && b.text.trim()) onStep({ type: "thought", text: b.text.trim() });
    }

    const uses = res.content.filter((b: any) => b.type === "tool_use");
    if (!uses.length || res.stop_reason === "end_turn") {
      // Small models often open by narrating ("I can search, but I need...")
      // instead of calling anything. With nothing searched yet the normal nudge
      // can never fire, so force the first search explicitly.
      if (!seen.size && !forcedSearch) {
        forcedSearch = true;
        forceNext = true;
        forceName = "search_listings";
        messages.push({
          role: "user",
          content:
            "Do not ask questions. Call search_listings now with your best reading " +
            "of the brief, then check_building on the candidates.",
        });
        continue;
      }
      if (!shortlist.length && seen.size && !nudged) {
        nudged = true;
        forceNext = true;
        messages.push({
          role: "user",
          content:
            "Call shortlist now for 3-4 listings using listing_id values exactly as " +
            "returned by your searches. Do not search again.",
        });
        continue;
      }
      break;
    }

    const results: any[] = [];
    for (const use of uses) {
      const { name, input, id } = use;

      if (name === "search_listings") {
        searches++;
        const parts = [
          input.borough,
          input.max_rent ? `under $${input.max_rent}` : null,
          input.min_beds != null ? `${input.min_beds}+ bed` : null,
        ].filter(Boolean);
        onStep({ type: "tool", name: "search_listings", input: parts.join(" · ") || "all" });

        const found = searchListings({
          borough: input.borough,
          maxRent: input.max_rent,
          minBeds: input.min_beds,
          withRentOnly: input.with_rent_only,
        });
        found.forEach((l) => seen.set(l.id, l));

        onStep({
          type: "result",
          name: "search_listings",
          summary: found.length
            ? `${found.length} listings · ${found.slice(0, 3).map((l) => `${(l.name || l.address).slice(0, 26)}${l.rent ? ` $${l.rent}` : ""}`).join(" · ")}`
            : "no listings match",
        });
        results.push({
          type: "tool_result",
          tool_use_id: id,
          content: JSON.stringify(found.map(summarise)),
        });
      } else if (name === "check_building") {
        onStep({ type: "tool", name: "check_building", input: String(input.address).slice(0, 60) });
        let payload: any = { error: "no record found" };
        try {
          const addr = await resolveAddress(String(input.address));
          const profile = await buildProfile(addr);
          checked.set(String(input.address), {
            open: profile.openViolations,
            worstFloor: profile.floors.worstFloor,
          });
          payload = {
            address: addr.label,
            openViolations: profile.openViolations,
            worstFloor: profile.floors.worstFloor,
            topIssues: profile.signals.slice(0, 3).map((s) => `${s.kind}: ${s.count}`),
            tenantComplaints: profile.complaints?.total ?? null,
            yearBuilt: profile.facts?.yearBuilt ?? null,
          };
          onStep({
            type: "result",
            name: "check_building",
            summary: `${profile.openViolations} open violations${
              profile.floors.worstFloor ? ` · worst floor ${profile.floors.worstFloor}` : ""
            }${profile.signals[0] ? ` · ${profile.signals[0].kind} ${profile.signals[0].count}` : ""}`,
          });
        } catch (e: any) {
          onStep({ type: "result", name: "check_building", summary: "no record found" });
        }
        results.push({ type: "tool_result", tool_use_id: id, content: JSON.stringify(payload) });
      } else if (name === "shortlist") {
        const listing = seen.get(String(input.listing_id)) ?? null;
        const duplicate = listing ? shortlist.some((s) => s.listing.id === listing.id) : false;
        if (listing && !duplicate) {
          const chk = checked.get(listing.address) ?? checked.get(`${listing.address}, ${listing.borough}`);
          shortlist.push({
            listing,
            reason: String(input.reason ?? ""),
            openViolations: chk?.open,
            worstFloor: chk?.worstFloor ?? null,
          });
          onStep({
            type: "result",
            name: "shortlist",
            summary: `${(listing.name || listing.address).slice(0, 42)}${listing.rent ? ` $${listing.rent}` : ""}`,
          });
        }
        results.push({
          type: "tool_result",
          tool_use_id: id,
          content: !listing
            ? "unknown listing_id; search first"
            : duplicate
              ? "already shortlisted"
              : "added",
          is_error: !listing || duplicate,
        });
      }
    }

    messages.push({ role: "user", content: results });
    if (shortlist.length >= 4) break;

    // Same guard as the shopping agent: stop it browsing forever.
    if (!shortlist.length && searches >= 4 && !nudged) {
      nudged = true;
      forceNext = true;
      messages.push({
        role: "user",
        content: "You have enough candidates. Check any unchecked buildings, then shortlist 3-4 now.",
      });
    }
  }

  return shortlist;
}
