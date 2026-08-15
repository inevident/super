"use client";

import { useEffect, useRef, useState } from "react";
import Massing from "./components/Massing";
import CityMap from "./components/CityMap";
import type { Address, AgentStep, BuildingProfile, Pick, ScanEvent } from "@/lib/types";

type TraceItem =
  | { kind: "stage"; text: string }
  | { kind: "step"; step: AgentStep };

// All three return rich records — verify before demoing.
const PRESETS = [
  "33 West 89 Street, Manhattan",
  "930 Prospect Place, Brooklyn",
  "2265 Olinville Avenue, Bronx",
];

type Phase = "idle" | "scanning" | "done" | "error";

// Five diamonds: the core contracts as the satellites grow and draw inward.
// CSS `alternate` plays it 1-2-3-2-1 on a loop.
function Thinking({ label }: { label: string }) {
  return (
    <div className="thinking-wrap">
      <div className="thinking" role="img" aria-label="Working">
        <i className="core" />
        <i className="n" />
        <i className="s" />
        <i className="w" />
        <i className="e" />
      </div>
      <div className="thinking-label">{label}</div>
    </div>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [trace, setTrace] = useState<TraceItem[]>([]);
  const [address, setAddress] = useState<Address | null>(null);
  const [profile, setProfile] = useState<BuildingProfile | null>(null);
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [error, setError] = useState("");
  const [showCity, setShowCity] = useState(false);

  const abort = useRef<AbortController | null>(null);

  // Address autocomplete, debounced.
  useEffect(() => {
    if (phase !== "idle" || query.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`);
        const d = await r.json();
        setSuggestions(d.suggestions ?? []);
      } catch {
        setSuggestions([]);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [query, phase]);

  async function scan(addressText: string, demo = false) {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;

    setPhase("scanning");
    setShowSuggest(false);
    setTrace([]);
    setAddress(null);
    setProfile(null);
    setPicks(null);
    setError("");

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: addressText, demo }),
        signal: ctrl.signal,
      });
      if (!res.body) throw new Error("no stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          apply(JSON.parse(line.slice(5).trim()) as ScanEvent);
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(e?.message ?? "Scan failed");
      setPhase("error");
    }
  }

  function apply(e: ScanEvent) {
    switch (e.stage) {
      case "resolving":
      case "records":
      case "thinking":
      case "shopping":
        setTrace((t) => [...t, { kind: "stage", text: e.message }]);
        break;
      case "step":
        setTrace((t) => [...t, { kind: "step", step: e.step }]);
        break;
      case "address":
        setAddress(e.address);
        break;
      case "profile":
        setProfile(e.profile);
        break;
      case "picks":
        setPicks(e.picks);
        break;
      case "done":
        setPhase("done");
        break;
      case "error":
        setError(e.message);
        setPhase("error");
        break;
    }
  }

  const total =
    picks?.reduce((sum, p) => sum + (p.product?.price ?? 0), 0) ?? 0;
  const busy = phase === "scanning";

  // Name what the agent is doing right now, not a generic spinner caption.
  const last = trace[trace.length - 1];
  const phaseLabel = !last
    ? "Starting"
    : last.kind === "stage"
      ? last.text.replace(/…$/, "")
      : last.step.type === "tool"
        ? `Calling ${last.step.name}`
        : last.step.type === "thought"
          ? "Reasoning"
          : "Reading results";

  return (
    <main className="shell">
      <header className="top">
        <div className="wordmark">Super</div>
        <h1 className="tagline">Know what you signed up for.</h1>
        <p className="sub">
          Type your new NYC address. Super reads the building&apos;s real violation
          record and carts what you&apos;re actually going to need.
        </p>
      </header>

      <div className="search">
        <div className="field">
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowSuggest(true);
            }}
            onFocus={() => setShowSuggest(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && query.trim()) scan(query);
              if (e.key === "Escape") setShowSuggest(false);
            }}
            placeholder="e.g. 33 West 89 Street, Manhattan"
            aria-label="NYC address"
            spellCheck={false}
          />
          <button
            className="go"
            onClick={() => query.trim() && scan(query)}
            disabled={busy || !query.trim()}
          >
            {busy ? "Scanning…" : "Scan building"}
          </button>
        </div>

        {showSuggest && suggestions.length > 0 && phase === "idle" && (
          <div className="suggest">
            {suggestions.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setQuery(s);
                  setSuggestions([]);
                  scan(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="presets">
        <span className="lbl">Try</span>
        {PRESETS.map((p) => (
          <button
            key={p}
            className="chip"
            onClick={() => {
              setQuery(p);
              scan(p);
            }}
          >
            {p.split(",")[0]}
          </button>
        ))}
        <button className="chip" onClick={() => scan(PRESETS[0], true)}>
          offline demo
        </button>
        <button
          className="chip"
          onClick={() => setShowCity((v) => !v)}
          aria-pressed={showCity}
        >
          {showCity ? "hide city map" : "city heat map"}
        </button>
      </div>

      {showCity && <CityMap />}

      {busy && <Thinking label={phaseLabel} />}

      {trace.length > 0 && (
        <div className="log">
          {trace.map((item, i) => {
            const active = i === trace.length - 1 && busy;
            if (item.kind === "stage") {
              return (
                <div key={i} className={`line${active ? " active" : ""}`}>
                  <span className="tick">{active ? "▸" : "✓"}</span>
                  <span>{item.text}</span>
                </div>
              );
            }
            const s = item.step;
            if (s.type === "thought") {
              return (
                <div key={i} className="line think">
                  <span className="tick">◆</span>
                  <span>{s.text}</span>
                </div>
              );
            }
            if (s.type === "tool") {
              return (
                <div key={i} className="line tool">
                  <span className="tick">⟳</span>
                  <span>
                    <b>{s.name}</b>({s.input})
                  </span>
                </div>
              );
            }
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

      {profile && address && (
        <section className="dossier">
          <div className="dossier-head">
            <div className="addr">{address.label}</div>
            <div className="meta">
              BBL {address.bbl} · {address.borough} · {address.zip}
            </div>
          </div>

          {profile.facts && (
            <dl className="facts">
              <div>
                <dt>Built</dt>
                <dd>{profile.facts.yearBuilt}</dd>
              </div>
              <div>
                <dt>Floors</dt>
                <dd>
                  {profile.facts.floors}
                  {profile.facts.walkUp ? " · walk-up" : ""}
                </dd>
              </div>
              <div>
                <dt>Units</dt>
                <dd>{profile.facts.residentialUnits}</dd>
              </div>
              <div>
                <dt>Sq ft / unit</dt>
                <dd>{profile.facts.sqftPerUnit.toLocaleString()}</dd>
              </div>
            </dl>
          )}

          {profile.footprint && (
            <div className="massing-row">
              <Massing
                footprint={profile.footprint}
                floorCount={profile.facts?.floors ?? 1}
                breakdown={profile.floors}
              />
              {Object.keys(profile.floors.counts).length > 0 && (
              <div className="floors">
                <div className="floors-title">Open violations by floor</div>
                {Object.entries(profile.floors.counts)
                  .map(([f, n]) => [Number(f), n] as const)
                  .sort((a, b) => b[0] - a[0])
                  .map(([f, n]) => {
                    const max = Math.max(...Object.values(profile.floors.counts));
                    return (
                      <div
                        className={`floor-row${f === profile.floors.worstFloor ? " worst" : ""}`}
                        key={f}
                      >
                        <span className="fl">{f}</span>
                        <span className="bar">
                          <i style={{ width: `${Math.max(3, (n / max) * 100)}%` }} />
                        </span>
                        <span className="fn">{n}</span>
                      </div>
                    );
                  })}
                {profile.floors.worstUnit && profile.floors.worstUnit.count > 5 && (
                  <div className="worst-unit">
                    Apartment <b>{profile.floors.worstUnit.apt}</b> alone accounts for{" "}
                    <b>{profile.floors.worstUnit.count.toLocaleString()}</b> of them.
                  </div>
                )}
              </div>
              )}
            </div>
          )}

          {profile.complaints && profile.complaints.top.length > 0 && (
            <div className="complaints">
              <div className="floors-title">
                What tenants reported · {profile.complaints.total.toLocaleString()} filed
                {profile.complaints.span ? ` · ${profile.complaints.span}` : ""}
              </div>
              {profile.complaints.top.slice(0, 5).map((c) => {
                const max = profile.complaints!.top[0].count;
                return (
                  <div className="floor-row" key={c.category}>
                    <span className="cat">{c.category.toLowerCase()}</span>
                    <span className="bar">
                      <i style={{ width: `${Math.max(3, (c.count / max) * 100)}%` }} />
                    </span>
                    <span className="fn">{c.count.toLocaleString()}</span>
                  </div>
                );
              })}
              <div className="gap-note">
                Complaints are what tenants reported. The {profile.openViolations.toLocaleString()}{" "}
                above are what inspectors confirmed.
              </div>
            </div>
          )}

          <div className="headline">
            <div className="n">
              {profile.openViolations.toLocaleString()}
              {profile.truncated ? "+" : ""}
            </div>
            <div className="cap">
              open violations on record, out of{" "}
              {profile.totalViolations.toLocaleString()}
              {profile.truncated ? "+" : ""} filed
            </div>
          </div>

          <div className="signals">
            {profile.signals.slice(0, 5).map((s) => (
              <div className="signal" key={s.kind}>
                <div className="count">{s.count}</div>
                <div className="body">
                  <div className="kind">
                    {s.kind} {s.window && <span style={{ color: "var(--text-3)", fontWeight: 400 }}>· {s.window}</span>}
                  </div>
                  <div className="quote">&ldquo;{s.sample}&rdquo;</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {picks && picks.length > 0 && (
        <section className="cart">
          <div className="cart-title">What you&apos;ll need</div>

          {picks.map(({ need, product }) => (
            <div
              className={`item${product ? "" : " missing"}`}
              key={need.label}
            >
              {product?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="thumb" src={product.image} alt="" />
              ) : (
                <div className="thumb" />
              )}
              <div className="info">
                <div className="label">{need.label}</div>
                <div className="name">{product?.title ?? "No match found"}</div>
                <div className="why">{need.reason}</div>
                {product && <div className="merch">{product.merchant}</div>}
              </div>
              <div className="price">
                {product ? `$${product.price.toFixed(2)}` : "—"}
              </div>
            </div>
          ))}

          <div className="total">
            <span className="t-label">Total</span>
            <span className="t-amount">${total.toFixed(2)}</span>
          </div>

          {picks.find((p) => p.product) && (
            <>
              <a
                className="checkout"
                href={picks.find((p) => p.product)!.product!.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open checkout →
              </a>
              <p className="disclaimer">
                Real products from real Shopify merchants. Opens a live checkout —
                items ship from separate stores, so they check out per merchant.
              </p>
            </>
          )}
        </section>
      )}

      <footer className="credit">
        Built for The New York City Hackathon · August 15, 2026 · Ryan Lim
      </footer>
    </main>
  );
}
