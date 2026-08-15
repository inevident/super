// lib/autofill/panel.ts
// Bottom-Center Panel — core logic for the floating autofill panel

import { loadProfile, saveProfile, type RenterProfile, type FieldMapping } from "./profile";

export type PanelState = "collapsed" | "expanded" | "recording" | "filling" | "review" | "success" | "error";

export type ApplicationRecord = {
  lotteryId: string;
  lotteryName: string;
  submittedAt: string;
  confirmationId: string | null;
  status: "submitted" | "confirmed" | "error";
  formData: Record<string, string>;
};

export type PanelData = {
  state: PanelState;
  fields: FieldMapping[];
  fillProgress: number;
  totalFields: number;
  filledFields: string[];
  errorMessage: string | null;
  captchaPending: boolean;
  applications: ApplicationRecord[];
};

// Build panel data from current profile
export function buildPanelData(profile: RenterProfile | null): PanelData {
  if (!profile) {
    return {
      state: "collapsed",
      fields: [],
      fillProgress: 0,
      totalFields: 0,
      filledFields: [],
      errorMessage: null,
      captchaPending: false,
      applications: [],
    };
  }

  const fields = profile.forms.flatMap((f) => f.fields);
  const apps = (profile as any).applications || [];

  return {
    state: "expanded",
    fields,
    fillProgress: 0,
    totalFields: fields.length,
    filledFields: [],
    errorMessage: null,
    captchaPending: false,
    applications: apps,
  };
}

// Check for duplicate application
export function checkDuplicate(
  profile: RenterProfile,
  lotteryId: string
): ApplicationRecord | undefined {
  const apps = (profile as any).applications || [];
  return apps.find((a: ApplicationRecord) => a.lotteryId === lotteryId);
}

// Save application record
export function recordApplication(
  profile: RenterProfile,
  record: ApplicationRecord
): RenterProfile {
  const apps = (profile as any).applications || [];
  apps.push(record);
  (profile as any).applications = apps;
  saveProfile(profile);
  return profile;
}

// Generate formatted summary for clipboard
export function formatApplicationSummary(fields: FieldMapping[]): string {
  const labelMap: [string, string][] = [
    ["First Name", "firstName"],
    ["Last Name", "lastName"],
    ["Phone Number", "phone"],
    ["Email Address", "email"],
    ["Address", "address"],
    ["Apt #", "apt"],
    ["City", "city"],
    ["State", "state"],
    ["Zip Code", "zip"],
    ["Household Size", "household"],
    ["Annual Income", "income"],
  ];

  const valueMap = new Map<string, string>();
  for (const field of fields) {
    const key = field.label.toLowerCase().replace(/[^a-z]/g, "");
    valueMap.set(key, field.value);
  }

  const lines: string[] = [];
  for (const [label, key] of labelMap) {
    const value = valueMap.get(key);
    if (value) lines.push(`${label}: ${value}`);
  }
  return lines.join("\n");
}

// Field matching: map stored fields to form field labels
export function findFieldByLabel(fields: FieldMapping[], label: string): FieldMapping | undefined {
  const normalized = label.toLowerCase().replace(/[^a-z]/g, "");
  return fields.find((f) => {
    const fNormalized = f.label.toLowerCase().replace(/[^a-z]/g, "");
    return fNormalized === normalized ||
           fNormalized.includes(normalized) ||
           normalized.includes(fNormalized);
  });
}

// Validate all required fields are present
export function validateFields(fields: FieldMapping[]): { valid: boolean; missing: string[] } {
  const required = ["firstname", "lastname", "phonenumber", "emailaddress", "address", "city", "state", "zipcode", "householdsize", "income"];
  const present = new Set(fields.map((f) => f.label.toLowerCase().replace(/[^a-z]/g, "")));
  const missing = required.filter((r) => !present.has(r));
  return { valid: missing.length === 0, missing };
}
