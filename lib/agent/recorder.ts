// Form Recorder
// Capture user inputs field-by-field as they fill a form.

import { buildSelector, classifyField, classifyAccessType, findFieldLabel, type DetectedForm } from "./detect";
import { saveProfile, addFormToProfile, loadProfile, type FieldMapping, type LearnedForm } from "./profile";

export type RecordingState = {
  isActive: boolean;
  fields: Map<string, FieldMapping>;
  accessType: "no-login" | "login-required";
  urlPattern: string;
};

let state: RecordingState | null = null;
let blurListeners: WeakMap<Element, () => void> = new WeakMap();

// Start recording a form
export function attachRecorder(form: DetectedForm): void {
  state = {
    isActive: true,
    fields: new Map(),
    accessType: form.accessType,
    urlPattern: window.location.href,
  };

  for (const field of form.fields) {
    const onBlur = () => {
      if (!state?.isActive) return;
      const element = field.element;
      const value = element.value;
      if (!value.trim()) return;

      const mapping: FieldMapping = {
        selector: field.selector,
        label: field.label,
        fieldType: field.fieldType,
        value,
        sensitive: /income|ssn|social/i.test(field.label),
        required: field.required,
        source: "user_typed",
      };
      state.fields.set(field.selector, mapping);
    };

    field.element.addEventListener("blur", onBlur);
    blurListeners.set(field.element, onBlur);
  }
}

// Stop recording and return the captured fields
export function stopRecording(): FieldMapping[] | null {
  if (!state) return null;
  state.isActive = false;
  return Array.from(state.fields.values());
}

// Save the current recording to profile
export function saveRecording(): boolean {
  if (!state || state.fields.size === 0) return false;

  const profile = loadProfile() || {
    version: 1,
    forms: [],
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastReplayAt: null,
      lastReplayAccessType: null,
    },
  };

  const form: LearnedForm = {
    urlPattern: state.urlPattern,
    accessType: state.accessType,
    fields: Array.from(state.fields.values()),
    learnedAt: new Date().toISOString(),
    formVersion: 1,
  };

  addFormToProfile(profile, form);
  saveProfile(profile);
  return true;
}

// Check if currently recording
export function isRecording(): boolean {
  return state?.isActive ?? false;
}

// Get current recording state (for UI display)
export function getRecordingState(): RecordingState | null {
  return state;
}

// Validate recording before saving
export function validateRecording(): { valid: boolean; errors: string[] } {
  if (!state || state.fields.size === 0) {
    return { valid: false, errors: ["No fields recorded"] };
  }

  const errors: string[] = [];
  const fields = Array.from(state.fields.values());

  const requiredFields = fields.filter((f) => f.required);
  const missingRequired = requiredFields.filter((f) => !f.value.trim());
  if (missingRequired.length > 0) {
    errors.push(`Missing required fields: ${missingRequired.map((f) => f.label).join(", ")}`);
  }

  const emailFields = fields.filter((f) => f.fieldType === "email");
  for (const email of emailFields) {
    if (email.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
      errors.push(`Invalid email format for ${email.label}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// Detach all listeners (cleanup)
export function detachRecorder(form: DetectedForm): void {
  for (const field of form.fields) {
    const listener = blurListeners.get(field.element);
    if (listener) {
      field.element.removeEventListener("blur", listener);
      blurListeners.delete(field.element);
    }
  }
  state = null;
}
