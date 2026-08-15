# Autofill Info — Feature Plan

> **Status:** Ideation / Draft
> **Author:** hongchengw
> **Created:** 2026-08-15
> **Branch:** `hongchengw/autofill-info`

---

## Overview

**Problem:** New Yorkers applying to affordable housing lotteries through NYC Housing Connect must fill out the same lengthy personal information form every single time — name, phone, email, address, household size, income. Repetitive, error-prone, and tedious when applying to multiple lotteries. Housing Connect's application form requires login, so the agent can't directly auto-fill it.

**Solution:** A form-filling agent that builds a local database of the user's information by recording inputs from forms accessible without login. For no-login forms, the agent auto-fills directly. For login-required forms (like Housing Connect), the agent provides clipboard-ready data and field-mapping intelligence so the user never re-types the same information twice.

**Who it's for:** Active affordable housing applicants who apply to multiple lotteries and want to eliminate repetitive data entry — even when some forms require login.

---

## Housing Connect Form Fields

Based on the actual application form, the fields the agent must learn and replay are:

| # | Field | Type | Required | Sensitive | Notes |
|---|-------|------|----------|-----------|-------|
| 1 | First Name | text | yes | no | |
| 2 | Last Name | text | yes | no | |
| 3 | Phone Number | tel | yes | no | |
| 4 | Email Address | email | yes | no | |
| 5 | Address | text | yes | no | Street address |
| 6 | Apt # | text | no | no | Optional apartment/unit number |
| 7 | City | text | yes | no | |
| 8 | State | select/text | yes | no | Always "NY" for NYC lotteries |
| 9 | Zip Code | text | yes | no | 5-digit ZIP |
| 10 | Household Size | number | yes | no | Number of people in household |
| 11 | Income | number | yes | yes | Annual household income |

**Not on the form (do NOT collect):**
- SSN / last-4 (not required at initial application stage)
- Date of Birth (not required at initial application stage)

---

## How It Works — The Agent Loop

### Key Constraint: Login Required

Housing Connect's application form requires users to log in before they can apply. This means the agent **cannot directly manipulate the DOM** of the actual application form. Instead, the agent works in two modes:

- **No-login forms** (e.g., landlord screening applications, building waitlist sign-ups, other housing portals): Agent auto-fills directly via DOM manipulation
- **Login-required forms** (e.g., Housing Connect): Agent provides clipboard-ready data and field-mapping intelligence

### Phase 1: Learn (Build local database)

1. User encounters a form — could be a no-login form or a login-required form
2. The agent detects the form and identifies its fields
3. User fills the form manually while the agent observes:
   - Records which HTML fields are present
   - Records what value the user enters in each field
   - Records field selectors (id, name, aria-label, or CSS path)
   - Tags the form as "no-login" or "login-required"
4. User clicks "Save my info for next time"
5. The field-value map is stored locally — building a reusable database of the user's information

### Phase 2: Replay (Agent fills or assists)

**For no-login forms:**
1. User navigates to another no-login form
2. Agent detects the form and auto-fills every matching field
3. Highlights what was filled — user reviews and corrects
4. User submits with one click

**For login-required forms:**
1. User logs in and reaches the application form
2. Agent detects the login-required form
3. Shows a side panel with clipboard-ready field values mapped to the form's labels
4. User clicks each field → agent copies the value → user pastes
5. OR: User copies the entire formatted summary at once and fills manually

### Phase 3: Maintain (Update on change)

- If the user's income or household changes, they update the profile
- The agent re-learns any new field types it encounters on new forms
- If a form layout changes, the agent flags "needs re-learning"
- Local database persists across sessions — no re-learning needed for known forms

---

## Goals

- [ ] Record a user's form inputs field-by-field on any form page (no-login and login-required)
- [ ] Store a reusable profile locally (encrypted, user-controlled)
- [ ] Auto-detect and auto-fill no-login forms on subsequent visits
- [ ] Provide clipboard-ready data for login-required forms (e.g., Housing Connect)
- [ ] Support user review-and-correct before submission
- [ ] Handle form layout changes gracefully with re-learning prompts
- [ ] Keep sensitive data (Income) local-only with clear privacy controls
- [ ] Make the agent work as a lightweight browser-side mechanism (no backend)

---

## Non-Goals

- Auto-submitting applications — the user always reviews before submitting
- Filling forms on *any* website — scoped to Housing Connect and similar housing portals for now
- Storing SSN or DOB — not required on the actual form
- Server-side profile storage — local-only for privacy
- Circumventing login walls or anti-bot measures
- Auto-filling forms behind login walls — agent provides data, user pastes manually

---

## User Stories

