// The frozen contract between the two spines.
// Both sides build against this. Do not change it without telling the other owner.

export type Address = {
  label: string;
  bbl: string;
  bin: string; // footprints key on BIN, not BBL
  borough: string;
  zip: string;
};

// Real building geometry from NYC's footprint dataset.
export type Footprint = {
  ring: [number, number][]; // lon/lat vertices
  heightRoof: number; // feet
  groundElevation: number; // feet
};

// 82% of HPD violation texts name the floor they occurred on, which turns a
// single count into a map of where the building actually hurts.
export type FloorBreakdown = {
  counts: Record<number, number>;
  parsed: number; // how many of the open violations we could place
  worstFloor: number | null;
  worstUnit: { apt: string; count: number } | null;
};

// Tenant-filed complaints. Distinct from violations: complaints are what tenants
// reported, violations are what inspectors confirmed. The gap between them is
// often the most telling thing about a building.
export type TenantComplaints = {
  total: number;
  span: string; // "2007-2026"
  top: { category: string; count: number }[];
};

export type Signal = {
  kind: string; // "hot water", "vermin", ...
  count: number;
  window: string; // human-readable recency, e.g. "since 2023"
  sample: string; // one real violation description, verbatim
};

export type BuildingProfile = {
  address: Address;
  totalViolations: number;
  openViolations: number;
  truncated: boolean; // true when we hit the Socrata row ceiling
  signals: Signal[];
  neighborhood: { complaint: string; count: number }[]; // 311, by ZIP
  facts: BuildingFacts | null;
  footprint: Footprint | null;
  floors: FloorBreakdown;
  complaints: TenantComplaints | null;
};

// PLUTO. This is what lets the agent reason about the physical building instead of
// pattern-matching a keyword: a 4th-floor walk-up built in 1895 needs different
// things than a 2015 elevator building, even with identical violations.
export type BuildingFacts = {
  yearBuilt: number;
  floors: number;
  residentialUnits: number;
  buildingArea: number;
  sqftPerUnit: number;
  buildingClass: string;
  walkUp: boolean;
  preWar: boolean;
  likelyLeadPaint: boolean; // pre-1978
};

export type AgentStep =
  | { type: "thought"; text: string }
  | { type: "tool"; name: string; input: string }
  | { type: "result"; name: string; summary: string };

export type Need = {
  label: string; // "space heater"
  reason: string; // "60 open hot water violations, still unresolved"
  query: string; // sent to catalog search
  urgency: "high" | "medium" | "low";
};

export type Product = {
  title: string;
  price: number; // major units
  currency: string;
  image?: string;
  url: string; // directly buyable — the zero-auth path
  merchant: string;
};

export type Pick = { need: Need; product: Product | null };

export type ScanEvent =
  | { stage: "resolving"; message: string }
  | { stage: "address"; address: Address }
  | { stage: "records"; message: string }
  | { stage: "profile"; profile: BuildingProfile }
  | { stage: "thinking"; message: string }
  | { stage: "step"; step: AgentStep }
  | { stage: "needs"; needs: Need[] }
  | { stage: "shopping"; message: string }
  | { stage: "picks"; picks: Pick[] }
  | { stage: "done" }
  | { stage: "error"; message: string };
