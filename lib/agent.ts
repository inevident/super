// A real tool-calling agent loop, not a single LLM call.
//
// The model is given the building and a set of tools, and it decides what to look
// up and what to search for. Crucially, `search_products` is Shopify's UCP global
// catalog — so the agent is genuinely shopping over Shopify's agentic commerce
// protocol, evaluating what comes back, and re-searching when the results are wrong.
//
// The model client is injected so the loop itself is testable without a live key.

import type { AgentStep, BuildingProfile, Need, Pick, Product } from "./types";
import { searchCatalog, pickBest, rentable } from "./ucp";
import { inferNeeds } from "./needs";

export const TOOLS = [
  {
    name: "search_products",
    description:
      "Search Shopify's global catalog across millions of real products from real " +
      "merchants. Returns live prices and availability. Call this multiple times to " +
      "refine — if results are the wrong size, format, or category for this specific " +
      "apartment, search again with a better query.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Plain product search phrase, no brand names." },
        max_price: { type: "number", description: "Optional ceiling in dollars." },
      },
      required: ["query"],
    },
  },
  {
    name: "add_to_cart",
    description:
      "Add one chosen product to the tenant's cart. Call once per item, after you " +
      "have searched and are satisfied the product actually fits this apartment.",
    input_schema: {
      type: "object" as const,
      properties: {
        product_url: { type: "string", description: "The exact url from a search result." },
        label: { type: "string", description: "Short category label, e.g. 'air purifier'." },
        reason: {
          type: "string",
          description:
            "One sentence, under 22 words, citing the specific number or building fact " +
            "that justifies this. Dry and concrete, never alarmist.",
        },
        urgency: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["product_url", "label", "reason", "urgency"],
    },
  },
];

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ModelClient = (
  messages: any[],
  system: string,
  opts?: { forceTool?: string }
) => Promise<{ stop_reason: string; content: any[] }>;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function systemPrompt() {
  return [
    "You are building a defensive shopping list for someone moving into a NYC",
    "apartment. Every item must DIRECTLY MITIGATE a documented problem in this",
    "building's record.",
    "",
    "HARD RULES:",
    "1. Each item must map to a specific violation type or 311 complaint listed in",
    "   the record. If you cannot name the violation it addresses, do not buy it.",
    "2. NEVER buy furniture, decor, bedding, mattresses, rugs, lamps, kitchenware,",
    "   or generic move-in goods. This is not a furnishing list. Those are an",
    "   instant failure.",
    "3. Add exactly 4-5 items, then stop.",
    "4. This is a renter's move-in kit, not a renovation. Pick the CHEAPEST result",
    "   that genuinely does the job. Keep the cart under $200 total. A $160 air",
    "   purifier or a $100 smoke alarm is a wrong answer when a $30 one is in the",
    "   results.",
    "5. The item must actually MITIGATE the violation, not work around it. Hot",
    "   water, gas, electrical, structural, fire-egress, window-guard, and alarm",
    "   violations require landlord action. Never shop for those categories.",
    "   If a violation has no safe renter-scale mitigation, buy nothing.",
    "",
    "Allowed mappings: heat -> portable space heater. vermin -> enclosed traps.",
    "mold -> dehumidifier. leak -> water leak detector. lead dust -> true HEPA",
    "purifier, labeled supplemental. Do not invent any other mapping.",
    "",
    "Size to the PHYSICAL building, which is why the facts are given to you:",
    "- Walk-up means nothing heavy. Never a window AC for an upper-floor walk-up.",
    "- Pre-1978 means lead dust is real; require true HEPA, not generic filtration.",
    "- A ~700 sq ft unit needs a room appliance, not a whole-house unit.",
    "- A renter cannot rewire or alter building systems. Never buy water heaters,",
    "  alarms, window guards, gas devices, or hard-wired products. Under $150.",
    "",
    "Process: call search_products once per need. If results are the wrong size or",
    "category for this apartment, search again with a better query. Then call",
    "add_to_cart with a url from the results. Work efficiently — do not browse.",
    "",
    "Every reason must cite the specific violation count or building fact it",
    "responds to. Dry and concrete, under 22 words, never alarmist.",
  ].join("\n");
}