| As a... | I want... | So that... |
|---------|-----------|------------|
| First-time applicant | To fill out the form once while Super watches | I never have to type the same info again |
| Active applicant | Super to auto-fill the next application I open | I apply in seconds, not minutes |
| Privacy-conscious user | All my data stored locally, never uploaded | I'm not trusting a third party with my info |
| Careful applicant | To see what the agent filled before I submit | I can catch errors or outdated info |
| Someone whose income changed | To update one field and have it propagate | I don't hunt through old entries to fix them |
| Someone applying after a form redesign | The agent to ask me to re-learn the new layout | I'm not stuck with stale selectors |

---

## Proposed Approach

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Housing Connect application page (external site)         │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  User fills form once                                │ │
│  │       │                                              │ │
│  │       ▼                                              │ │
│  │  Agent records: field selectors + values + types     │ │
│  │       │                                              │ │
│  │       ▼                                              │ │
│  │  Encrypted profile stored in localStorage            │ │
│  └─────────────────────────────────────────────────────┘ │
│                          │                                │
│                          ▼ (next application)             │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Agent detects form → matches fields → fills values  │ │
│  │       │                                              │ │
│  │       ▼                                              │ │
│  │  User reviews → corrects → submits                   │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Implementation Paths

| Approach | Pros | Cons | Viable? |
|----------|------|------|---------|
| **A. Browser extension** | Full DOM access on Housing Connect; can observe inputs and replay values reliably | Requires install; separate build; Chrome Web Store review | Yes — most robust |
| **B. Userscript (Tampermonkey)** | No install friction; works if user has a userscript manager | Requires Tampermonkey; less discoverable; fragile | Yes — lightweight MVP |
| **C. Iframe embedding** | No extension needed | Housing Connect almost certainly has X-Frame-Options/Deny — won't work | No |
| **D. Server-side proxy** | Full control | Illegal without Housing Connect consent;ToS violation; insane liability | No |
| **E. Bookmarklet** | Zero install; just drag to bookmarks bar | Limited persistence; harder to store state; clunky UX | Maybe — fallback MVP |

**Recommended path:** Start with **B (Userscript)** for a quick MVP to validate the approach, then graduate to **A (Browser extension)** for production quality.

### Data Model

```ts
type FormAccessType = "no-login" | "login-required";

type FieldMapping = {
  selector: string;        // CSS selector or xpath to the field
  label: string;           // Human-readable label (e.g., "First Name")
  fieldType: "text" | "email" | "tel" | "number" | "select" | "radio" | "checkbox";
  value: string;           // Stored value for replay
  sensitive: boolean;      // true for Income — triggers encryption + warning
  required: boolean;       // true if field is required
  source: "user_typed" | "agent_inferred" | "profile_default";
};

type LearnedForm = {
  urlPattern: string;      // e.g., "housingconnect.nyc.gov/PublicWeb/apply/*"
  accessType: FormAccessType;
  fields: FieldMapping[];
  learnedAt: string;
  formVersion: number;     // bump when layout changes
};

type RenterProfile = {
  version: 1;
  forms: LearnedForm[];
  metadata: {
    createdAt: string;
    updatedAt: string;
    lastReplayAt: string | null;
    lastReplayAccessType: FormAccessType | null;
  };
};
```

### Agent Behavior

**Recording mode:**
- Attach `input`, `change`, and `blur` listeners to form fields on any page
- On blur, capture `{ selector, value, fieldType, label, required }`
- Tag the form as "no-login" or "login-required" based on whether user had to log in to reach it
- Map captured fields to the 11 known field types (or add new ones if discovered)
- Deduplicate by selector
- On save, encrypt sensitive fields (Income) with a user-provided passphrase
- Store as `LearnedForm` in localStorage — building a reusable database

**Replay mode — no-login forms:**
- On page load, scan DOM for elements matching stored selectors
- Fill matching fields with stored values
- Highlight filled fields (green border + checkmark)
- Log unmatched fields (new fields on redesigned forms) → prompt re-learning
- Do NOT auto-submit — user must click submit manually

**Replay mode — login-required forms:**
- Detect when user is on a login-required form
- Show a floating panel or sidebar with field labels mapped to stored values
- User clicks a field in the panel → value copies to clipboard → user pastes into the form
- OR: "Copy all" button generates a formatted summary for manual fill-in
- Do NOT attempt to bypass login or manipulate DOM behind the login wall

**Update mode:**
- User edits a stored value → updates all future replays
- User adds a new field → appended to profile
- User deletes a field → removed, won't be filled again
- Re-learning on a form updates the stored mapping for that specific form

### Edge Cases

