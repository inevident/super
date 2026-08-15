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
    incomeBands?: { extremelyLow: number; veryLow: number; low: number; moderate: number };
  };
  reason: string;
  openViolations?: number;
  worstFloor?: number | null;
};

const BRIEFS = [
  "2 bedroom in Brooklyn under $2,500",
  "Studio in Manhattan, cheapest I can get",
  "Affordable housing in the Bronx, big building",
];

export default function Housing() {
  const [brief, setBrief] = useState("");
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);

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

      <div className="search">
        <div className="field">
          <input
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && brief.trim() && search(brief)}
            placeholder="e.g. 2 bedroom in Brooklyn under $2,500"
            aria-label="What you're looking for"
          />
          <button className="go" onClick={() => brief.trim() && search(brief)} disabled={busy || !brief.trim()}>
            {busy ? "Searching…" : "Find housing"}
          </button>
        </div>
      </div>

      <div className="presets">
        <span className="lbl">Try</span>
        {BRIEFS.map((b) => (
          <button
            key={b}
            className="chip"
            onClick={() => {
              setBrief(b);
              search(b);
            }}
          >
            {b}
          </button>
        ))}
      </div>

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
            <div className="listing" key={r.listing.id}>
              <div className="l-head">
                <span className="l-name">{r.listing.name || r.listing.address}</span>
                <span className="l-rent">
                  {r.listing.rent ? `$${r.listing.rent.toLocaleString()}/mo` : "rent not published"}
                </span>
              </div>
              <div className="l-meta">
                {[r.listing.address, r.listing.borough, r.listing.unitSize, r.listing.ami ? `${r.listing.ami}% AMI` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              <div className="why">{r.reason}</div>
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
