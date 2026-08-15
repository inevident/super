"use client";

import { useState, useEffect, useCallback } from "react";
import {
  loadProfile,
  saveProfile,
  deleteProfile,
  profileExists,
  type RenterProfile,
} from "@/lib/agent/profile";

type ProfileForm = {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  emailAddress: string;
  address: string;
  aptNumber: string;
  city: string;
  state: string;
  zipCode: string;
  householdSize: string;
  annualIncome: string;
};

const EMPTY_FORM: ProfileForm = {
  firstName: "",
  lastName: "",
  phoneNumber: "",
  emailAddress: "",
  address: "",
  aptNumber: "",
  city: "",
  state: "NY",
  zipCode: "",
  householdSize: "2",
  annualIncome: "75000",
};

function profileToForm(profile: RenterProfile): ProfileForm {
  const fieldMap: Record<string, string> = {};
  for (const form of profile.forms) {
    for (const field of form.fields) {
      const key = field.label.toLowerCase().replace(/[^a-z]/g, "");
      fieldMap[key] = field.value;
    }
  }
  return {
    firstName: fieldMap.firstname || "",
    lastName: fieldMap.lastname || "",
    phoneNumber: fieldMap.phonenumber || "",
    emailAddress: fieldMap.emailaddress || "",
    address: fieldMap.address || "",
    aptNumber: fieldMap.apt || fieldMap.apartment || "",
    city: fieldMap.city || "",
    state: fieldMap.state || "NY",
    zipCode: fieldMap.zipcode || fieldMap.zip || "",
    householdSize: fieldMap.householdsize || fieldMap.household || "2",
    annualIncome: fieldMap.income || fieldMap.annualincome || "75000",
  };
}

type ProfileManagerProps = {
  onProfileLoaded?: (profile: RenterProfile) => void;
  onProfileDeleted?: () => void;
  briefAutoFill?: (householdSize: string, income: string) => void;
};