| Edge case | Handling |
|-----------|----------|
| Housing Connect requires login | Agent detects login-required form → switches to clipboard/side-panel mode |
| Form layout varies between lotteries | Each form is stored separately; agent learns each one individually |
| Form has client-side validation (e.g., ZIP must be 5 digits) | Agent fills with stored value; validation runs normally |
| Income field requires full annual amount | Store with explicit consent; warn user; encrypt at rest |
| Form has conditional fields (e.g., "add household member") | Agent fills visible fields; prompts user for conditionally revealed fields |
| User applies from different device | Profile is local-only; re-learning required on new device (documented limitation) |
| Housing Connect adds CAPTCHA | Agent cannot bypass; user solves CAPTCHA, agent fills everything else |
| Form has file uploads (income verification) | Agent cannot upload files; skips with "please attach your document" prompt |
| User types in a field after auto-fill | Agent detects user override; uses the new value for this session |
| Multiple forms on same page | Agent targets the form matching the stored `urlPattern` |
| State field auto-set to NY | Agent detects pre-filled "NY" and skips or confirms |
| Apt # is optional and left blank | Agent stores empty string; replay leaves blank |
| Form requires login but user is not logged in | Agent shows "Log in first, then I'll help you fill" prompt |
| User wants to update just one field | Edit that field in the profile; all replays update immediately |

### Privacy & Security

- All data stored in `localStorage` — never leaves the browser
- Income field encrypted with AES-GCM using a user-provided passphrase (via Web Crypto API)
- No network requests from the agent — fully offline after page load
- Clear "Delete all data" button with confirmation
- Profile export/import as encrypted JSON backup (optional)
- For login-required forms: no data is entered by the agent; user manually pastes — zero risk of automated form submission

---

## Open Questions

1. Browser extension vs. userscript — which path do we commit to for MVP?
2. How does Housing Connect's actual form look? (field types, conditional sections, validation rules — need to inspect live form)
3. Should we attempt auto-fill on the actual form, or generate a clipboard-ready block that's more reliable?
4. If extension: Chrome-only or cross-browser (Firefox, Edge)?
5. Legal considerations — does Housing Connect's ToS prohibit automated form filling?
6. Should the agent work only when launched from Super's "Apply" button, or always when on Housing Connect?

---

## Task Breakdown

> Tasks are ordered by dependency. Each task should be its own commit.

### Task 1: Research & Form Inspection
**Goal:** Understand the exact structure of Housing Connect's application form and identify no-login alternatives.

- [ ] Navigate to a live Housing Connect lottery application page
- [ ] Document that login is required before reaching the form
- [ ] Identify exact field selectors (id, name, class, aria-label) for all 11 fields
- [ ] Document field types, validation rules, and conditional logic
- [ ] Note any anti-bot measures (CAPTCHA, rate limiting, honeypot fields)
- [ ] Identify no-login forms (waitlist sign-ups, landlord screenings) for direct auto-fill testing
- [ ] Save findings to `docs/form-research.md`

### Task 2: Profile Storage Module (`lib/agent/profile.ts`)
**Goal:** Build the local database layer that stores user information across sessions.

- [ ] Define `RenterProfile` type with `accessType` tracking ("no-login" | "login-required")
- [ ] Write `saveProfile(profile)` — persists to localStorage with versioning
- [ ] Write `loadProfile()` — retrieves and validates from localStorage
- [ ] Write `deleteProfile()` — clears all stored data
- [ ] Write `encryptSensitive(value, passphrase)` — AES-GCM encryption for Income
- [ ] Write `decryptSensitive(encrypted, passphrase)` — AES-GCM decryption
- [ ] Add `exportProfile()` / `importProfile()` — encrypted JSON backup/restore
- [ ] Add unit tests for save/load/delete/encrypt/decrypt roundtrip

### Task 3: Form Field Detection (`lib/agent/detect.ts`)
**Goal:** Generic form detection that works on any page with input fields.

- [ ] Write `detectForms(page)` — scan DOM for `<form>` elements and standalone inputs
- [ ] Write `classifyField(input)` — map input to one of 11 known field types
- [ ] Write `classifyAccessType(page)` — determine "no-login" vs "login-required"
- [ ] Handle field label detection (explicit `<label>`, `aria-label`, `placeholder`, nearby text)
- [ ] Return structured form descriptor with all fields and their types

### Task 4: Form Recorder (`lib/agent/recorder.ts`)
**Goal:** Capture user inputs field-by-field as they fill a form.

- [ ] Write `attachRecorder(form)` — attach `input`/`change`/`blur` listeners to all fields
- [ ] On blur, capture `{ selector, value, fieldType, label, required }`
- [ ] Deduplicate by selector (keep latest value)
- [ ] Tag the form with its `accessType`
- [ ] Build "Save Profile" UI overlay with confirmation and field preview
- [ ] Write `saveRecording(fields, accessType)` — store as `LearnedForm` in profile
- [ ] Validate before saving (required fields not empty, valid email format, etc.)

### Task 5: Form Replayer — No-Login Path (`lib/agent/replay.ts`)
**Goal:** Auto-fill no-login forms directly via DOM manipulation.

