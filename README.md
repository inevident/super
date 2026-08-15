# Super

The AI building super for your new NYC apartment.

Enter an address. Super pulls the building's real public record — open HPD
violations, 311 complaint history — infers what living there is actually going
to be like, and builds a real shopping cart against it.

Built for The New York City Hackathon, August 15 2026.

---

## Verified setup

Every command below was run against production and confirmed working. No API
keys, no signups, no approvals anywhere in this stack.

### Shopify UCP (commerce spine)

`@shopify/ucp-cli` v0.6.3 — searches the global Shopify catalog across millions
of products from real merchants. Returns real variant IDs, live prices,
availability, images, and buyable URLs.

```bash
npm install -g @shopify/ucp-cli
ucp profile init --name agent
ucp catalog search --set /query=space-heater --format json
```

Note the flag shape: the query goes through `--set /query=...`, not as a
positional argument. A bare `ucp catalog search "space heater"` fails with
`A query is required`.

Buyer location is a first-class input — this is the hook into the NYC angle:

```bash
ucp catalog search \
  --set /query=window-air-conditioner \
  --set /context/postal_code=11237 \
  --set /context/address_region=NY \
  --format json
```

Register it as an MCP server so an agent can shop natively:

```bash
ucp mcp add
```

Other subcommands: `cart`, `checkout`, `order`, `discover`, `doctor`, `use`.
Run `ucp <cmd> --input-schema` to get the exact payload schema for any of them.

### NYC Open Data (data spine)

Plain HTTP GET, no key, no auth. Socrata SoQL query params.

| Dataset | ID | Use |
|---|---|---|
| HPD housing violations | `wvxf-dwi5` | Heat, hot water, vermin — per building and apartment |
| 311 service requests | `erm2-nwe9` | Noise, parking, sanitation — per address and ZIP |
| Restaurant inspections | `43nn-pn8j` | Grades and violation text by establishment |

```bash
curl "https://data.cityofnewyork.us/resource/wvxf-dwi5.json?\$limit=5&\$select=violationid,housenumber,streetname,novdescription,currentstatus"
```

The `novdescription` field is the narrative fuel — it comes back specific down
to the apartment and floor.

---

## Architecture

Two spines meeting at one frozen contract.

```
address ──▶ [data spine] ──▶ { needs } ──▶ [commerce spine] ──▶ cart + checkout
             HPD / 311                       UCP catalog search
```

### The contract

Freeze this before anyone writes code. Both spines build against a hardcoded
fixture of it, so neither blocks the other and integration is a swap, not a
merge.

```js
{
  needs: [
    {
      label:  "space heater",
      reason: "14 open heat complaints since November",
      query:  "space heater"      // sent to catalog search
    }
  ]
}
```

## Team

Three people, one owner per seam:

- **Data spine** — address → building profile
- **Commerce spine** — needs → products → cart → checkout
- **Surface and story** — the screen, the pitch, the backup video

Trunk-based. Push to `main`, say out loud what you touched. No branches, no PRs
— eight hours is too short for the ceremony, and conflicts cost more than
review saves.

---

## Repo status

Private. Flip it public at submission time:

```bash
gh repo edit --visibility public --accept-visibility-change-consequences
```

## What's here

- `app/` — single-screen UI, the streaming scan route, address autocomplete
- `lib/nyc.ts` — address → BBL/BIN → violations, complaints, PLUTO, footprint
- `lib/ucp.ts` — Shopify UCP catalog client over MCP JSON-RPC
- `lib/agent.ts` — the tool-calling agent loop and model failover
- `lib/fixtures.ts` — recorded run powering the offline demo