function buildingBrief(p: BuildingProfile) {
  const f = p.facts;
  return JSON.stringify({
    address: p.address.label,
    openViolations: p.openViolations,
    building: f && {
      yearBuilt: f.yearBuilt,
      floors: f.floors,
      residentialUnits: f.residentialUnits,
      sqftPerUnit: f.sqftPerUnit,
      walkUp: f.walkUp,
      preWar: f.preWar,
      likelyLeadPaint: f.likelyLeadPaint,
    },
    violations: p.signals.slice(0, 6).map((s) => ({
      kind: s.kind,
      openCount: s.count,
      oldest: s.window,
      example: s.sample,
    })),
    neighborhood311: p.neighborhood.slice(0, 4),
    // What tenants reported, which often outnumbers what was confirmed.
    tenantComplaints: p.complaints?.top.slice(0, 5),
  });
}

export async function runAgent(
  profile: BuildingProfile,
  callModel: ModelClient,
  onStep: (s: AgentStep) => void,
  maxTurns = 14
): Promise<Pick[]> {
  const messages: any[] = [
    { role: "user", content: `Building record:\n${buildingBrief(profile)}` },
  ];
  const cart: Pick[] = [];
  const seen = new Map<string, Product>();
  let nudged = false;
  let forceNext = false;
  let searches = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    let res;
    try {
      res = await callModel(
        messages,
        systemPrompt(),
        forceNext ? { forceTool: "add_to_cart" } : undefined
      );
    } catch (e: any) {
      // A rate limit partway through must not discard what the agent already
      // committed. Surface it and keep the partial cart.
      onStep({ type: "thought", text: `Model unavailable (${e?.message ?? "error"}).` });
      break;
    }
    forceNext = false;
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        onStep({ type: "thought", text: block.text.trim() });
      }
    }

    const toolUses = res.content.filter((b: any) => b.type === "tool_use");

    if (!toolUses.length || res.stop_reason === "end_turn") {
      // Smaller models often search and then stop without ever committing. If we
      // have candidates but an empty cart, force the closing step once rather
      // than dropping to the deterministic fallback.
      if (!cart.length && seen.size && !nudged) {
        nudged = true;
        forceNext = true;
        messages.push({
          role: "user",
          content:
            "You have search results but have not added anything. Call add_to_cart " +
            "now for 4-5 items, using product_url values exactly as returned by your " +
            "searches. Do not search again. Do not explain.",
        });
        continue;
      }
      break;
    }

    const results: any[] = [];
    for (const use of toolUses) {
      const { name, input, id } = use;

      if (name === "search_products") {
        searches++;
        onStep({
          type: "tool",
          name: "search_products",
          input: input.max_price ? `${input.query} · under $${input.max_price}` : input.query,
        });
        let products = await searchCatalog(input.query, profile.address.zip).catch(() => []);
        // Never offer the agent something the tenant cannot legally install.
        products = rentable(products);
        if (input.max_price) products = products.filter((p) => p.price <= input.max_price);
        products = products.slice(0, 6);
        products.forEach((p) => seen.set(p.url, p));

        onStep({
          type: "result",
          name: "search_products",
          summary: products.length
            ? `${products.length} results · ${products
                .slice(0, 3)
                .map((p) => `${p.title.slice(0, 34)} $${p.price.toFixed(2)}`)
                .join(" · ")}`
            : "no results",
        });

        results.push({
          type: "tool_result",
          tool_use_id: id,
          content: JSON.stringify(
            products.map((p) => ({
              title: p.title,
              price: p.price,
              merchant: p.merchant,
              url: p.url,
            }))
          ),
        });
      } else if (name === "add_to_cart") {
        const product = seen.get(input.product_url) ?? null;
        // Reject re-adding the same product under a different label. Without this
        // the agent will reuse a url for a need it never searched for, producing
        // entries like "space heater — Small Snap Traps for Mice".
        const duplicate = product
          ? cart.some((c) => c.product?.url === product.url)
          : false;

        if (product && !duplicate) {
          cart.push({
            need: {
              label: input.label,
              query: input.label,
              reason: input.reason,
              urgency: input.urgency ?? "medium",
            },
            product,
          });
          onStep({
            type: "result",
            name: "add_to_cart",
            summary: `${input.label} — ${product.title.slice(0, 40)} $${product.price.toFixed(2)}`,
          });
        }
        results.push({
          type: "tool_result",
          tool_use_id: id,
          content: !product
            ? "unknown product_url; search first"
            : duplicate
              ? `already in the cart. Search for "${input.label}" and add a result from that search.`
              : "added",
          is_error: !product || duplicate,
        });
      }
    }

    messages.push({ role: "user", content: results });
    if (cart.length >= 5) break;

    // Left alone, smaller models will refine queries indefinitely and never
    // commit, burning every turn. Once there are plenty of candidates on the
    // table, force the closing step.
    if (!cart.length && searches >= 6 && !nudged) {
      nudged = true;
      forceNext = true;
      messages.push({
        role: "user",
        content:
          "Stop searching. You have enough candidates. Call add_to_cart now for " +
          "4-5 items using product_url values exactly as returned by your searches.",
      });
    }
  }

  return cart;
}

