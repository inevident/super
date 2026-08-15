// Inference: BuildingProfile -> Need[].
//
// Two paths on purpose. The rules path is the default and needs no key, so the
// app runs anywhere with zero config and can never fail on stage. Set
// ANTHROPIC_API_KEY to get the model-written version, which reads better because
// it quotes the actual violation text back at you.

import type { BuildingProfile, Need } from "./types";

// The allowlist is intentionally narrow. Building-system and life-safety issues
// stay landlord-action red flags; a shopping result must never imply that a
// renter can make those violations safe.
const CATALOG: Record<string, { label: string; query: string; because: string }> = {
  heat: { label: "space heater", query: "portable electric space heater", because: "the radiators can't be trusted" },
  vermin: { label: "enclosed traps", query: "enclosed indoor pest traps", because: "pest activity is documented" },
  mold: { label: "dehumidifier", query: "small room dehumidifier", because: "damp is already documented" },
  leak: { label: "leak detector", query: "water leak detector alarm", because: "water has come through before" },
  "lead paint": { label: "true HEPA purifier (supplemental)", query: "compact true hepa air purifier small room", because: "it can reduce airborne dust but does not remediate lead" },
};

export async function inferNeeds(profile: BuildingProfile): Promise<Need[]> {
  // Category selection is deterministic so a model cannot turn a landlord-only
  // violation into a renter shopping recommendation.
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
  }).slice(0, 5);

  return needs;
}