- [ ] Write `replayNoLogin(profile, page)` — scan DOM for stored selectors
- [ ] Fill matched fields with stored values
- [ ] Highlight auto-filled fields (green border + checkmark indicator)
- [ ] Skip already-filled fields (don't overwrite user input)
- [ ] Detect unmatched/new fields → prompt "re-learn this form?"
- [ ] Do NOT auto-submit — user must click submit manually
- [ ] Log replay actions for debugging

### Task 6: Form Replayer — Login-Required Path (`lib/agent/replay.ts`)
**Goal:** Assist with login-required forms via clipboard panel (no DOM manipulation).

- [ ] Write `replayLoginRequired(profile, page)` — detect login-required form
- [ ] Show floating panel/sidebar with field labels mapped to stored values
- [ ] Add per-field "Copy" button → copies value to clipboard
- [ ] Add "Copy all" button → generates formatted summary for manual fill-in
- [ ] Do NOT attempt to bypass login or manipulate DOM behind login wall
- [ ] Log panel interactions for debugging

### Task 7: Profile Manager UI (`components/ProfileManager.tsx`)
**Goal:** Let users set up, view, edit, and delete their stored profile.

- [ ] Build "Setup Profile" empty state card (shown when no profile exists)
- [ ] Build profile edit form (pre-filled with existing data)
- [ ] Build "View/Edit Profile" modal accessible from header gear icon
- [ ] Add "Delete All Data" button with confirmation dialog
- [ ] Add visual indicator showing profile is saved/active
- [ ] Show which forms have been learned (no-login vs login-required)
- [ ] Show last-updated timestamp

### Task 8: Apply Button Integration
**Goal:** Wire Super's "Apply" button to the autofill agent.

- [ ] Modify Super's "Apply" button to check for saved profile on click
- [ ] If profile exists: show "Auto-fill ready" badge on the button
- [ ] If no profile: show "Set up autofill" prompt after clicking Apply
- [ ] For Housing Connect: open with agent in clipboard mode
- [ ] For no-login forms: open with agent in auto-fill mode

### Task 9: Agent Shell (Userscript/Extension)
**Goal:** Package the agent to run on external pages (Housing Connect).

- [ ] Decide MVP path: Tampermonkey userscript vs Chrome extension
- [ ] If userscript: write `@match` headers, `@grant` permissions, script wrapper
- [ ] If extension: set up `manifest.json`, content script injection, background worker
- [ ] Ensure agent only activates on Housing Connect and similar housing domains
- [ ] Handle script injection timing (wait for form to render via MutationObserver)
- [ ] Add agent activation/deactivation toggle

### Task 10: Error Handling & Edge Cases
**Goal:** Handle real-world form variations and failures gracefully.

- [ ] Handle form redesign (unmatched selectors → re-learn prompt)
- [ ] Handle CAPTCHA (skip, alert user to solve manually)
- [ ] Handle file uploads (skip, alert user to attach documents)
- [ ] Handle conditional fields (only fill visible fields)
- [ ] Handle login-required forms (switch to clipboard mode automatically)
- [ ] Handle form variation between lotteries (store each form separately)
- [ ] Add user override detection (don't fight user input after auto-fill)
- [ ] Add "Log in first, then I'll help you fill" prompt for login-required forms

### Task 11: Testing & QA
**Goal:** Verify the full flow works end-to-end.

- [ ] Test learn flow: fill form → save → verify localStorage contents
- [ ] Test replay flow (no-login): navigate to form → verify auto-fill
- [ ] Test replay flow (login-required): navigate to form → verify clipboard panel
- [ ] Test edit flow: change income → replay → verify new value propagated
- [ ] Test delete flow: delete profile → verify clean slate
- [ ] Test edge case: form variation between lotteries
- [ ] Test edge case: applying from fresh browser (no profile)
- [ ] Test edge case: login-required form with no login → "log in first" prompt

### Task 12: Documentation
**Goal:** Document setup, usage, privacy, and limitations.

- [ ] Document setup instructions (install userscript/extension)
- [ ] Document privacy model (what's stored, where, how it's encrypted)
- [ ] Document limitations (local-only, no cross-device, no auto-submit)
- [ ] Document two modes: no-login (auto-fill) vs login-required (clipboard)
- [ ] Add in-app tooltips explaining what the agent does
- [ ] Update README with autofill feature section

---

## References

- Current "Apply" button target: `app/components/Marketplace.tsx:380`
- Current listing type: `lib/types.ts:212-241`
- Housing Connect application URL pattern: `housingconnect.nyc.gov/PublicWeb/details/{lotteryId}`
- Web Crypto API for encryption: `crypto.subtle.encrypt` / `crypto.subtle.decrypt`
- Tampermonkey script header format: `@match`, `@grant`, `@require`
