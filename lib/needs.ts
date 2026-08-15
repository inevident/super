// Inference: BuildingProfile -> Need[].
//
// Two paths on purpose. The rules path is the default and needs no key, so the
// app runs anywhere with zero config and can never fail on stage. Set
// ANTHROPIC_API_KEY to get the model-written version, which reads better because
// it quotes the actual violation text back at you.

import type { BuildingProfile, Need } from "./types";

// Every entry must actually mitigate the violation. Hot water maps to a
// point-of-use electric heater, NOT a kettle: boiling water is a workaround, but
// a faucet/shower-mount heater actually produces hot water where it is missing.
// It must be the plug-in kind — a renter cannot install a hard-wired 240V unit.
const CATALOG: Record<string, { label: string; query: string; because: string }> = {
  heat: { label: "space heater", query: "portable electric space heater", because: "the radiators can't be trusted" },
  "hot water": {
    label: "instant water heater",
    query: "instant electric water heater faucet mount",
    because: "it heats at the tap when the building won't",
  },
  vermin: { label: "roach traps", query: "roach trap glue board", because: "you are not alone in there" },
  mold: { label: "dehumidifier", query: "small room dehumidifier", because: "damp is already documented" },
  leak: { label: "leak detector", query: "water leak detector alarm", because: "water has come through before" },
  "lead paint": { label: "air purifier", query: "compact true hepa air purifier small room", because: "old paint means dust" },
  "smoke alarm": { label: "smoke alarm", query: "smoke detector", because: "the ones installed are cited as defective" },
  "window guards": { label: "window guards", query: "window safety guard", because: "cited as missing" },
  lighting: { label: "motion night light", query: "plug in motion night light", because: "the halls are dim" },
};

const NOISE = { label: "white noise machine", query: "white noise sound machine" };

export async function inferNeeds(profile: BuildingProfile): Promise<Need[]> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await viaModel(profile);
    } catch {
      // Never let the model take the demo down.
    }
  }
  return viaRules(profile);
}

function viaRules(profile: BuildingProfile): Need[] {
  // Filter before slicing. Slicing first would spend a slot on a signal that has
  // no mapping (hot water) and drop a real one (heat) off the end.
  const needs: Need[] = profile.signals.flatMap((s) => {
    const entry = CATALOG[s.kind];
    if (!entry) return [];
    return [
      {
        label: entry.label,
        query: entry.query,
        reason: `${s.count} open ${s.kind} violation${s.count === 1 ? "" : "s"} ${s.window} — ${entry.because}.`,
        urgency: s.count > 40 ? "high" : s.count > 10 ? "medium" : "low",
      } as Need,
    ];
  }).slice(0, 4);

  const noise = profile.neighborhood.find((n) => /noise/i.test(n.complaint));
  if (noise && needs.length < 5) {
    needs.push({
      ...NOISE,
      reason: `${noise.count.toLocaleString()} noise complaints in ${profile.address.zip} in the last year.`,
      urgency: "medium",
    });
  }

  return needs;
}

async function viaModel(profile: BuildingProfile): Promise<Need[]> {
  const brief = {
    address: profile.address.label,
    openViolations: profile.openViolations,
    signals: profile.signals.slice(0, 6).map((s) => ({
      kind: s.kind,
      count: s.count,
      since: s.window,
      example: s.sample,
    })),
    neighborhood311: profile.neighborhood.slice(0, 4),
  };

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system:
        "You advise people moving into NYC apartments. Given a building's real public " +
        "violation record, name up to 5 physical products the tenant should buy before " +
        "moving in. Cite the actual numbers in each reason. Be dry and specific, never " +
        "alarmist. Reasons are one sentence, under 20 words. Respond with JSON only: " +
        '{"needs":[{"label":"","reason":"","query":"","urgency":"high|medium|low"}]}. ' +
        "`query` is a plain product search phrase with no brand names.",
      messages: [{ role: "user", content: JSON.stringify(brief) }],
    }),
  });

  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";
  const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const needs: Need[] = json.needs ?? [];
  if (!needs.length) throw new Error("empty");
  return needs.slice(0, 5);
}
