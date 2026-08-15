"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { loadProfile, saveProfile, type RenterProfile, type FieldMapping } from "@/lib/autofill/profile";
import { buildPanelData, formatApplicationSummary, validateFields, type PanelState, type ApplicationRecord } from "@/lib/autofill/panel";

export default function AutofillPanel() {
  const [profile, setProfile] = useState<RenterProfile | null>(null);
  const [state, setState] = useState<PanelState>("collapsed");
  const [fields, setFields] = useState<FieldMapping[]>([]);
  const [fillProgress, setFillProgress] = useState(0);
  const [filledFields, setFilledFields] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [captchaPending, setCaptchaPending] = useState(false);
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = loadProfile();
    if (p) {
      setProfile(p);
      setFields(p.forms.flatMap((f) => f.fields));
      setApplications((p as any).applications || []);
    }
  }, []);

  // Collapse to pill on scroll, expand on click
  const toggleExpand = useCallback(() => {
    setState((s) => (s === "collapsed" ? "expanded" : "collapsed"));
  }, []);

  // Fill all fields (simulated for web app context)
  const handleFill = useCallback(() => {
    if (!profile) return;
    setState("filling");
    setFillProgress(0);
    setFilledFields([]);

    const allFields = profile.forms.flatMap((f) => f.fields);
    let i = 0;
    const interval = setInterval(() => {
      if (i >= allFields.length) {
        clearInterval(interval);
        setState("review");
        setFillProgress(100);
        return;
      }
      setFilledFields((prev) => [...prev, allFields[i].label]);
      setFillProgress(Math.round(((i + 1) / allFields.length) * 100));
      i++;
    }, 200);
  }, [profile]);

  // Copy all fields to clipboard
  const handleCopyAll = useCallback(() => {
    if (!profile) return;
    const text = formatApplicationSummary(profile.forms.flatMap((f) => f.fields));
    navigator.clipboard.writeText(text);
  }, [profile]);

  // Submit application (simulated)
  const handleSubmit = useCallback(() => {
    if (!profile) return;
    setState("success");
    const record: ApplicationRecord = {
      lotteryId: "lottery-" + Date.now(),
      lotteryName: "Housing Connect Lottery",
      submittedAt: new Date().toISOString(),
      confirmationId: "HC-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
      status: "submitted",
      formData: Object.fromEntries(fields.map((f) => [f.label, f.value])),
    };
    const apps = [...applications, record];
    setApplications(apps);
    (profile as any).applications = apps;
    saveProfile(profile);
  }, [profile, fields, applications]);

  // Drag handling
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    setIsDragging(true);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPosX: position.x, startPosY: position.y };

    const handleDragMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      setPosition({ x: dragRef.current.startPosX + dx, y: dragRef.current.startPosY + dy });
    };

    const handleDragEnd = () => {
      setIsDragging(false);
      dragRef.current = null;
      document.removeEventListener("mousemove", handleDragMove);
      document.removeEventListener("mouseup", handleDragEnd);
    };

    document.addEventListener("mousemove", handleDragMove);
    document.addEventListener("mouseup", handleDragEnd);
  }, [position]);

  // Close panel
  const handleClose = useCallback(() => {
    setState("collapsed");
  }, []);

  if (!profile) return null;

  const validation = validateFields(fields);

  // Collapsed state — small pill
  if (state === "collapsed") {
    return (
      <div
        ref={panelRef}
        className="autofill-panel collapsed"
        onClick={toggleExpand}
        role="button"
        tabIndex={0}
        aria-label="Super Autofill — click to expand"
      >
        <span className="autofill-icon">🏠</span>
        <span className="autofill-pill-text">Super Autofill — {fields.length} fields ready</span>
        <span className="autofill-expand-icon">▲</span>
      </div>
    );
  }

  // Expanded state — full panel
  return (
    <div
      ref={panelRef}
      className={`autofill-panel expanded ${isDragging ? "dragging" : ""}`}
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      role="dialog"
      aria-label="Super Autofill Panel"
      aria-live="polite"
    >
      {/* Header — drag handle */}
      <div className="autofill-header" onMouseDown={handleDragStart}>
        <span className="autofill-icon">🏠</span>
        <strong>Super Autofill</strong>
        <div className="autofill-header-actions">
          <button onClick={toggleExpand} aria-label="Collapse panel" title="Collapse">─</button>
          <button onClick={handleClose} aria-label="Close panel" title="Close">×</button>
        </div>
      </div>

      {/* Progress bar (during fill) */}
      {state === "filling" && (
        <div className="autofill-progress">
          <div className="autofill-progress-bar" style={{ width: `${fillProgress}%` }} />
          <span className="autofill-progress-text">Filling... {fillProgress}%</span>
        </div>
      )}

      {/* CAPTCHA alert */}
      {captchaPending && (
        <div className="autofill-captcha-alert" role="alert">
          ⚠️ Please solve the CAPTCHA, then click Resume
          <button onClick={() => setCaptchaPending(false)}>Resume</button>
        </div>
      )}

      {/* Error state */}
      {state === "error" && error && (
        <div className="autofill-error" role="alert">
          ❌ {error}
          <button onClick={() => { setState("expanded"); setError(null); }}>Retry</button>
        </div>
      )}

      {/* Success state */}
      {state === "success" && (
        <div className="autofill-success" role="status">
          ✅ Application submitted!
          <button onClick={() => setState("expanded")}>Done</button>
        </div>
      )}

      {/* Field list */}
      {(state === "expanded" || state === "review" || state === "filling") && (
        <div className="autofill-fields">
          {fields.map((field) => {
            const isFilled = filledFields.includes(field.label);
            return (
              <div key={field.label} className={`autofill-field ${isFilled ? "filled" : ""}`}>
                <span className="autofill-field-label">{field.label}</span>
                <span className="autofill-field-value">{field.value}</span>
                {(state === "filling" || state === "review") && (
                  <span className="autofill-field-status">{isFilled ? "✓" : "•"}</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Actions */}
      <div className="autofill-actions">
        <button onClick={handleCopyAll} className="autofill-btn copy-btn" title="Copy all fields to clipboard">
          Copy All
        </button>
        <button onClick={handleFill} className="autofill-btn fill-btn" disabled={state === "filling"} title="Fill form with your profile">
          {state === "filling" ? "Filling..." : "Fill Form"}
        </button>
        {state === "review" && (
          <button onClick={handleSubmit} className="autofill-btn submit-btn" title="Confirm and submit application">
            Confirm & Submit
          </button>
        )}
      </div>

      {/* Application history */}
      {applications.length > 0 && (
        <details className="autofill-history">
          <summary>📋 {applications.length} application{applications.length === 1 ? "" : "s"} submitted</summary>
          <ul>
            {applications.map((app) => (
              <li key={app.lotteryId}>
                <span>{new Date(app.submittedAt).toLocaleDateString()}</span>
                <strong>{app.confirmationId || "Pending"}</strong>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Missing fields warning */}
      {!validation.valid && (
        <div className="autofill-warning" role="alert">
          Missing: {validation.missing.join(", ")}
        </div>
      )}

      {/* Privacy note */}
      <p className="autofill-privacy-note">
        🔒 Stored locally. Nothing leaves your browser.
      </p>
    </div>
  );
}