// OpenRouter. OpenAI-shaped wire format, so this translates the loop's neutral
// message blocks in both directions — which keeps runAgent provider-agnostic and
// lets you swap models by changing one env var.
//
// Non-streaming on purpose: the UI streams agent *steps* over our own SSE, not
// tokens, and tool_calls are simpler to assemble from a single response.
// Free tiers rate-limit hard and unpredictably — verified: both Gemma variants
// returned 429 while these five answered tool calls fine. So the client walks a
// list and sticks to the first model that works, instead of dying on the
// preferred one being busy.
// Order matters. Verified by direct probe: nemotron and cohere honour a forced
// tool_choice, which is what makes the agent commit to a cart instead of
// narrating about it. gemma often narrates, and gpt-oss-20b 400s on tool_choice
// entirely, so they sit lower.
export const FREE_MODELS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "google/gemma-4-26b-a4b-it:free",
];

export function openrouterClient(
  apiKey: string,
  models: string[],
  tools: readonly ToolDefinition[] = TOOLS
): ModelClient {
  const toOpenAITools = () =>
    tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

  const toOpenAIMessages = (messages: any[], system: string) => {
    const out: any[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (typeof m.content === "string") {
        out.push({ role: m.role, content: m.content });
        continue;
      }
      if (m.role === "assistant") {
        const text = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        const calls = m.content
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => ({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
        out.push({
          role: "assistant",
          content: text || null,
          ...(calls.length ? { tool_calls: calls } : {}),
        });
        continue;
      }
      // Tool results become one `tool` message each.
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(b.content) });
        }
      }
    }
    return out;
  };

  // Once a model answers, stay on it for the rest of the conversation.
  let pinned: string | null = null;

  return async (messages, system, opts) => {
    const body: any = {
      messages: toOpenAIMessages(messages, system),
      ...(tools.length ? { tools: toOpenAITools() } : {}),
      // These models reason at length before emitting the call. At 1200 the
      // response was truncating mid-tool-call, producing malformed arguments
      // that got dropped, so the agent looked like it was refusing to commit.
      max_tokens: 4000,
    };
    // Smaller models narrate 'I will add these' instead of emitting the call.
    // Forcing tool_choice makes the closing step deterministic.
    if (opts?.forceTool) {
      body.tool_choice = { type: "function", function: { name: opts.forceTool } };
    }

    // Prefer whatever answered last, but fall through the rest if it has since
    // been rate-limited — free tiers routinely 429 partway through a conversation.
    const order = pinned ? [pinned, ...models.filter((m) => m !== pinned)] : models;
    const failures: string[] = [];
    let d: any = null;
    const deadline = Date.now() + 30_000;

    for (const candidate of order) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let res: Response;
      try {
        res = await fetchWithTimeout(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
              "HTTP-Referer": "https://super.local",
              "X-Title": "Super",
            },
            body: JSON.stringify({ model: candidate, ...body }),
          },
          Math.min(12_000, remaining)
        );
      } catch {
        failures.push(`${candidate} (timeout/network)`);
        continue;
      }

      const parsed = res.ok ? await res.json().catch(() => null) : null;

      if (!res.ok || parsed?.error || !parsed?.choices?.[0]?.message) {
        const why = parsed?.error?.code ?? res.status;
        failures.push(`${candidate} (${why})`);
        continue;
      }

      pinned = candidate;
      d = parsed;
      break;
    }

    if (!d) throw new Error(`all models unavailable: ${failures.join(", ")}`);

    const msg = d.choices[0].message;

    const content: any[] = [];
    if (msg.content) content.push({ type: "text", text: msg.content });

    let dropped = 0;
    for (const c of msg.tool_calls ?? []) {
      let input: any = {};
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        dropped++;
        continue;
      }
      content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
    }

    const finish = d.choices[0].finish_reason;

    // Never fail silently here: a dropped call or a truncated response is the
    // difference between the agent committing and appearing to stall.
    if (dropped || finish === "length") {
      content.push({
        type: "text",
        text: `[${pinned}: ${dropped} malformed tool call(s)${finish === "length" ? ", response hit the token limit" : ""}]`,
      });
    }
    return {
      stop_reason: finish === "tool_calls" ? "tool_use" : "end_turn",
      content,
    };
  };
}

