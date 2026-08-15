// ==UserScript==
// @name         Super Autofill Agent
// @namespace    https://super-housing.nyc/
// @version      0.1.0
// @description  Autofills Housing Connect and housing lottery forms from your saved Super profile
// @match        https://housingconnect.nyc.gov/*
// @match        https://*.housingconnect.nyc.gov/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

// Super Autofill Agent — userscript wrapper
// Wraps the core agent engine for Tampermonkey/Greasymkey

(function () {
  "use strict";

  const STORAGE_KEY = "super:renter-profile-v1";

  // --- Profile helpers (mirrors lib/agent/profile.ts) ---

  function loadProfile() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.version || !Array.isArray(parsed.forms)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  // --- Form detection ---

  function buildSelector(element) {
    const parts = [];
    let current = element;
    while (current && current !== document.body) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        part += "#" + current.id;
        parts.unshift(part);
        break;
      }
      if (current.name && (current instanceof HTMLInputElement || current instanceof HTMLSelectElement)) {
        part += "[name=\"" + current.name + "\"]";
      }
      const classes = Array.from(current.classList).slice(0, 2).join(".");
      if (classes) part += "." + classes;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((el) => el.tagName === current.tagName);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          part += ":nth-of-type(" + index + ")";
        }
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(" > ");
  }

  function findFieldLabel(element) {
    if (element.id) {
      const label = document.querySelector("label[for=\"" + element.id + "\"]");
      if (label) return label.textContent.trim();
    }
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) return ariaLabel.trim();
    const parentLabel = element.closest("label");
    if (parentLabel) return parentLabel.textContent.trim();
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();
    return element.name || "Field";
  }

  function detectForms() {
    const forms = Array.from(document.querySelectorAll("form"));
    if (forms.length === 0) {
      const inputs = Array.from(document.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea"));
      if (inputs.length === 0) return [];
      return [{ element: null, fields: inputs.map((el) => ({ element: el, selector: buildSelector(el), label: findFieldLabel(el) })) }];
    }
    return forms.map((form) => {
      const inputs = Array.from(form.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea"));
      return { element: form, fields: inputs.map((el) => ({ element: el, selector: buildSelector(el), label: findFieldLabel(el) })) };
    });
  }

  // --- Clipboard panel ---

  function generateClipboardSummary(profile) {
    const lines = [];
    const seen = new Set();
    for (const form of profile.forms) {
      for (const field of form.fields) {
        if (seen.has(field.label)) continue;
        seen.add(field.label);
        lines.push(field.label + ": " + field.value);
      }
    }
    return lines.join("\n");
  }

  function showClipboardPanel(profile) {
    // Remove existing panel
    const existing = document.querySelector("[data-autofill-panel]");
    if (existing) existing.remove();

    const panel = document.createElement("div");
    panel.setAttribute("data-autofill-panel", "true");
    panel.style.cssText = "position:fixed;top:20px;right:20px;width:320px;max-height:80vh;overflow-y:auto;background:white;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.12);z-index:999999;font-family:system-ui,sans-serif;font-size:14px;";
    panel.innerHTML = "<div style=\"padding:16px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;\"><strong style=\"color:#111;\">Super Autofill</strong><button data-close-panel style=\"background:none;border:none;font-size:18px;cursor:pointer;color:#666;\">×</button></div><div style=\"padding:16px;\"><p style=\"margin:0 0 12px;color:#666;font-size:12px;\">Click a field to copy, then paste into the form.</p><div data-fields></div><button data-copy-all style=\"margin-top:12px;width:100%;padding:10px;background:#4f46e5;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:500;\">Copy All Fields</button><p style=\"margin:8px 0 0;color:#999;font-size:11px;text-align:center;\">Data stored locally. Nothing leaves your browser.</p></div>";

    const fieldsContainer = panel.querySelector("[data-fields]");
    const seen = new Set();
    for (const form of profile.forms) {
      for (const field of form.fields) {
        if (seen.has(field.label)) continue;
        seen.add(field.label);
        const row = document.createElement("div");
        row.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6;cursor:pointer;";
        row.innerHTML = "<span style=\"color:#374151;font-weight:500;\">" + field.label + "</span><span style=\"color:#6b7280;font-size:13px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;\">" + field.value + "</span>";
        row.addEventListener("click", function () {
          navigator.clipboard.writeText(field.value).then(() => {
            row.style.background = "#dcfce7";
            setTimeout(() => (row.style.background = ""), 600);
          });
        });
        fieldsContainer.appendChild(row);
      }
    }

    panel.querySelector("[data-close-panel]").addEventListener("click", () => panel.remove());
    panel.querySelector("[data-copy-all]").addEventListener("click", function () {
      const text = generateClipboardSummary(profile);
      navigator.clipboard.writeText(text).then(() => {
        this.textContent = "Copied!";
        this.style.background = "#16a34a";
        setTimeout(() => {
          this.textContent = "Copy All Fields";
          this.style.background = "#4f46e5";
        }, 1200);
      });
    });

    document.body.appendChild(panel);
  }

  // --- Auto-fill for no-login forms ---

  function autoFillForm() {
    const profile = loadProfile();
    if (!profile) return;

    const forms = detectForms();
    let filled = 0;
    const seen = new Set();

    for (const form of forms) {
      for (const field of form.fields) {
        for (const savedForm of profile.forms) {
          for (const savedField of savedForm.fields) {
            if (seen.has(field.selector)) continue;
            const labelMatch = field.label.toLowerCase().replace(/[^a-z]/g, "") === savedField.label.toLowerCase().replace(/[^a-z]/g, "");
            if (labelMatch && !field.element.value.trim()) {
              field.element.value = savedField.value;
              field.element.dispatchEvent(new Event("input", { bubbles: true }));
              field.element.style.outline = "2px solid #22c55e";
              field.element.style.outlineOffset = "2px";
              seen.add(field.selector);
              filled++;
            }
          }
        }
      }
    }
    if (filled > 0) console.log("[Super Autofill] Filled " + filled + " fields");
  }

  // --- Init ---

  const profile = loadProfile();
  if (!profile) return;

  const url = window.location.href.toLowerCase();
  const isHousingConnect = url.includes("housingconnect.nyc.gov");

  if (isHousingConnect) {
    // Housing Connect: show clipboard panel on application pages
    if (url.includes("apply") || url.includes("details") || url.includes("lottery")) {
      // Wait for form to load
      const observer = new MutationObserver((mutations, obs) => {
        const forms = detectForms();
        if (forms.length > 0) {
          obs.disconnect();
          setTimeout(() => showClipboardPanel(profile), 500);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      // Fallback: show after 3 seconds anyway
      setTimeout(() => showClipboardPanel(profile), 3000);
    }
  } else {
    // No-login form: auto-fill directly
    if (document.readyState === "complete") {
      autoFillForm();
    } else {
      window.addEventListener("load", autoFillForm);
    }
  }
})();
