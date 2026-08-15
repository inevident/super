import type { RenterBrief } from "./types";

export function parseRenterBrief(
  value: unknown,
  options: { requireBrief?: boolean } = {}
): RenterBrief | null {
  const candidate = value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
  const brief = String(candidate?.brief ?? "").trim().slice(0, 600);
  const householdValue = candidate?.householdSize;
  const incomeValue = candidate?.annualIncome;
  if (householdValue == null || String(householdValue).trim() === "") return null;
  if (incomeValue == null || String(incomeValue).trim() === "") return null;
  const householdSize = Number(householdValue);
  const annualIncome = Number(incomeValue);
  if ((options.requireBrief ?? true) && !brief) return null;
  if (!Number.isInteger(householdSize) || householdSize < 1 || householdSize > 20) return null;
  if (!Number.isFinite(annualIncome) || annualIncome < 0 || annualIncome > 10_000_000) return null;
  return { brief, householdSize, annualIncome: Math.round(annualIncome) };
}
