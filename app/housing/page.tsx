"use client";

import { useRef, useState } from "react";
import type { AgentStep } from "@/lib/types";

type TraceItem = { kind: "stage"; text: string } | { kind: "step"; step: AgentStep };

type Result = {
  listing: {
    id: string;
    name: string;
    address: string;
    borough: string;
    rent?: number;
    unitSize?: string;
    units?: number;
    ami?: number;
    source: string;
    url?: string;
    imageUrl?: string;
    imageUrls?: string[];
    description?: string;
    applicationUrl?: string;
    rentRange?: string;
    minIncome?: number;
    maxIncome?: number;
    incomeBands?: { extremelyLow: number; veryLow: number; low: number; moderate: number };
  };
  reason: string;
  openViolations?: number;
  worstFloor?: number | null;
};

export default function Housing() {
  const [brief, setBrief] = useState("");
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [income, setIncome] = useState("");
  const [householdSize, setHouseholdSize] = useState(1);
  const [boroughs, setBoroughs] = useState<string[]>([]);
  const [priority, setPriority] = useState("best overall match");
  const [mustHaves, setMustHaves] = useState<string[]>([]);
  const [gallery, setGallery] = useState<Record<string, number>>({});
  const abort = useRef<AbortController | null>(null);

  const ami100 = [0, 118800, 135700, 152700, 169600, 183200, 196800, 210400, 223900];
  const annualIncome = Number(income.replace(/[^0-9.]/g, "")) || 0;
  const householdAmi = annualIncome ? Math.round((annualIncome / ami100[householdSize]) * 100) : null;

  function runGuidedSearch() {
    const parts = [`Household income $${annualIncome} for ${householdSize} ${householdSize === 1 ? "person" : "people"}`, `boroughs: ${boroughs.join(" or ")}`, `priority: ${priority}`];
    if (mustHaves.length) parts.push(`must haves: ${mustHaves.join(", ")}`);
    if (brief.trim()) parts.push(`additional preferences: ${brief.trim()}`);
    search(parts.join("; "));
  }

  async function search(text: string) {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setTrace([]);
    setResults(null);
    setError("");

    try {
      const res = await fetch("/api/housing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief: text }),
        signal: ctrl.signal,
      });
      if (!res.body) throw new Error("no stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const f of frames) {
          const line = f.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const e = JSON.parse(line.slice(5).trim());
          if (e.stage === "searching") setTrace((t) => [...t, { kind: "stage", text: e.message }]);
          else if (e.stage === "step") setTrace((t) => [...t, { kind: "step", step: e.step }]);
          else if (e.stage === "results") setResults(e.results);
          else if (e.stage === "done") setBusy(false);
          else if (e.stage === "error") {
            setError(e.message);
            setBusy(false);
          }
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(e?.message ?? "Search failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="top">
        <div className="wordmark">Super · Housing</div>
        <h1 className="tagline">Find a place. Know the building.</h1>
        <p className="sub">
          Every listing checked against the city&apos;s real violation record before
          it&apos;s recommended. <a href="/">Back to building scan →</a>
        </p>
      </header>

      <section className="guided-search">
      <div className="search-step"><span className="step-number">1</span><div><h2>Start with your household</h2><p>We use this to estimate AMI and show realistic matches.</p></div></div>
      <div className="eligibility">
        <label>
          Annual household income
          <input
            inputMode="numeric"
            value={income}
            onChange={(e) => setIncome(e.target.value)}
            placeholder="e.g. 65000"
            aria-label="Annual household income"
          />
        </label>
        <label>
          Household size
          <select value={householdSize} onChange={(e) => setHouseholdSize(Number(e.target.value))}>
            {Array.from({ length: 8 }, (_, i) => i + 1).map((size) => (
              <option key={size} value={size}>{size} {size === 1 ? "person" : "people"}</option>
            ))}
          </select>
        </label>
        <div className="ami-result">
          {householdAmi ? <><b>{householdAmi}% AMI</b><span>2026 NYC estimate</span></> : <span>Add income to see your 2026 AMI</span>}
        </div>
      </div>
      <div className="search-step"><span className="step-number">2</span><div><h2>Choose boroughs</h2><p>Pick one or several places to include in your search.</p></div></div>
      <div className="borough-picker">{["Manhattan","Brooklyn","Bronx","Queens","Staten Island"].map((name) => <button type="button" aria-pressed={boroughs.includes(name)} className={boroughs.includes(name) ? "selected" : ""} key={name} onClick={() => setBoroughs((current) => current.includes(name) ? current.filter((value) => value !== name) : [...current, name])}><b>{name}</b></button>)}</div>
      <div className="search-step"><span className="step-number">3</span><div><h2>Set priorities</h2><p>These are optional and help rank the matches.</p></div></div>
      <div className="preferences-grid"><label>Most important<select value={priority} onChange={(event) => setPriority(event.target.value)}><option>best overall match</option><option>cheapest possible</option><option>fewest building violations</option><option>most available units</option><option>closest to subway</option></select></label><label>Further specify<input value={brief} onChange={(event) => setBrief(event.target.value)} onKeyDown={(event) => event.key === "Enter" && annualIncome && boroughs.length && runGuidedSearch()} placeholder="Optional: studio, wheelchair access, neighborhood…" /></label></div>
      <div className="must-haves"><span>Must haves</span>{["laundry","elevator","pet friendly","near subway","clean violation record"].map((item) => <label key={item}><input type="checkbox" checked={mustHaves.includes(item)} onChange={() => setMustHaves((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])} />{item}</label>)}</div>
      <button className="go guided-submit" onClick={runGuidedSearch} disabled={busy || !annualIncome || !boroughs.length}>{busy ? "Searching…" : "Find housing"}</button>
      {!annualIncome || !boroughs.length ? <p className="guided-hint">Add household income and choose at least one borough to begin.</p> : null}
      </section>

      {trace.length > 0 && (
        <div className="log">
          {trace.map((item, i) => {
            const active = i === trace.length - 1 && busy;
            if (item.kind === "stage")
              return (
                <div key={i} className={`line${active ? " active" : ""}`}>
                  <span className="tick">{active ? "▸" : "✓"}</span>
                  <span>{item.text}</span>
                </div>
              );
            const s = item.step;
            if (s.type === "thought")
              return (
                <div key={i} className="line think">
                  <span className="tick">◆</span>
                  <span>{s.text}</span>
                </div>
              );
            if (s.type === "tool")
              return (
                <div key={i} className="line tool">
                  <span className="tick">⟳</span>
                  <span>
                    <b>{s.name}</b>({s.input})
                  </span>
                </div>
              );
            return (
              <div key={i} className="line ret">
                <span className="tick">↳</span>
                <span>{s.summary}</span>
              </div>
            );
          })}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {results && results.length > 0 && (
        <section className="cart">
          <div className="cart-title">{results.length} places worth looking at</div>
          {results.map((r) => (
            <div className={`listing${r.listing.imageUrl || r.listing.imageUrls?.length ? " with-image" : ""}`} key={r.listing.id}>
              {(() => {
                const images = r.listing.imageUrls?.length ? r.listing.imageUrls : r.listing.imageUrl ? [r.listing.imageUrl] : [];
                const index = Math.min(gallery[r.listing.id] ?? 0, Math.max(0, images.length - 1));
                if (!images.length) return null;
                return (
                  <div className="listing-gallery">
                    <div className={`gallery-stage${images.length > 1 ? " has-thumbs" : ""}`}>
                      <a href={`/housing/${encodeURIComponent(r.listing.id)}`} aria-label={`View ${r.listing.name || r.listing.address}`}>
                        <img className="listing-image" src={images[index]} alt={`${r.listing.name || r.listing.address} · photo ${index + 1}`} />
                      </a>
                      {images.length > 1 ? <div className="gallery-thumbs">{images.slice(0, 3).map((src, thumbIndex) => <button className={thumbIndex === index ? "active" : ""} key={src} onClick={() => setGallery((g) => ({ ...g, [r.listing.id]: thumbIndex }))} aria-label={`Show photo ${thumbIndex + 1}`}><img src={src} alt="" /></button>)}</div> : null}
                    </div>
                    {images.length > 1 ? (
                      <>
                        <button className="gallery-arrow prev" aria-label="Previous image" onClick={() => setGallery((g) => ({ ...g, [r.listing.id]: (index - 1 + images.length) % images.length }))}>‹</button>
                        <button className="gallery-arrow next" aria-label="Next image" onClick={() => setGallery((g) => ({ ...g, [r.listing.id]: (index + 1) % images.length }))}>›</button>
                        <span className="gallery-count">{index + 1}/{images.length}</span>
                      </>
                    ) : null}
                  </div>
                );
              })()}
              <div className="listing-body">
              <div className="l-head">
                <a className="l-name listing-detail-link" href={`/housing/${encodeURIComponent(r.listing.id)}`}>{r.listing.name || r.listing.address}</a>
                <span className="l-rent">
                  {r.listing.rentRange || (r.listing.rent ? `$${r.listing.rent.toLocaleString()}/mo` : "rent not published")}
                </span>
              </div>
              <div className="l-meta">
                {[r.listing.address, r.listing.borough, r.listing.unitSize, r.listing.ami ? `${r.listing.ami}% AMI` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              <div className="why">{r.reason}</div>
              {r.listing.description ? <p className="l-description">{r.listing.description}</p> : null}
              {annualIncome && (r.listing.minIncome || r.listing.maxIncome) ? (
                <div className={`income-match ${annualIncome >= (r.listing.minIncome ?? 0) && annualIncome <= (r.listing.maxIncome ?? Infinity) ? "match" : "miss"}`}>
                  {annualIncome >= (r.listing.minIncome ?? 0) && annualIncome <= (r.listing.maxIncome ?? Infinity)
                    ? "Income is within the published range"
                    : "Income is outside the published range"}
                </div>
              ) : householdAmi ? <div className="income-match">Your household is about {householdAmi}% AMI · verify the exact band in the application</div> : null}
              <div className="l-foot">
                {typeof r.openViolations === "number" ? (
                  <span className={r.openViolations > 100 ? "vio bad" : "vio ok"}>
                    {r.openViolations.toLocaleString()} open violations
                    {r.worstFloor ? ` · worst floor ${r.worstFloor}` : ""}
                  </span>
                ) : (
                  <span className="vio">building record not checked</span>
                )}
                {r.listing.units ? <span className="l-units">{r.listing.units} units</span> : null}
                {(r.listing.applicationUrl || r.listing.url) ? (
                  <a className="apply-link" href={r.listing.applicationUrl || r.listing.url} target="_blank" rel="noreferrer">
                    View application →
                  </a>
                ) : null}
              </div>
              </div>
            </div>
          ))}
        </section>
      )}

      <footer className="credit">
        Built for The New York City Hackathon · August 15, 2026 · Ryan Lim
      </footer>
    </main>
  );
}
