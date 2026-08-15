# Autofill Info 2.0 — Browser Automation Plan

> **Status:** Ideation / Draft
> **Author:** hongchengw
> **Created:** 2026-08-15
> **Branch:** `hongchengw/autofill-info`
> **Depends on:** AUTOFILL_PLAN.md (local profile + clipboard panel)

---

## Overview

**Current limitation:** Autofill 1.0 saves the user's profile and shows a clipboard panel — the user still has to paste each field manually into Housing Connect's form. It reduces errors but not effort.

**Goal for 2.0:** Use browser automation (Selenium / Playwright / Puppeteer) to fill out Housing Connect applications *automatically* — from the user's saved profile straight to the submit button. The user reviews and clicks submit; the agent does everything else.

**Who it's for:** The same active affordable housing applicants, now with near-zero-effort applications.

---

## The Problem with External Form Automation

Housing Connect is not an API. It is a stateful web application with:

| Challenge | What it means for automation |
|-----------|------------------------------|
| **Login wall** | The agent must either log in as the user (credentials) or operate in an already-logged-in session |
| **Session management** | Cookies, CSRF tokens, session timeouts |
| **Dynamic forms** | Fields appear/disappear based on previous answers |
| **CAPTCHA** | May appear at any point — cannot be auto-solved reliably |
| **File uploads** | Income verification documents must be attached |
| **Anti-bot measures** | Rate limiting, fingerprinting, honeypot fields |
| **Terms of Use** | Automated form filling may violate Housing Connect's ToS |
| **Legal risk** | Submitting applications on behalf of users has liability implications |

We need a plan that is **technically feasible**, **legally safe**, and **respectful of the user's control**.

---

## Recommended Toolchain

| Tool | Role | Why |
|------|------|-----|
| **Playwright** (primary) | Browser automation engine | Faster than Selenium, better API, cross-browser, auto-waits, built-in recording |
| **Selenium** (fallback) | Alternative for complex enterprise environments | Mature, widely supported, works with browser extensions |
| **Chrome Profile Persistence** | Reuse logged-in sessions | No need to re-login or handle credentials |
| **Human-in-the-loop (HITL)** | CAPTCHA solving, final review | User stays in control for edge cases |

**Recommendation:** Start with **Playwright + Chrome profile persistence**. Selenium is a fallback for environments where Playwright is blocked.

---

## How It Works — The Automated Application Loop

### Phase 1: Setup (One-time)

1. User installs the Super browser extension (or userscript with Playwright integration)
2. User logs into Housing Connect manually in the browser
3. The agent detects the active Housing Connect session and saves a reference to the browser profile path
4. User sets up their profile in Super (same as v1.0 — name, phone, email, address, household, income)
5. User optionally uploads documents (income verification) to a local folder for the agent to attach

### Phase 2: Apply (Per lottery)

1. User finds a lottery in Super and clicks "Apply with Super"
2. The agent launches a Playwright-controlled browser with the user's Chrome profile
3. Navigates to the Housing Connect application URL for that lottery
4. Waits for the form to load (handles dynamic rendering)
5. Auto-fills all 11 fields from the saved profile
6. Handles conditional fields (e.g., "add household member") by prompting the user via overlay
7. Attaches documents from the local folder if required
8. If CAPTCHA appears — pauses and alerts the user to solve it manually
9. Shows a review overlay: "Here's what I filled. Submit?"
10. User clicks "Submit" (or the agent submits after explicit confirmation)

### Phase 3: Post-submit

