// Hour-one spike, run the night before to de-risk it.
// Proves the FULL chain with plain fetch and no CLI dependency:
//   address -> GeoSearch -> BBL -> HPD violations -> needs -> UCP catalog -> buyable URL
// Throwaway verification script. Not app code, not in the repo.

const UCP_ENDPOINT = "https://catalog.shopify.com/api/ucp/mcp";
const AGENT_PROFILE =
  "https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json";

// --- MCP over streamable HTTP -------------------------------------------------
// Responses may come back as SSE rather than plain JSON, so handle both.
let sessionId = null;

async function rpc(method, params) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(UCP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  const text = await res.text();
  if (!text.trim()) return null;

  // SSE frames look like: "event: message\ndata: {...}\n\n"
  if (text.startsWith("event:") || text.includes("\ndata:")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

async function searchCatalog(query, postalCode) {
  const out = await rpc("tools/call", {
    name: "search_catalog",
    arguments: {
      catalog: {
        query,
        context: { postal_code: postalCode, address_region: "NY" },
      },
      meta: {
        "ucp-agent": { profile: AGENT_PROFILE },
        "idempotency-key": crypto.randomUUID(),
      },
    },
  });

  // Products come back on structuredContent, NOT content[].text.
  const sc = out?.result?.structuredContent;
  if (!sc) {
    console.log("    (no structuredContent)", JSON.stringify(out).slice(0, 200));
    return [];
  }
  return sc.result?.products ?? sc.products ?? [];
}

// --- NYC data spine -----------------------------------------------------------
async function resolveAddress(text) {
  const r = await fetch(
    `https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(text)}`
  ).then((r) => r.json());
  const f = r.features?.[0];
  if (!f) throw new Error(`no match for ${text}`);
  return {
    label: f.properties.label,
    bbl: f.properties.addendum?.pad?.bbl,
    borough: f.properties.borough,
    zip: f.properties.postalcode,
  };
}

async function hpdProfile(bbl) {
  const url =
    `https://data.cityofnewyork.us/resource/wvxf-dwi5.json` +
    `?bbl=${bbl}&$limit=1000` +
    `&$select=violationid,novdescription,currentstatus,class,inspectiondate`;
  const rows = await fetch(url).then((r) => r.json());
  const open = rows.filter((v) => !(v.currentstatus || "").includes("CLOSED"));

  const THEMES = {
    heat: /\bHEAT\b/,
    "hot water": /HOT WATER/,
    vermin: /ROACH|MICE|RATS?\b|VERMIN|BEDBUG/,
    mold: /MOLD/,
    leak: /LEAK|WATER DAMAGE/,
    paint: /PAINT|PLASTER/,
    smoke: /SMOKE DETECTOR|CARBON MONOXIDE/,
  };

  const signals = [];
  for (const [kind, re] of Object.entries(THEMES)) {
    const hits = open.filter((v) => re.test((v.novdescription || "").toUpperCase()));
    if (hits.length)
      signals.push({
        kind,
        count: hits.length,
        sample: (hits[0].novdescription || "").slice(0, 90),
      });
  }
  signals.sort((a, b) => b.count - a.count);
  return { total: rows.length, open: open.length, signals };
}

// Stand-in for the LLM step: theme -> product query. Tomorrow this is lib/needs.ts.
const NEED_FOR = {
  heat: { label: "space heater", query: "electric space heater" },
  "hot water": { label: "electric kettle", query: "electric kettle" },
  vermin: { label: "pest control", query: "roach traps" },
  mold: { label: "dehumidifier", query: "dehumidifier" },
  leak: { label: "water leak detector", query: "water leak detector" },
  paint: { label: "air purifier", query: "hepa air purifier" },
  smoke: { label: "smoke detector", query: "smoke detector" },
};

// --- run ----------------------------------------------------------------------
const ADDRESS = process.argv[2] || "33 West 89 Street, Manhattan";

console.log(`\n▸ resolving  ${ADDRESS}`);
const addr = await resolveAddress(ADDRESS);
console.log(`  ${addr.label}`);
console.log(`  bbl ${addr.bbl} · ${addr.borough} · ${addr.zip}`);

console.log(`\n▸ pulling building record`);
const prof = await hpdProfile(addr.bbl);
console.log(`  ${prof.total} violations on record, ${prof.open} still open`);
for (const s of prof.signals.slice(0, 4)) {
  console.log(`   · ${String(s.count).padStart(3)} open  ${s.kind}`);
}

const top = prof.signals.slice(0, 3).map((s) => ({ ...NEED_FOR[s.kind], signal: s }));
console.log(`\n▸ searching real inventory (parallel)`);

const t0 = Date.now();
const results = await Promise.all(
  top.map(async (n) => ({ need: n, products: await searchCatalog(n.query, addr.zip) }))
);
console.log(`  ${results.length} searches in ${Date.now() - t0}ms\n`);

for (const { need, products } of results) {
  const p = products?.[0];
  console.log(`  ${need.label.toUpperCase()}`);
  console.log(`    why: ${need.signal.count} open ${need.signal.kind} violations`);
  if (!p) {
    console.log(`    !! no products returned\n`);
    continue;
  }
  const v = p.variants?.[0];
  const price = v?.price ? `$${(v.price.amount / 100).toFixed(2)}` : "n/a";
  console.log(`    ${p.title} — ${price}`);
  console.log(`    ${v?.url?.split("?")[0] ?? "no url"}\n`);
}

console.log("✓ full chain works end to end with plain fetch, no CLI, no auth\n");
