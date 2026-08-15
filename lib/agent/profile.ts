// Profile Storage Module
// Builds and manages the local database of user information across sessions.

const STORAGE_KEY = "super:renter-profile-v1";

export type FormAccessType = "no-login" | "login-required";

export type FieldMapping = {
  selector: string;
  label: string;
  fieldType: "text" | "email" | "tel" | "number" | "select" | "radio" | "checkbox";
  value: string;
  sensitive: boolean;
  required: boolean;
  source: "user_typed" | "agent_inferred" | "profile_default";
};

export type LearnedForm = {
  urlPattern: string;
  accessType: FormAccessType;
  fields: FieldMapping[];
  learnedAt: string;
  formVersion: number;
};

export type RenterProfile = {
  version: number;
  forms: LearnedForm[];
  metadata: {
    createdAt: string;
    updatedAt: string;
    lastReplayAt: string | null;
    lastReplayAccessType: FormAccessType | null;
  };
};

// --- Profile CRUD ---

export function createEmptyProfile(): RenterProfile {
  const now = new Date().toISOString();
  return {
    version: 1,
    forms: [],
    metadata: {
      createdAt: now,
      updatedAt: now,
      lastReplayAt: null,
      lastReplayAccessType: null,
    },
  };
}

export function saveProfile(profile: RenterProfile): void {
  profile.metadata.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

export function loadProfile(): RenterProfile | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RenterProfile;
    // Basic validation
    if (!parsed.version || !Array.isArray(parsed.forms)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function deleteProfile(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function profileExists(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

// --- Encryption (AES-GCM via Web Crypto API) ---

const ENCRYPTION_PREFIX = "enc:";

function getKeyMaterial(passphrase: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
}

async function deriveKey(keyMaterial: CryptoKey, salt: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptSensitive(value: string, passphrase: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await getKeyMaterial(passphrase);
  const key = await deriveKey(keyMaterial, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(value)
  );
  const combined = new Uint8Array(salt.length + iv.length + new Uint8Array(ciphertext).length);
  combined.set(salt, 0);
  combined.set(iv, salt.length);
  combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
  return ENCRYPTION_PREFIX + btoa(String.fromCharCode(...combined));
}

export async function decryptSensitive(encrypted: string, passphrase: string): Promise<string> {
  if (!encrypted.startsWith(ENCRYPTION_PREFIX)) return encrypted;
  const decoder = new TextDecoder();
  const data = encrypted.slice(ENCRYPTION_PREFIX.length);
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const ciphertext = bytes.slice(28);
  const keyMaterial = await getKeyMaterial(passphrase);
  const key = await deriveKey(keyMaterial, salt);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return decoder.decode(plaintext);
}

// --- Export / Import ---

export function exportProfile(profile: RenterProfile): string {
  return JSON.stringify(profile, null, 2);
}

export function importProfile(json: string): RenterProfile | null {
  try {
    const parsed = JSON.parse(json) as RenterProfile;
    if (!parsed.version || !Array.isArray(parsed.forms)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// --- Form helpers ---

export function addFormToProfile(profile: RenterProfile, form: LearnedForm): RenterProfile {
  const existing = profile.forms.findIndex((f) => f.urlPattern === form.urlPattern);
  if (existing >= 0) {
    profile.forms[existing] = { ...form, formVersion: profile.forms[existing].formVersion + 1 };
  } else {
    profile.forms.push(form);
  }
  return profile;
}

export function getFormByUrlPattern(profile: RenterProfile, urlPattern: string): LearnedForm | undefined {
  return profile.forms.find((f) => f.urlPattern === urlPattern);
}
