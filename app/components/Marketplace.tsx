"use client";

import Image from "next/image";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import CityMap, { type CityResultMarker } from "./CityMap";
import Massing from "./Massing";
import ProfileManager from "./ProfileManager";
import {
  loadProfile,
  profileExists,
  showClipboardPanel,
  generateClipboardSummary,
  type RenterProfile,
} from "@/lib/agent";
import type {
  MarketplaceEvent,
  MarketplaceListing,
  RenterBrief,
  SearchPlan,
  UnitOffer,
} from "@/lib/types";

type Phase = "idle" | "searching" | "done" | "error";
type Check = { key: string; label: string; state: "waiting" | "active" | "done" };

const EXAMPLES = [
  { brief: "2 bedroom in Brooklyn under $2,500, near a train", household: "3", income: "82000" },
  { brief: "Studio or 1 bedroom in Queens with laundry", household: "1", income: "59000" },
  { brief: "Affordable 1 bedroom in the Bronx, lowest rent first", household: "2", income: "72000" },
];

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string) {
  if (!value) return "Deadline unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function matchedOffers(listing: MarketplaceListing) {
  const matched = listing.offers.filter((offer) => listing.matchedOfferIds.includes(offer.id));
  return matched.length ? matched : listing.offers;
}

function rentLabel(listing: MarketplaceListing) {
  const rents = unique(
    matchedOffers(listing)
      .map((offer) => offer.rent)
      .filter((rent): rent is number => rent != null)
  ).sort((a, b) => a - b);
  if (!rents.length) return "Rent needs verification";
  return rents.length === 1
    ? `${formatMoney(rents[0])}/mo`
    : `${formatMoney(rents[0])}–${formatMoney(rents[rents.length - 1])}/mo`;
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function replaceListingQuery(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("listing", id);
  else url.searchParams.delete("listing");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function safeImageSource(source: string | undefined | null) {
  if (!source) return false;
  try {
    const host = new URL(source).hostname;
    return host === "a806-housingconnectapi.nyc.gov" || host === "cdn.shopify.com";
  } catch {
    return false;
  }
}

function Thinking({ label }: { label: string }) {
  return (
    <div className="market-thinking" aria-live="polite">
      <div className="thinking thinking-small" role="img" aria-label="Super is working">
        <i className="core" />
        <i className="n" />
        <i className="s" />
        <i className="w" />
        <i className="e" />
      </div>
      <span>{label}</span>
    </div>
  );
}

function RiskBadge({ listing }: { listing: MarketplaceListing }) {
  return (
    <span className={`risk-badge risk-${listing.risk.level.toLowerCase()}`}>
      {listing.risk.level === "Unavailable" ? "Record unavailable" : `${listing.risk.level} building risk`}
    </span>
  );
}

function ListingCard({
  listing,
  selected,
  onOpen,
  priority,
}: {
  listing: MarketplaceListing;
  selected: boolean;
  onOpen: () => void;
  priority?: boolean;
}) {
  const offers = matchedOffers(listing);
  const bedrooms = unique(offers.map((offer) => offer.label)).slice(0, 3).join(" · ");
  const availableUnits = offers.reduce((sum, offer) => sum + offer.count, 0);
  return (
    <article className={`market-card${selected ? " selected" : ""}${listing.eligibility.status !== "eligible" ? " near" : ""}`}>
      <button type="button" className="market-card-button" onClick={onOpen} aria-label={`View ${listing.title}`}>
        <div className="market-card-photo">
          {listing.photo && safeImageSource(listing.photo) ? (
            <Image
              src={listing.photo}
              alt={`Development photo for ${listing.title}`}
              fill
              sizes="(max-width: 860px) 100vw, 380px"
              priority={priority}
            />
          ) : (
            <div className="photo-placeholder" aria-hidden="true"><span>Super</span></div>
          )}
          <span className={`eligibility-pill ${listing.eligibility.status}`}>
            {listing.eligibility.status === "eligible"
              ? "Eligible match"
              : listing.eligibility.status === "near"
                ? "Near match"
                : "Verify eligibility"}
          </span>
        </div>
        <div className="market-card-body">
          <div className="card-price-row">
            <strong>{rentLabel(listing)}</strong>
            <span>Apply by {formatDate(listing.deadline)}</span>
          </div>
          <h3>{listing.title}</h3>
          <p className="card-location">
            {[listing.neighborhood, listing.borough].filter(Boolean).join(", ")} · {listing.address}
          </p>
          <p className="card-units">{availableUnits || listing.units} available · {bedrooms || "Unit mix available"}</p>
          {listing.eligibility.reasons.length ? (
            <p className="near-reason">{listing.eligibility.reasons.join(" · ")}</p>
          ) : (
            <p className="match-reason">{listing.matchExplanation}</p>
          )}
          <div className="card-badges">
            <RiskBadge listing={listing} />
            <span className="precheck-badge">
              {listing.precheck.total != null
                ? `Precheck kit: ${formatMoney(listing.precheck.total)} one time`
                : listing.precheck.categories.length
                  ? "Precheck: live pricing unavailable"
                  : "Precheck pending"}
            </span>
          </div>
        </div>
      </button>
    </article>
  );
}

function OfferRow({ offer, matched, householdSize }: { offer: UnitOffer; matched: boolean; householdSize: number }) {
  const band = offer.incomeBands.find((item) => item.householdSize === householdSize);
  return (
    <div className={`offer-row${matched ? " matched" : ""}`}>
      <div>
        <strong>{offer.count} {offer.label}{offer.count === 1 ? "" : "s"}</strong>
        <span>{offer.ami ? `${offer.ami}% AMI` : "AMI not listed"} · household {offer.minimumHouseholdSize}–{offer.maximumHouseholdSize}</span>
      </div>
      <div className="offer-numbers">
        <strong>{offer.rent != null ? `${formatMoney(offer.rent)}/mo` : "Verify rent"}</strong>
        <span>
          {band
            ? `${formatMoney(band.minimumIncome)}–${formatMoney(band.maximumIncome)} income`
            : `Income table unavailable for household ${householdSize}`}
        </span>
      </div>
    </div>
  );
}

function FloorChart({ listing }: { listing: MarketplaceListing }) {
  const counts = listing.profile?.floors.counts ?? {};
  const rows = Object.entries(counts)
    .map(([floor, count]) => [Number(floor), count] as const)
    .sort((a, b) => b[0] - a[0]);
  if (!rows.length) return <p className="muted-copy">No open violations could be assigned to a floor.</p>;
  const maximum = Math.max(...rows.map(([, count]) => count));
  return (
    <div className="detail-floor-chart">
      {rows.map(([floor, count]) => (
        <div className="detail-floor-row" key={floor}>
          <span>{floor}</span>
          <i><b style={{ width: `${Math.max(4, (count / maximum) * 100)}%` }} /></i>
          <strong>{count}</strong>
        </div>
      ))}
    </div>
  );
}

function DetailPanel({
  listing,
  loading,
  error,
  householdSize,
  onClose,
  profile,
}: {
  listing: MarketplaceListing | null;
  loading: boolean;
  error: string;
  householdSize: number;
  onClose: () => void;
  profile: RenterProfile | null;
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  useEffect(() => setPhotoIndex(0), [listing?.id]);
  if (!listing && !loading) return null;
  const photos = listing?.photos ?? [];
  const activePhoto = photos[photoIndex] ?? listing?.photo ?? null;
  const visibleViolations = listing?.violations.slice(0, 30) ?? [];
  return (
    <div className="detail-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="detail-panel" role="dialog" aria-modal="true" aria-label={listing?.title ?? "Listing details"}>
        <div className="detail-topbar">
          <span>Super pre-rental report</span>
          <button type="button" onClick={onClose} aria-label="Close listing details">Close ×</button>
        </div>
        {loading && !listing ? <Thinking label="Loading the full building record" /> : null}
        {error ? <div className="market-error">{error}</div> : null}
        {listing ? (
          <>
            <div className="detail-gallery">
              {activePhoto && safeImageSource(activePhoto) ? (
                <Image src={activePhoto} alt={`Development photo ${photoIndex + 1} for ${listing.title}`} fill sizes="(max-width: 760px) 100vw, 760px" priority />
              ) : (
                <div className="photo-placeholder"><span>Super</span></div>
              )}
              <div className="gallery-label">Development photos · exact unit may differ</div>
              {photos.length > 1 ? (
                <div className="gallery-controls">
                  <button type="button" onClick={() => setPhotoIndex((photoIndex - 1 + photos.length) % photos.length)} aria-label="Previous photo">←</button>
                  <span>{photoIndex + 1} / {photos.length}</span>
                  <button type="button" onClick={() => setPhotoIndex((photoIndex + 1) % photos.length)} aria-label="Next photo">→</button>
                </div>
              ) : null}
            </div>

            <div className="detail-content">
              <header className="detail-heading">
                <div>
                  <div className={`detail-status ${listing.eligibility.status}`}>
                    {listing.eligibility.status === "eligible" ? "You match at least one unit band" : "Not an exact match"}
                  </div>
                  <h2>{listing.title}</h2>
                  <p>{listing.address} · {[listing.neighborhood, listing.borough].filter(Boolean).join(", ")}</p>
                </div>
                <div className="detail-rent">
                  <strong>{rentLabel(listing)}</strong>
                  <span>Apply by {formatDate(listing.deadline)}</span>
                </div>
              </header>

              <div className="detail-summary-grid">
                <div><span>Eligibility</span><strong>{listing.eligibility.status === "eligible" ? "Exact" : "Near"}</strong></div>
                <div><span>Building record</span><strong>{listing.risk.level}</strong></div>
                <div><span>Open violations</span><strong>{listing.risk.openCount == null ? "Unavailable" : listing.risk.openCount}</strong></div>
                <div><span>Precheck cost</span><strong>{listing.precheck.total == null ? "Pricing unavailable" : formatMoney(listing.precheck.total)}</strong></div>
              </div>

              <section className="detail-section">
                <div className="section-kicker">Why Super picked it</div>
                <h3>{listing.matchExplanation}</h3>
                {listing.eligibility.reasons.length ? (
                  <ul className="reason-list">{listing.eligibility.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                ) : null}
              </section>

              <section className="detail-section">
                <div className="section-title-row"><div><div className="section-kicker">Exact requirements</div><h3>Available unit bands</h3></div><span>{listing.units} lottery units</span></div>
                <div className="offer-list">
                  {listing.offers.map((offer) => (
                    <OfferRow key={offer.id} offer={offer} matched={listing.matchedOfferIds.includes(offer.id)} householdSize={householdSize} />
                  ))}
                </div>
              </section>

              <section className="detail-section two-column-detail">
                <div>
                  <div className="section-kicker">Amenities</div>
                  <h3>What the development lists</h3>
                  <div className="tag-list">{listing.amenities.slice(0, 14).map((amenity) => <span key={amenity}>{amenity}</span>)}</div>
                </div>
                <div>
                  <div className="section-kicker">Nearby transit</div>
                  <h3>{listing.transit.length ? `${listing.transit.join(" · ")} trains` : "Transit details unavailable"}</h3>
                  <ul className="nearby-list">
                    {listing.nearby.filter((place) => /Subway|Train/i.test(place.type)).slice(0, 5).map((place) => (
                      <li key={`${place.name}-${place.train}`}>{place.name}{place.train ? ` · ${place.train}` : ""}</li>
                    ))}
                  </ul>
                </div>
              </section>

              <section className="detail-section">
                <div className="section-title-row">
                  <div><div className="section-kicker">Building precheck</div><h3>{listing.risk.explanation}</h3></div>
                  <RiskBadge listing={listing} />
                </div>
                {listing.profile?.facts ? (
                  <div className="building-facts">
                    <span>Built <b>{listing.profile.facts.yearBuilt || "—"}</b></span>
                    <span>Floors <b>{listing.profile.facts.floors || "—"}</b></span>
                    <span>Units <b>{listing.profile.facts.residentialUnits || "—"}</b></span>
                    <span>Sq ft / unit <b>{listing.profile.facts.sqftPerUnit?.toLocaleString() || "—"}</b></span>
                  </div>
                ) : null}
                <div className="massing-detail">
                  {listing.profile?.footprint ? (
                    <Massing footprint={listing.profile.footprint} floorCount={listing.profile.facts?.floors ?? 1} breakdown={listing.profile.floors} />
                  ) : (
                    <div className="massing-unavailable">3D massing unavailable for this BIN</div>
                  )}
                  <div><div className="section-kicker">Open violations by floor</div><FloorChart listing={listing} /></div>
                </div>
              </section>

              <section className="detail-section">
                <div className="section-title-row"><div><div className="section-kicker">Inspector-confirmed record</div><h3>Open HPD violations</h3></div><span>{listing.violations.length} current</span></div>
                {visibleViolations.length ? (
                  <div className="violation-list">
                    {visibleViolations.map((violation, index) => (
                      <article className="violation-row" key={`${violation.id}-${index}`}>
                        <span className={`class-badge class-${violation.class.toLowerCase()}`}>Class {violation.class}</span>
                        <div><p>{violation.description || "Description unavailable"}</p><span>{formatDate(violation.inspectionDate)}{violation.floor ? ` · floor ${violation.floor}` : ""}{violation.apartment ? ` · apt ${violation.apartment}` : ""}{violation.rentImpairing ? " · rent impairing" : ""}</span></div>
                      </article>
                    ))}
                    {listing.violations.length > visibleViolations.length ? <p className="muted-copy">Showing the 30 highest-severity records.</p> : null}
                  </div>
                ) : (
                  <p className="empty-record">{listing.risk.level === "Unavailable" ? "HPD data was unavailable. Super does not label this building clean." : "No open HPD violations found for the current structure."}</p>
                )}
                {listing.excludedHistoricalViolations.length ? (
                  <details className="historical-records">
                    <summary>{listing.excludedHistoricalViolations.length} pre-construction records excluded</summary>
                    <p>These open records predate PLUTO&apos;s current year-built value, so they do not affect this building&apos;s rating.</p>
                  </details>
                ) : null}
              </section>

              <section className="detail-section action-grid">
                <div className="precheck-card">
                  <div className="section-kicker">Shopify Precheck kit</div>
                  <h3>{listing.precheck.total == null ? "Live pricing unavailable" : `${formatMoney(listing.precheck.total)} one time`}</h3>
                  {!listing.precheck.categories.length ? <p>No safe renter-scale mitigation is tied to the current open record.</p> : null}
                  {listing.precheck.items.map((item) => (
                    <div className="kit-item" key={item.category}>
                      <div className="kit-thumb">
                        {item.product?.image && safeImageSource(item.product.image) ? <Image src={item.product.image} alt="" fill sizes="56px" /> : null}
                      </div>
                      <div><strong>{item.product?.title ?? item.label}</strong><span>{item.reason}</span>{item.supplemental ? <em>Supplemental only</em> : null}</div>
                      <div className="kit-price">{item.product ? formatMoney(item.product.price) : "—"}</div>
                    </div>
                  ))}
                  <p className="fine-print">Products mitigate limited renter-scale symptoms. They do not replace owner repairs or official safety guidance.</p>
                </div>
                <div className="redflag-card">
                  <div className="section-kicker">Landlord-action red flags</div>
                  <h3>{listing.landlordRedFlags.length ? `${listing.landlordRedFlags.length} system-level issue categories` : "None identified in the open record"}</h3>
                  {listing.landlordRedFlags.map((flag) => <div className="redflag" key={flag.kind}><strong>{flag.count} · {flag.kind}</strong><span>{flag.summary}</span></div>)}
                </div>
              </section>

              {profile ? (
                <>
                  <button
                    type="button"
                    className="apply-button autofill-ready"
                    onClick={() => showClipboardPanel(profile)}
                  >
                    Copy application info <span>📋</span>
                  </button>
                  <a className="apply-button secondary" href={listing.applyUrl} target="_blank" rel="noreferrer">
                    Open Housing Connect <span>↗</span>
                  </a>
                  <p className="official-note">Super will show your info to paste. Applications stay with NYC Housing Connect.</p>
                </>
              ) : (
                <>
                  <a className="apply-button" href={listing.applyUrl} target="_blank" rel="noreferrer">Apply on Housing Connect <span>↗</span></a>
                  <p className="official-note">Super checks public records and eligibility bands. Applications and final determinations stay with NYC Housing Connect.</p>
                </>
              )}
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}

export default function Marketplace() {
  const [brief, setBrief] = useState("");
  const [householdSize, setHouseholdSize] = useState("2");
  const [annualIncome, setAnnualIncome] = useState("75000");
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<SearchPlan | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [partial, setPartial] = useState<MarketplaceListing[]>([]);
  const [exact, setExact] = useState<MarketplaceListing[]>([]);
  const [near, setNear] = useState<MarketplaceListing[]>([]);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketplaceListing | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [profile, setProfile] = useState<RenterProfile | null>(null);
  const [autofillEnabled, setAutofillEnabled] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const initialDeepLinkHandled = useRef(false);

  const allListings = useMemo(() => {
    const source = exact.length || near.length ? [...exact, ...near] : partial;
    return unique(source.map((listing) => listing.id)).map((id) => source.find((listing) => listing.id === id)!);
  }, [exact, near, partial]);

  const markers = useMemo<CityResultMarker[]>(
    () =>
      allListings.flatMap((listing) =>
        listing.latitude != null && listing.longitude != null
          ? [{ id: listing.id, latitude: listing.latitude, longitude: listing.longitude, label: listing.title, risk: listing.risk.level }]
          : []
      ),
    [allListings]
  );

  const setCheck = useCallback((key: string, label: string, state: Check["state"]) => {
    setChecks((current) => {
      const exists = current.findIndex((item) => item.key === key);
      if (exists < 0) return [...current, { key, label, state }];
      return current.map((item, index) => (index === exists ? { key, label, state } : item));
    });
  }, []);

  function applyEvent(event: MarketplaceEvent) {
    if (event.stage === "planning") {
      setCheck("planning", event.message, "active");
    } else if (event.stage === "plan") {
      setPlan(event.plan);
      setCheck("planning", `Brief parsed ${event.plan.generatedBy === "agent" ? "by the agent" : "with deterministic fallback"}`, "done");
      setCheck("inventory", "Searching active Housing Connect lotteries", "active");
    } else if (event.stage === "inventory") {
      setCheck("inventory", `${event.count} active lotteries loaded${event.source === "snapshot" ? " from fallback snapshot" : " live"}`, "done");
      setCheck("eligibility", "Checking exact rent, bedroom, household, and income bands", "active");
    } else if (event.stage === "inspecting") {
      if (event.completed === 0) {
        setCheck("eligibility", "Exact unit bands loaded", "done");
        setCheck("records", "Resolving BBL/BIN and reading open HPD records", "active");
      } else {
        setCheck("records", event.message, event.completed >= event.total ? "done" : "active");
      }
    } else if (event.stage === "listing") {
      setPartial((current) => [...current.filter((listing) => listing.id !== event.listing.id), event.listing]);
    } else if (event.stage === "pricing") {
      setCheck("records", "Building records checked", "done");
      setCheck("pricing", event.message, "active");
    } else if (event.stage === "results") {
      setExact(event.exact);
      setNear(event.near);
      setCheck("pricing", "Safe Precheck categories priced through Shopify", "done");
    } else if (event.stage === "done") {
      setPhase("done");
    } else if (event.stage === "error") {
      setError(event.message);
      setPhase("error");
    }
  }

  async function search(event?: FormEvent) {
    event?.preventDefault();
    const input: RenterBrief = {
      brief: brief.trim(),
      householdSize: Number(householdSize),
      annualIncome: Number(annualIncome.replace(/[^0-9.]/g, "")),
    };
    if (!input.brief || !Number.isInteger(input.householdSize) || input.householdSize < 1 || !Number.isFinite(input.annualIncome)) {
      setError("Enter what you need, household size, and annual household income.");
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setPhase("searching");
    setPlan(null);
    setChecks([]);
    setPartial([]);
    setExact([]);
    setNear([]);
    setError("");
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    replaceListingQuery(null);
    try {
      const response = await fetch("/api/marketplace/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Search failed (${response.status})`);
      }
      if (!response.body) throw new Error("Search stream unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split(/\r?\n/).find((item) => item.startsWith("data:"));
          if (line) applyEvent(JSON.parse(line.slice(5).trim()) as MarketplaceEvent);
        }
      }
    } catch (reason: any) {
      if (reason?.name === "AbortError") return;
      setError(reason?.message ?? "Search failed");
      setPhase("error");
    }
  }

  const openListing = useCallback(
    async (id: string, updateUrl = true) => {
      if (updateUrl) replaceListingQuery(id);
      setSelectedId(id);
      setDetail(allListings.find((listing) => listing.id === id) ?? null);
      setDetailLoading(true);
      setDetailError("");
      const params = new URLSearchParams({ id, brief, householdSize, annualIncome });
      try {
        const response = await fetch(`/api/marketplace/listing?${params}`);
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? "Listing details unavailable");
        setDetail(body);
      } catch (reason: any) {
        setDetailError(reason?.message ?? "Listing details unavailable");
      } finally {
        setDetailLoading(false);
      }
    },
    [allListings, annualIncome, brief, householdSize]
  );

  const closeListing = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
    replaceListingQuery(null);
  }, []);

  useEffect(() => {
    if (initialDeepLinkHandled.current) return;
    initialDeepLinkHandled.current = true;
    const id = new URLSearchParams(window.location.search).get("listing");
    if (id) void openListing(id, false);
  }, [openListing]);

  // Load autofill profile on mount
  useEffect(() => {
    const existing = loadProfile();
    if (existing) {
      setProfile(existing);
      setAutofillEnabled(true);
      // Auto-fill brief from profile
      const householdField = existing.forms
        .flatMap((f) => f.fields)
        .find((field) => field.label.toLowerCase().includes("household"));
      const incomeField = existing.forms
        .flatMap((f) => f.fields)
        .find((field) => field.label.toLowerCase().includes("income"));
      if (householdField) setHouseholdSize(householdField.value);
      if (incomeField) setAnnualIncome(incomeField.value);
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectedId) closeListing();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeListing, selectedId]);

  const activeCheck = [...checks].reverse().find((check) => check.state === "active");
  const showResults = phase !== "idle" || allListings.length > 0;

  return (
    <main className="market-shell">
      <nav className="market-nav">
        <a className="market-wordmark" href="#top" aria-label="Super home"><span>S</span>Super</a>
        <div><span className="live-dot" /> Live NYC affordable housing</div>
        <a href="https://housingconnect.nyc.gov/PublicWeb/search-lotteries" target="_blank" rel="noreferrer">Official Housing Connect ↗</a>
      </nav>

      <section className="market-hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Agentic rental marketplace · New York City</p>
          <h1>Find the apartment.<br />Precheck the building.</h1>
          <p>Super matches your household to live Housing Connect units, verifies the income math, then reads the building&apos;s inspector-confirmed record before you apply.</p>
        </div>
        <div className="hero-proof"><strong>3 checks Zillow skips</strong><span>Exact eligibility</span><span>Open HPD violations</span><span>One-time Precheck cost</span></div>
      </section>

      <ProfileManager
        onProfileLoaded={(p) => { setProfile(p); setAutofillEnabled(true); }}
        onProfileDeleted={() => { setProfile(null); setAutofillEnabled(false); setHouseholdSize("2"); setAnnualIncome("75000"); }}
        briefAutoFill={(h, i) => { setHouseholdSize(h); setAnnualIncome(i); }}
      />

      <form className="market-search" onSubmit={search}>
        <label className="brief-field">
          <span>What are you looking for?</span>
          <input value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="2 bedroom in Brooklyn under $2,500, near a train" />
        </label>
        <label>
          <span>Household</span>
          <input type="number" min="1" max="20" value={householdSize} onChange={(event) => setHouseholdSize(event.target.value)} aria-label="Household size" />
        </label>
        <label>
          <span>Annual income</span>
          <div className="money-input"><i>$</i><input inputMode="numeric" value={annualIncome} onChange={(event) => setAnnualIncome(event.target.value)} aria-label="Annual household income" /></div>
        </label>
        <button type="submit" disabled={phase === "searching" || !brief.trim()}>{phase === "searching" ? "Checking…" : "Find my matches"}<span>→</span></button>
      </form>

      <div className="example-row"><span>Try</span>{EXAMPLES.map((example) => <button key={example.brief} type="button" onClick={() => { setBrief(example.brief); setHouseholdSize(example.household); setAnnualIncome(example.income); }}>{example.brief}</button>)}</div>

      {checks.length ? (
        <section className="super-checks" aria-label="What Super checked">
          <div className="checks-heading"><span>What Super checked</span>{phase === "searching" && activeCheck ? <Thinking label={activeCheck.label} /> : <strong>{phase === "done" ? "Complete" : "In progress"}</strong>}</div>
          <div className="check-list">{checks.map((check) => <div className={`check-item ${check.state}`} key={check.key}><i>{check.state === "done" ? "✓" : check.state === "active" ? "•" : ""}</i><span>{check.label}</span></div>)}</div>
          {plan ? <div className="plan-chips">{[...plan.boroughs, ...plan.neighborhoods, plan.bedrooms ? `${plan.bedrooms.min === 0 ? "Studio" : `${plan.bedrooms.min} bedroom${plan.bedrooms.min === 1 ? "" : "s"}`}` : "", plan.maxRent ? `≤ ${formatMoney(plan.maxRent)}` : "", ...plan.subwayLines.map((line) => `${line} train`)].filter(Boolean).map((item) => <span key={item}>{item}</span>)}</div> : null}
        </section>
      ) : null}

      {error ? <div className="market-error">{error}</div> : null}

      <section className={`marketplace-layout${showResults ? " has-search" : ""}`}>
        <div className="results-pane">
          {!showResults ? (
            <div className="market-intro">
              <p className="eyebrow">How it works</p>
              <h2>One search. Three data systems. No chatbot.</h2>
              <div className="intro-steps">
                <article><span>01</span><strong>Match</strong><p>The agent turns your brief into filters, then deterministic code verifies household, income, bedroom, and rent boundaries.</p></article>
                <article><span>02</span><strong>Inspect</strong><p>Each address is joined to BBL/BIN and checked against open HPD violations, PLUTO, complaints, and building footprints.</p></article>
                <article><span>03</span><strong>Precheck</strong><p>Only safe renter-scale mitigations are priced. Building-system and life-safety issues stay landlord-action red flags.</p></article>
              </div>
            </div>
          ) : (
            <>
              <div className="results-heading">
                <div><p className="eyebrow">Live matches</p><h2>{phase === "searching" ? `${allListings.length} buildings checked so far` : exact.length ? `${exact.length} exact match${exact.length === 1 ? "" : "es"}` : "No exact match yet"}</h2></div>
                <span>{exact.length + near.length || partial.length} shown · up to 8 inspected</span>
              </div>
              {exact.map((listing, index) => <ListingCard key={listing.id} listing={listing} selected={selectedId === listing.id} onOpen={() => openListing(listing.id)} priority={index < 2} />)}
              {phase === "searching" && !exact.length ? partial.map((listing, index) => <ListingCard key={listing.id} listing={listing} selected={selectedId === listing.id} onOpen={() => openListing(listing.id)} priority={index < 2} />) : null}
              {phase !== "searching" && near.length ? <div className="near-heading"><strong>Near matches</strong><span>Not eligible as entered · reason shown on every card</span></div> : null}
              {phase !== "searching" ? near.map((listing) => <ListingCard key={listing.id} listing={listing} selected={selectedId === listing.id} onOpen={() => openListing(listing.id)} />) : null}
              {phase === "done" && !exact.length && !near.length ? <div className="no-results"><h3>No active listing had enough data to verify a match.</h3><p>Try a broader borough or a higher rent ceiling. Super will keep your income and household boundaries exact.</p></div> : null}
            </>
          )}
        </div>
        <div className="map-pane"><CityMap markers={markers} selectedId={selectedId} onSelect={openListing} /></div>
      </section>

      <footer className="market-footer"><span>Super uses public NYC data. Verify all terms with Housing Connect.</span><strong>Built for NYChackathon August 15th by Ryan Lim</strong></footer>

      {selectedId ? <DetailPanel listing={detail} loading={detailLoading} error={detailError} householdSize={Number(householdSize) || 1} onClose={closeListing} profile={profile} /> : null}
    </main>
  );
}
