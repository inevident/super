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

// Marketplace contracts. These are deliberately plain JSON objects because they
// cross the SSE and route-handler boundary into the client.
export type RenterBrief = {
  brief: string;
  householdSize: number;
  annualIncome: number;
};

export type SearchPlan = {
  boroughs: string[];
  neighborhoods: string[];
  bedrooms: { min: number; max: number } | null;
  maxRent: number | null;
  subwayLines: string[];
  amenities: string[];
  priorities: string[];
  generatedBy: "agent" | "rules";
};

export type UnitIncomeBand = {
  householdSize: number;
  minimumIncome: number;
  maximumIncome: number;
};

export type UnitOffer = {
  id: string;
  layoutTypeId: number;
  bedrooms: number;
  label: string;
  rent: number | null;
  count: number;
  address: string;
  ami: number | null;
  minimumHouseholdSize: number;
  maximumHouseholdSize: number;
  incomeBands: UnitIncomeBand[];
};

export type ViolationRecord = {
  id: string;
  class: "A" | "B" | "C" | "Unknown";
  inspectionDate: string;
  status: string;
  currentStatusDate: string;
  floor: string;
  apartment: string;
  rentImpairing: boolean;
  description: string;
  bbl: string;
  bin: string;
};

export type RiskSummary = {
  level: "Low" | "Moderate" | "High" | "Unavailable";
  openCount: number | null;
  classCounts: { A: number; B: number; C: number };
  recentCount: number;
  residentialUnits: number | null;
  explanation: string;
};

export type PrecheckCategory =
  | "heat"
  | "mold"
  | "vermin"
  | "leaks"
  | "lead-dust"
  | "privacy"
  | "drafts"
  | "noise"
  | "storage";

export type PrecheckBasis = "violation" | "building" | "location" | "photo";

export type PrecheckRequirement = {
  category: PrecheckCategory;
  label: string;
  query: string;
  reason: string;
  violationCount: number;
  basis: PrecheckBasis;
  supplemental?: boolean;
  optional?: boolean;
};

export type PrecheckItem = PrecheckRequirement & { product: Product | null };

export type PrecheckKit = {
  categories: PrecheckRequirement[];
  items: PrecheckItem[];
  total: number | null;
  pricingStatus: "priced" | "unavailable";
  oneTime: true;
  photoAnalysisStatus?: "not-run" | "complete" | "unavailable";
};

export type LandlordRedFlag = {
  kind: string;
  count: number;
  summary: string;
};

export type MarketplaceBuilding = {
  address: string;
  city: string;
  zip: string;
  latitude: number | null;
  longitude: number | null;
  bbl: string;
  bin: string;
};

export type Eligibility = {
  status: "eligible" | "near" | "unknown";
  reasons: string[];
};

export type MarketplaceListing = {
  id: string;
  spotlight?: "precheck";
  title: string;
  description: string;
  borough: string;
  neighborhood: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  deadline: string;
  units: number;
  photo: string | null;
  photos: string[];
  amenities: string[];
  transit: string[];
  nearby: { name: string; type: string; train: string }[];
  buildings: MarketplaceBuilding[];
  offers: UnitOffer[];
  matchedOfferIds: string[];
  eligibility: Eligibility;
  matchExplanation: string;
  risk: RiskSummary;
  precheck: PrecheckKit;
  landlordRedFlags: LandlordRedFlag[];
  violations: ViolationRecord[];
  excludedHistoricalViolations: ViolationRecord[];
  profile: BuildingProfile | null;
  applyUrl: string;
  source: "live" | "snapshot" | "showcase";
};

export type BuildingAssessment = {
  profile: BuildingProfile | null;
  violations: ViolationRecord[];
  excludedHistoricalViolations: ViolationRecord[];
  risk: RiskSummary;
  recordAvailable: boolean;
};

export type MarketplaceEvent =
  | { stage: "planning"; message: string }
  | { stage: "plan"; plan: SearchPlan }
  | { stage: "inventory"; message: string; count: number; source: "live" | "snapshot" }
  | { stage: "inspecting"; message: string; completed: number; total: number }
  | { stage: "listing"; listing: MarketplaceListing }
  | { stage: "pricing"; message: string }
  | { stage: "results"; exact: MarketplaceListing[]; near: MarketplaceListing[]; showcase?: MarketplaceListing }
  | { stage: "done" }
  | { stage: "error"; message: string };