1. Agent captures the confirmation page / application ID
2. Saves the submission record to the user's local profile
3. Returns control to Super with a success/failure status

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Super Web App                                                      │
│                                                                     │
│  User clicks "Apply with Super"                                     │
│       │                                                             │
│       ▼                                                             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Playwright Agent (runs locally on user's machine)            │   │
│  │                                                              │   │
│  │  1. Load profile from localStorage                           │   │
│  │  2. Launch Chromium with user's Chrome profile               │   │
│  │  3. Navigate to Housing Connect application URL              │   │
│  │  4. Detect form fields (id, name, aria-label)                │   │
│  │  5. Fill fields from profile                                 │   │
│  │  6. Handle conditional fields → prompt user                  │   │
│  │  7. Attach documents if needed                               │   │
│  │  8. CAPTCHA? → pause, alert user, wait for solve             │   │
│  │  9. Show review overlay → user confirms                      │   │
│  │  10. Submit (or let user click submit)                       │   │
│  │  11. Capture confirmation → save to profile                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│       │                                                             │
│       ▼                                                             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  User's Browser (Chromium with persisted profile)            │   │
│  │                                                              │   │
│  │  - Already logged in to Housing Connect                      │   │
│  │  - Agent drives this browser via Playwright CDP connection   │   │
│  │  - User can see everything happening in real-time            │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Making Web Browser Access Easier for the Agent

### 1. Chrome Profile Persistence (Critical)

**Problem:** Logging into Housing Connect requires credentials and possibly 2FA. Asking users to give their password to the agent is a security risk.

**Solution:** Reuse the user's existing Chrome profile. Playwright can launch with `channel: "chrome"` and `userDataDir` pointing to the user's actual Chrome profile. This way:

- No credential handling — the user is already logged in
- No 2FA needed — the session is already established
- Cookies, localStorage, and sessions are all preserved

```typescript
const browser = await chromium.launchPersistentContext(
  "/Users/<user>/Library/Application Support/Google/Chrome", // macOS
  // "C:\\Users\\<user>\\AppData\\Local\\Google\\Chrome\\User Data", // Windows
  {
    channel: "chrome",
    headless: false, // User watches the automation
    viewport: { width: 1280, height: 800 },
  }
);
```

### 2. Browser Extension Bridge

**Problem:** Super is a web app; Playwright runs locally. How do they communicate?

**Solution:** A lightweight browser extension that:

- Detects when the user is on Housing Connect
- Provides a "Let Super fill this" button directly on the page
- Stores the `userDataDir` path preference
- Can read the current page URL and pass it to the local agent

### 3. Visual Field Mapping UI

**Problem:** Form fields change between lotteries. The agent may not know which field is which.

**Solution:** A visual mapping tool:

- Agent scans the form and shows a screenshot with numbered fields overlaid
- User clicks a field and maps it to a profile value
- Mappings are saved per-URL pattern for future use
- Falls back to label matching when no mapping exists

### 4. Smart Waiting & Retry Logic

**Problem:** Housing Connect forms load dynamically. The agent may try to fill a field before it exists.

**Solution:**

```typescript
// Auto-wait for element with timeout + retry
await page.waitForSelector('input[name="firstName"]', {
  state: "visible",
  timeout: 10_000,
});

// Retry on failure with exponential backoff
async function fillWithRetry(selector: string, value: string, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await page.fill(selector, value);
      return;
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await page.waitForTimeout(1000 * (i + 1));
    }
  }
}
```

### 5. Human-in-the-Loop for Edge Cases

**Problem:** CAPTCHAs, unexpected modals, form validation errors, new field types.

**Solution:** The agent never acts autonomously on edge cases. Instead:

- Pauses automation
- Highlights the issue on screen
- Shows a prompt: "Please solve the CAPTCHA, then click Resume"
- Waits for user input before continuing

### 6. Application History & Dedup

**Problem:** User might accidentally apply twice to the same lottery.

**Solution:** The agent tracks all applications submitted:

```typescript
type ApplicationRecord = {
  lotteryId: string;
  lotteryName: string;
  submittedAt: string;
  confirmationId: string | null;
  status: "submitted" | "confirmed" | "error";
  formData: Record<string, string>; // snapshot of what was filled
};
```

Before applying, the agent checks: "You already applied to this lottery on <date>. Apply again?"

### 7. Undo & Audit Trail

**Problem:** What if the agent fills something wrong?

**Solution:** Before submitting, the agent shows a diff:

```
Field          | Stored Value        | Form Value
----------------------------------------------------
First Name     | Jane                | Jane
Last Name      | Doe                 | Doe
Income         | $75,000             | $75,000
Address        | 123 Main St         | 123 Main St
```

User can edit any field before confirming.

---

## Suggestions to Make Browser Access Easier

| Suggestion | Benefit |
|------------|---------|
| **Reuse Chrome profile** | No credential handling, no 2FA, sessions persist |
| **Run browser in headed mode** | User watches, can intervene, builds trust |
| **Record & replay** | Record the first application manually → agent replays on future ones |
| **Per-URL field mappings** | Each lottery may have slightly different form layouts → save mappings per URL |
| **Document folder watcher** | User drops PDFs into a local folder → agent attaches them automatically |
| **Application queue** | User queues 10 lotteries → agent fills them one by one (user reviews each) |
| **Dry-run mode** | Agent fills everything but doesn't submit → user reviews offline |
| **Form field OCR fallback** | If selectors fail, use OCR to find labels and map to fields |
| **Accessibility tree parsing** | Use ARIA labels and role attributes for more reliable field detection |
| **Network request interception** | Capture the actual form submission payload → understand the API structure for future direct submission |

---

## Implementation Paths

### Path A: Playwright + Chrome Profile (Recommended)

**Pros:** Modern API, auto-waits, cross-browser, good TypeScript support, can reuse Chrome profile
**Cons:** Requires Playwright install, ~200MB browser binaries

### Path B: Selenium + ChromeDriver

**Pros:** Mature, widely documented, works with existing browser extensions
**Cons:** Slower, more verbose API, ChromeDriver version management

### Path C: Puppeteer + Remote Debugging Protocol

**Pros:** Lightweight, direct CDP access, can attach to existing Chrome instance
**Cons:** Chromium-only (no Chrome profile reuse without CDP attach)

### Path D: Browser Extension Only (No External Tool)

**Pros:** Runs entirely in the browser, no install needed
**Cons:** Limited to the page the user is on, can't persist across sessions easily, no document handling

**Recommendation:** **Path A** for MVP. Fall back to Path B if Playwright is blocked.

---

## Legal & Ethical Considerations

| Concern | Mitigation |
|---------|------------|
| **Housing Connect ToS** | Review ToS before building. If automated submission is prohibited, limit agent to "fill only, user submits" mode |
| **Liability** | Agent never submits without explicit user confirmation. Always show a review step |
| **Data security** | Profile stays local. No credential storage. No server transmission |
| **Fairness** | Agent gives equal access to all users. Don't create an unfair advantage |
| **Transparency** | User can see every field the agent fills. No hidden actions |

---

## Open Questions

1. Does Housing Connect's ToS prohibit automated form filling or submission?
2. Should the agent auto-submit, or only fill and let the user click submit?
3. How to handle CAPTCHAs — pause and alert, or integrate a solving service (ethical concerns)?
4. Should the agent work only on Housing Connect, or be a general-purpose form filler for any housing site?
5. How to handle document uploads — pre-scan and store locally, or prompt user each time?
6. Should applications be queued for batch processing?
7. How to verify submission was successful — parse confirmation page, check email, poll dashboard?
8. What if the user's Chrome profile session expires — how to re-authenticate safely?

---

## Task Breakdown

### Task 1: Research & Feasibility
- [ ] Review Housing Connect's Terms of Use for automation clauses
- [ ] Test Playwright with Chrome profile persistence on Housing Connect
- [ ] Test Selenium with Chrome profile persistence on Housing Connect
- [ ] Identify anti-bot measures (CAPTCHA type, rate limits, honeypots)
- [ ] Document form submission API (intercept network requests during manual submit)

### Task 2: Playwright Agent Core
- [ ] Install Playwright and set up Chromium
- [ ] Implement `launchWithProfile(userDataDir)` — reuse Chrome sessions
- [ ] Implement `navigateToApplication(url)` — open Housing Connect lottery
- [ ] Implement `detectFormFields()` — scan and map form elements
- [ ] Implement `fillField(selector, value)` — fill with retry + auto-wait
- [ ] Implement `fillAllFields(profile)` — fill entire form from profile

### Task 3: Conditional Field Handling
- [ ] Detect conditional fields (shown/hidden based on other answers)
- [ ] Implement `handleConditionalFields()` — prompt user for decisions
- [ ] Save conditional decisions per URL pattern for future use

### Task 4: Document Attachment
- [ ] Implement `attachDocument(filePath)` — upload income verification
- [ ] Set up local document folder watcher
- [ ] Map document types to form upload fields

### Task 5: Human-in-the-Loop System
- [ ] Implement CAPTCHA detection → pause + alert user
- [ ] Implement review overlay before submission
- [ ] Implement "Submit" confirmation button (user clicks)
- [ ] Implement undo/edit on review overlay

### Task 6: Application History
- [ ] Save submitted applications to local profile
- [ ] Check for duplicate applications before submitting
- [ ] Show application history in Super UI

### Task 7: Super Web App Integration
- [ ] Add "Apply with Super" button to listing detail
- [ ] Build browser extension bridge (if needed)
- [ ] Add application queue UI
- [ ] Add application history view

### Task 8: Error Handling & Edge Cases
- [ ] Handle session expiry → prompt user to re-login
- [ ] Handle form layout changes → re-map fields
- [ ] Handle network errors → retry with backoff
- [ ] Handle validation errors → highlight fields, show messages

### Task 9: Testing & QA
- [ ] Test on Housing Connect (dry-run mode — don't submit)
- [ ] Test with different lottery types (rental, sales, senior)
- [ ] Test document upload flow
- [ ] Test CAPTCHA handling
- [ ] Test duplicate detection

### Task 10: Documentation
- [ ] Document setup (Playwright install, Chrome profile path)
- [ ] Document legal/ToS considerations
- [ ] Add in-app explanations of what the agent does
- [ ] Create video demo of the full flow

---

## References

- Playwright docs: https://playwright.dev/docs/api/class-playwright
- Chrome profile paths:
  - macOS: `~/Library/Application Support/Google/Chrome`
  - Windows: `%LOCALAPPDATA%\Google\Chrome\User Data`
  - Linux: `~/.config/google-chrome`
- AUTOFILL_PLAN.md — v1.0 local profile + clipboard panel
- `lib/autofill/` — existing profile storage module
- `app/components/ProfileManager.tsx` — existing profile UI