export default function ProfileManager({
  onProfileLoaded,
  onProfileDeleted,
  briefAutoFill,
}: ProfileManagerProps) {
  const [profile, setProfile] = useState<RenterProfile | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<"profile" | "forms">("profile");

  useEffect(() => {
    const existing = loadProfile();
    if (existing) {
      setProfile(existing);
      setForm(profileToForm(existing));
      onProfileLoaded?.(existing);
    }
  }, [onProfileLoaded]);

  const handleSave = useCallback(() => {
    const now = new Date().toISOString();
    const updated: RenterProfile = profile
      ? { ...profile, metadata: { ...profile.metadata, updatedAt: now } }
      : {
          version: 1,
          forms: [],
          metadata: { createdAt: now, updatedAt: now, lastReplayAt: null, lastReplayAccessType: null },
        };

    // Store as a generic "profile" form entry
    const fields = [
      { selector: "#profile-firstName", label: "First Name", fieldType: "text" as const, value: form.firstName, sensitive: false, required: true, source: "user_typed" as const },
      { selector: "#profile-lastName", label: "Last Name", fieldType: "text" as const, value: form.lastName, sensitive: false, required: true, source: "user_typed" as const },
      { selector: "#profile-phoneNumber", label: "Phone Number", fieldType: "tel" as const, value: form.phoneNumber, sensitive: false, required: true, source: "user_typed" as const },
      { selector: "#profile-emailAddress", label: "Email Address", fieldType: "email" as const, value: form.emailAddress, sensitive: false, required: true, source: "user_typed" as const },
      { selector: "#profile-address", label: "Address", fieldType: "text" as const, value: form.address, sensitive: false, required: true, source: "user_typed" as const },
      { selector: "#profile-aptNumber", label: "Apt #", fieldType: "text" as const, value: form.aptNumber, sensitive: false, required: false, source: "user_typed" as const },
      { selector: "#profile-city", label: "City", fieldType: "text" as const, value: form.city, sensitive: false, required: true, source: "user_typed" as const },
      { selector: "#profile-state", label: "State", fieldType: "text" as const, value: form.state, sensitive: false, required: true, source: "user_typed" as const },
      { selector: "#profile-zipCode", label: "Zip Code", fieldType: "text" as const, value: form.zipCode, sensitive: false, required: true, source: "user_typed" as const },
      { selector: "#profile-householdSize", label: "Household Size", fieldType: "number" as const, value: form.householdSize, sensitive: false, required: true, source: "user_typed" as const },
      { selector: "#profile-annualIncome", label: "Annual Income", fieldType: "number" as const, value: form.annualIncome, sensitive: true, required: true, source: "user_typed" as const },
    ];

    updated.forms = [
      {
        urlPattern: "super:profile",
        accessType: "no-login",
        fields,
        learnedAt: now,
        formVersion: (profile?.forms.find((f) => f.urlPattern === "super:profile")?.formVersion || 0) + 1,
      },
      ...(profile?.forms.filter((f) => f.urlPattern !== "super:profile") || []),
    ];

    saveProfile(updated);
    setProfile(updated);
    setIsEditing(false);
    setSaved(true);
    briefAutoFill?.(form.householdSize, form.annualIncome);
    setTimeout(() => setSaved(false), 2000);
  }, [form, profile, briefAutoFill]);

  const handleDelete = useCallback(() => {
    deleteProfile();
    setProfile(null);
    setForm(EMPTY_FORM);
    setIsEditing(false);
    setShowDeleteConfirm(false);
    onProfileDeleted?.();
  }, [onProfileDeleted]);

  const handleEdit = useCallback(() => {
    if (profile) {
      setForm(profileToForm(profile));
    }
    setIsEditing(true);
  }, [profile]);

  // No profile — show setup card
  if (!profile) {
    return (
      <section className="profile-setup-card" aria-label="Autofill profile setup">
        <div className="profile-setup-header">
          <h3>Set up autofill</h3>
          <p>Enter your info once. Super remembers it for every application.</p>
        </div>
        <ProfileFormFields form={form} setForm={setForm} />
        <div className="profile-setup-actions">
          <button type="button" className="profile-save-btn" onClick={handleSave}>
            Save profile
          </button>
        </div>
        <p className="profile-privacy-note">
          Stored locally on your device. Nothing is sent to any server.
        </p>
      </section>
    );
  }

  // Has profile — show summary or edit form
  return (
    <section className="profile-manager" aria-label="Autofill profile">
      {isEditing ? (
        <>
          <div className="profile-edit-header">
            <h3>Edit profile</h3>
            <button type="button" className="profile-cancel-btn" onClick={() => setIsEditing(false)}>
              Cancel
            </button>
          </div>
          <ProfileFormFields form={form} setForm={setForm} />
          <div className="profile-edit-actions">
            <button type="button" className="profile-save-btn" onClick={handleSave}>
              {saved ? "Saved!" : "Save changes"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="profile-summary-header">
            <div>
              <h3>Autofill profile</h3>
              <span className="profile-status-badge">
                <span className="status-dot" /> Active
              </span>
            </div>
            <div className="profile-header-actions">
              <button type="button" className="profile-edit-btn" onClick={handleEdit}>
                Edit
              </button>
              <button
                type="button"
                className="profile-delete-btn"
                onClick={() => setShowDeleteConfirm(true)}
              >
                Delete
              </button>
            </div>
          </div>
          <div className="profile-summary-grid">
            <SummaryItem label="Name" value={`${form.firstName} ${form.lastName}`} />
            <SummaryItem label="Phone" value={form.phoneNumber} />
            <SummaryItem label="Email" value={form.emailAddress} />
            <SummaryItem label="Address" value={`${form.address}${form.aptNumber ? ` #${form.aptNumber}` : ""}`} />
            <SummaryItem label="Location" value={`${form.city}, ${form.state} ${form.zipCode}`} />
            <SummaryItem label="Household" value={`${form.householdSize} people`} />
            <SummaryItem label="Income" value={`$${Number(form.annualIncome).toLocaleString()}/yr`} />
          </div>
          <p className="profile-updated">
            Last updated: {new Date(profile.metadata.updatedAt).toLocaleDateString()}
          </p>
        </>
      )}

      {showDeleteConfirm && (
        <div className="profile-delete-modal">
          <div className="profile-delete-content">
            <h4>Delete all autofill data?</h4>
            <p>This permanently removes your stored profile from this device.</p>
            <div className="profile-delete-actions">
              <button type="button" className="profile-cancel-btn" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="profile-confirm-delete-btn" onClick={handleDelete}>
                Delete everything
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ProfileFormFields({
  form,
  setForm,
}: {
  form: ProfileForm;
  setForm: React.Dispatch<React.SetStateAction<ProfileForm>>;
}) {
  const update = (key: keyof ProfileForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [key]: e.target.value }));
  };

  return (
    <div className="profile-form-grid">
      <label>
        <span>First Name *</span>
        <input id="profile-firstName" value={form.firstName} onChange={update("firstName")} required />
      </label>
      <label>
        <span>Last Name *</span>
        <input id="profile-lastName" value={form.lastName} onChange={update("lastName")} required />
      </label>
      <label>
        <span>Phone Number *</span>
        <input id="profile-phoneNumber" type="tel" value={form.phoneNumber} onChange={update("phoneNumber")} required />
      </label>
      <label>
        <span>Email Address *</span>
        <input id="profile-emailAddress" type="email" value={form.emailAddress} onChange={update("emailAddress")} required />
      </label>
      <label className="full-width">
        <span>Address *</span>
        <input id="profile-address" value={form.address} onChange={update("address")} required />
      </label>
      <label>
        <span>Apt #</span>
        <input id="profile-aptNumber" value={form.aptNumber} onChange={update("aptNumber")} />
      </label>
      <label>
        <span>City *</span>
        <input id="profile-city" value={form.city} onChange={update("city")} required />
      </label>
      <label>
        <span>State *</span>
        <input id="profile-state" value={form.state} onChange={update("state")} required />
      </label>
      <label>
        <span>Zip Code *</span>
        <input id="profile-zipCode" value={form.zipCode} onChange={update("zipCode")} required />
      </label>
      <label>
        <span>Household Size *</span>
        <input id="profile-householdSize" type="number" min="1" max="20" value={form.householdSize} onChange={update("householdSize")} required />
      </label>
      <label>
        <span>Annual Income *</span>
        <input id="profile-annualIncome" type="number" min="0" value={form.annualIncome} onChange={update("annualIncome")} required />
      </label>
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="summary-item">
      <span>{label}</span>
      <strong>{value || "—"}</strong>
    </div>
  );
}
