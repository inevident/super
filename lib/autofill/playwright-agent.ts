// lib/autofill/playwright-agent.ts
// Playwright browser automation agent for filling Housing Connect forms

import { type RenterProfile, type FieldMapping } from "./profile";
import { findFieldByLabel } from "./panel";

export type FillResult = {
  success: boolean;
  filled: number;
  skipped: number;
  unmatched: number;
  errors: string[];
};

export type AgentConfig = {
  userDataDir: string;
  headless?: boolean;
  timeout?: number;
};

// This is a client-side agent that runs in the browser via a userscript/extension
// It communicates with a local Playwright server via WebSocket
export class PlaywrightAgent {
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = { headless: false, timeout: 10_000, ...config };
  }

  // Detect fields on the current page
  detectFields(): { selector: string; label: string; tag: string; type: string }[] {
    const fields: { selector: string; label: string; tag: string; type: string }[] = [];
    const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea"
    );

    for (const input of inputs) {
      const selector = this.buildSelector(input);
      const label = this.findFieldLabel(input);
      fields.push({
        selector,
        label,
        tag: input.tagName.toLowerCase(),
        type: input instanceof HTMLInputElement ? input.type : "select",
      });
    }
    return fields;
  }

  // Fill a single field by label match
  fillField(profile: RenterProfile, formFieldLabel: string): boolean {
    const fields = profile.forms.flatMap((f) => f.fields);
    const match = findFieldByLabel(fields, formFieldLabel);
    if (!match) return false;

    const input = document.querySelector<HTMLElement>(match.selector);
    if (!input) return false;

    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      input.value = match.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (input instanceof HTMLSelectElement) {
      const option = Array.from(input.options).find(
        (o) => o.value.toLowerCase() === match.value.toLowerCase() || o.text.toLowerCase() === match.value.toLowerCase()
      );
      if (option) {
        input.value = option.value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  // Fill all fields from profile
  fillAllFields(profile: RenterProfile): FillResult {
    const result: FillResult = { success: true, filled: 0, skipped: 0, unmatched: 0, errors: [] };
    const fields = profile.forms.flatMap((f) => f.fields);
    const formFields = this.detectFields();

    for (const formField of formFields) {
      const match = findFieldByLabel(fields, formField.label);
      if (!match) {
        result.unmatched++;
        continue;
      }
      const filled = this.fillField(profile, formField.label);
      if (filled) {
        result.filled++;
      } else {
        result.skipped++;
      }
    }

    return result;
  }

  // Check for CAPTCHA on the page
  detectCaptcha(): boolean {
    const captchaSelectors = [
      "[class*=captcha]",
      "[class*=recaptcha]",
      "[id*=captcha]",
      "[id*=recaptcha]",
      "iframe[src*=captcha]",
      "[data-sitekey]",
    ];
    for (const sel of captchaSelectors) {
      if (document.querySelector(sel)) return true;
    }
    return false;
  }

  // Build a unique CSS selector for an element
  private buildSelector(element: Element): string {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current && current !== document.body) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += "#" + CSS.escape(current.id);
        parts.unshift(part);
        break;
      }
      if (current instanceof HTMLInputElement || current instanceof HTMLSelectElement) {
        const name = current.getAttribute("name");
        if (name) part += `[name="${CSS.escape(name)}"]`;
      }
      const classes = Array.from(current.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
      if (classes) part += `.${classes}`;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((el) => el.tagName === current!.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          part += `:nth-of-type(${index})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  // Find the label associated with a field
  private findFieldLabel(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) return label.textContent?.trim() || "";
    }
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const parentLabel = element.closest("label");
    if (parentLabel) return parentLabel.textContent?.trim() || "";
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    const name = element.getAttribute("name");
    if (name) return name.replace(/[_-]/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
    return "Unknown";
  }
}
