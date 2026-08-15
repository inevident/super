// Form Replayer
// Handles both no-login (auto-fill) and login-required (clipboard panel) modes.

import { loadProfile, saveProfile, type RenterProfile, type FieldMapping } from "./profile";
import { detectForms, type DetectedForm } from "./detect";

export type ReplayResult = {
  filled: number;
  skipped: number;
  unmatched: number;
  fields: string[];
};

// --- No-Login Path: Auto-fill directly via DOM ---

export function replayNoLogin(): ReplayResult {
  const profile = loadProfile();
  if (!profile) return { filled: 0, skipped: 0, unmatched: 0, fields: [] };

  const forms = detectForms();
  if (forms.length === 0) return { filled: 0, skipped: 0, unmatched: 0, fields: [] };

  const result: ReplayResult = { filled: 0, skipped: 0, unmatched: 0, fields: [] };

  for (const form of forms) {
    for (const field of form.fields) {
      const storedField = findMatchingField(profile, field.selector);
      if (!storedField) {
        result.unmatched++;
        continue;
      }
      if (field.element.value.trim()) {
        result.skipped++;
        continue; // Don't overwrite user input
      }
      fillField(field.element, storedField);
      highlightField(field.element);
      result.filled++;
      result.fields.push(storedField.label);
    }
  }

  updateReplayMetadata(profile, "no-login");
  return result;
}

function fillField(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  field: FieldMapping
): void {
  if (element instanceof HTMLSelectElement) {
    const option = Array.from(element.options).find(
      (opt) => opt.value.toLowerCase() === field.value.toLowerCase() || opt.text.toLowerCase() === field.value.toLowerCase()
    );
    if (option) element.value = option.value;
  } else {
    element.value = field.value;
  }
  // Trigger change event for React/forms that listen
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function highlightField(element: HTMLElement): void {
  element.style.outline = "2px solid #22c55e";
  element.style.outlineOffset = "2px";
  element.style.transition = "outline 0.2s ease";
  // Add checkmark indicator
  const checkmark = document.createElement("span");
  checkmark.textContent = "✓";
  checkmark.style.color = "#22c55e";
  checkmark.style.marginLeft = "4px";
  checkmark.setAttribute("data-autofill-indicator", "true");
  element.parentElement?.appendChild(checkmark);
}

function findMatchingField(profile: RenterProfile, selector: string): FieldMapping | undefined {
  for (const form of profile.forms) {
    for (const field of form.fields) {
      if (field.selector === selector) return field;
    }
  }
  // Fuzzy match by label if selector doesn't match
  for (const form of profile.forms) {
    for (const field of form.fields) {
      if (field.label && selector.includes(field.label.toLowerCase().replace(/\s+/g, "-"))) return field;
    }
  }
  return undefined;
}

// --- Login-Required Path: Clipboard panel ---

export function generateClipboardSummary(profile: RenterProfile): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const form of profile.forms) {
    for (const field of form.fields) {
      if (seen.has(field.label)) continue;
      seen.add(field.label);
      lines.push(`${field.label}: ${field.value}`);
    }
  }

  return lines.join("\n");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const result = document.execCommand("copy");
    document.body.removeChild(textarea);
    return result;
  }
}

export function copyFieldToClipboard(profile: RenterProfile, label: string): boolean {
  for (const form of profile.forms) {
    for (const field of form.fields) {
      if (field.label.toLowerCase() === label.toLowerCase()) {
        return !!navigator.clipboard.writeText(field.value);
      }
    }
  }
  return false;
}

export function showClipboardPanel(profile: RenterProfile): HTMLElement {
  const panel = document.createElement("div");
  panel.setAttribute("data-autofill-panel", "true");
  panel.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    width: 320px;
    max-height: 80vh;
    overflow-y: auto;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.12);
    z-index: 999999;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
  `;

  panel.innerHTML = `
    <div style="padding: 16px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center;">
      <strong style="color: #111;">Autofill Profile</strong>
      <button data-close-panel style="background: none; border: none; font-size: 18px; cursor: pointer; color: #666;">×</button>
    </div>
    <div style="padding: 16px;">
      <p style="margin: 0 0 12px; color: #666; font-size: 12px;">Click a field to copy, then paste into the form.</p>
      <div data-fields></div>
      <button data-copy-all style="margin-top: 12px; width: 100%; padding: 10px; background: #4f46e5; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 500;">
        Copy All Fields
      </button>
      <p style="margin: 8px 0 0; color: #999; font-size: 11px; text-align: center;">
        Data stored locally. Nothing leaves your browser.
      </p>
    </div>
  `;

  const fieldsContainer = panel.querySelector('[data-fields]')!;
  const seen = new Set<string>();

  for (const form of profile.forms) {
    for (const field of form.fields) {
      if (seen.has(field.label)) continue;
      seen.add(field.label);

      const row = document.createElement("div");
      row.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 0;
        border-bottom: 1px solid #f3f4f6;
        cursor: pointer;
        transition: background 0.15s;
      `;
      row.innerHTML = `
        <span style="color: #374151; font-weight: 500;">${field.label}</span>
        <span style="color: #6b7280; font-size: 13px; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${field.value}</span>
      `;
      row.addEventListener("click", async () => {
        const ok = await copyToClipboard(field.value);
        row.style.background = ok ? "#dcfce7" : "#fef2f2";
        setTimeout(() => (row.style.background = ""), 600);
      });
      fieldsContainer.appendChild(row);
    }
  }

  const closeBtn = panel.querySelector('[data-close-panel]')!;
  closeBtn.addEventListener("click", () => panel.remove());

  const copyAllBtn = panel.querySelector('[data-copy-all]') as HTMLButtonElement;
  copyAllBtn.addEventListener("click", async () => {
    const text = generateClipboardSummary(profile);
    const ok = await copyToClipboard(text);
    copyAllBtn.textContent = ok ? "Copied!" : "Copy failed";
    copyAllBtn.style.background = ok ? "#16a34a" : "#dc2626";
    setTimeout(() => {
      copyAllBtn.textContent = "Copy All Fields";
      copyAllBtn.style.background = "#4f46e5";
    }, 1200);
  });

  document.body.appendChild(panel);
  return panel;
}

function updateReplayMetadata(profile: RenterProfile, accessType: "no-login" | "login-required"): void {
  profile.metadata.lastReplayAt = new Date().toISOString();
  profile.metadata.lastReplayAccessType = accessType;
  saveProfile(profile);
}

// --- User Override Detection ---

export function detectUserOverride(element: HTMLElement): void {
  element.addEventListener(
    "input",
    () => {
      element.style.outline = "none";
      const indicator = element.parentElement?.querySelector('[data-autofill-indicator]');
      if (indicator) indicator.remove();
    },
    { once: true }
  );
}