// Live Anthropic client. Tool use is the whole point here, so this talks to the
// Messages API directly rather than through a wrapper.
export function anthropicClient(
  apiKey: string,
  tools: readonly ToolDefinition[] = TOOLS
): ModelClient {
  return async (messages, system, opts) => {
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: process.env.SUPER_MODEL ?? "claude-sonnet-5",
          max_tokens: 2048,
          system,
          ...(tools.length ? { tools } : {}),
          ...(opts?.forceTool ? { tool_choice: { type: "tool", name: opts.forceTool } } : {}),
          messages,
        }),
      },
      25_000
    );
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const d = await res.json();
    return { stop_reason: d.stop_reason, content: d.content };
  };
}

// Pick whichever provider is configured. OpenRouter wins when both are present,
// since that is the free path. Returns null when neither is set, which drops the
// pipeline to the deterministic fallback.
export function selectModel(tools: readonly ToolDefinition[] = TOOLS): ModelClient | null {
  const or = process.env.OPENROUTER_API_KEY;
  if (or) {
    // SUPER_MODEL pins one model; otherwise walk the free list until one answers.
    const preferred = process.env.SUPER_MODEL;
    return openrouterClient(or, preferred ? [preferred] : FREE_MODELS, tools);
  }
  const anthropic = process.env.ANTHROPIC_API_KEY;
  if (anthropic) return anthropicClient(anthropic, tools);
  return null;
}

// Deterministic fallback so the demo cannot die on a missing key or a bad response.
export async function fallbackPicks(profile: BuildingProfile): Promise<Pick[]> {
  const needs: Need[] = await inferNeeds(profile);

  // Search in parallel, then choose sequentially so two needs cannot land on the
  // same product. This previously carried its own copy of the price filter,
  // which drifted from pickBest's ceiling; it now shares that one implementation.
  const results = await Promise.all(
    needs.map((need) =>
      searchCatalog(need.query, profile.address.zip).catch(() => [] as Product[])
    )
  );

  const used = new Set<string>();
  return needs.map((need, i) => {
    const available = results[i].filter((p) => !used.has(p.url));
    const product = pickBest(available);
    if (product) used.add(product.url);
    return { need, product };
  });
}
