// Form Field Detection
// Generic form detection that works on any page with input fields.

import type { FieldMapping, FormAccessType } from "./profile";

export type DetectedField = {
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  selector: string;
  label: string;
  fieldType: FieldMapping["fieldType"];
  required: boolean;
};

export type DetectedForm = {
  element: HTMLFormElement | null;
  fields: DetectedField[];
  accessType: FormAccessType;
};

// Map field to one of the 11 known types
export function classifyField(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): FieldMapping["fieldType"] {
  if (element instanceof HTMLSelectElement) return "select";
  if (element instanceof HTMLTextAreaElement) return "text";

  const type = (element as HTMLInputElement).type?.toLowerCase();
  if (type === "email") return "email";
  if (type === "tel") return "tel";
  if (type === "number") return "number";
  if (type === "radio") return "radio";
  if (type === "checkbox") return "checkbox";
  return "text";
}

// Detect field access type based on URL patterns
export function classifyAccessType(): FormAccessType {
  const url = window.location.href.toLowerCase();
  // Known login-required housing sites
  const loginRequiredPatterns = [
    "housingconnect.nyc.gov",
  ];
  return loginRequiredPatterns.some((p) => url.includes(p)) ? "login-required" : "no-login";
}

// Build a unique CSS selector for an element
export function buildSelector(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      part += `#${CSS.escape(current.id)}`;
      parts.unshift(part);
      break;
    }
    if (current instanceof HTMLInputElement || current instanceof HTMLSelectElement) {
      const name = current.getAttribute("name");
      if (name) {
        part += `[name="${CSS.escape(name)}"]`;
      }
    }
    const classes = Array.from.current.classList).slice(0, 2).map((c) => CSS.escape(c)).join(".");
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
export function findFieldLabel(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
  // Explicit label via for/id
  if (element.id) {
    const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (label) return label.textContent?.trim() || "";
  }
  // aria-label
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();
  // Wrapping label
  const parentLabel = element.closest("label");
  if (parentLabel) {
    const text = parentLabel.textContent?.trim();
    if (text) return text;
  }
  // Placeholder
  const placeholder = element.getAttribute("placeholder");
  if (placeholder) return placeholder.trim();
  // Nearby text (preceding sibling or parent text)
  const parent = element.parentElement;
  if (parent) {
    const text = parent.textContent?.trim();
    if (text && text.length < 50) return text;
  }
  // Name attribute
  const name = element.getAttribute("name");
  if (name) return name.replace(/[_-]/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  return "Unknown Field";
}

// Detect all forms on the current page
export function detectForms(): DetectedForm[] {
  const forms = Array.from(document.querySelectorAll("form"));
  if (forms.length === 0) {
    // No <form> element — check for standalone inputs in sections
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea"
      )
    );
    if (inputs.length === 0) return [];
    return [
      {
        element: null,
        fields: inputs.map((el) => ({
          element: el,
          selector: buildSelector(el),
          label: findFieldLabel(el),
          fieldType: classifyField(el),
          required: el.hasAttribute("required") || el.hasAttribute("aria-required"),
        })),
        accessType: classifyAccessType(),
      },
    ];
  }

  return forms.map((form) => {
    const inputs = Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea"
      )
    );
    return {
      element: form,
      fields: inputs.map((el) => ({
        element: el,
        selector: buildSelector(el),
        label: findFieldLabel(el),
        fieldType: classifyField(el),
        required: el.hasAttribute("required") || el.hasAttribute("aria-required"),
      })),
      accessType: classifyAccessType(),
    };
  });
}
