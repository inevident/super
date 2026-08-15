"use client";

import Image from "next/image";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import CityMap, { type CityResultMarker } from "./CityMap";
import Massing from "./Massing";
import { isDisplayImageSource } from "@/lib/image-policy";
import { normalizeSubwayLines, subwayLineStyle } from "@/lib/subway";
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

const PRECHECK_BASIS_LABEL = {
  violation: "HPD violation",
  building: "Building fit",
  location: "Location fit",
  photo: "Photo-informed",
} as const;

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
  const offers = matchedOffers(listing);
  const rents = unique(offers.flatMap((offer) =>
    [offer.rent, offer.rentMaximum].filter((rent): rent is number => rent != null)
  )).sort((a, b) => a - b);
  if (!rents.length) return "Rent needs verification";
  return rents.length === 1
    ? `${formatMoney(rents[0])}/mo`
    : `${formatMoney(rents[0])}–${formatMoney(rents[rents.length - 1])}/mo`;
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function updateListingQuery(id: string | null, mode: "push" | "replace" = "replace") {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("listing", id);
  else url.searchParams.delete("listing");
  const currentState = window.history.state && typeof window.history.state === "object"
    ? window.history.state
    : {};
  window.history[mode === "push" ? "pushState" : "replaceState"](
    { ...currentState, superListingEntry: Boolean(id) },
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}

function listingDeadline(listing: MarketplaceListing) {
  if (listing.deadline) return `Apply by ${formatDate(listing.deadline)}`;
  return listing.provider === "housing-connect" ? "Deadline unavailable" : "Provider availability";
}

function providerActionLabel(listing: MarketplaceListing) {
  if (listing.provider === "housing-connect") return "Apply on Housing Connect";
  if (listing.provider === "nychdc") return "Open NYC HDC application";
  return `Open ${listing.providerLabel} listing`;
}

function SubwayLines({ lines }: { lines: string[] }) {
  const routes = normalizeSubwayLines(lines);
  return (
    <div className="subway-lines" aria-label={routes.length ? `Subway lines ${routes.join(", ")}` : "Subway lines unavailable"}>
      <span>Subway</span>
      {routes.length
        ? routes.map((line) => <i key={line} style={subwayLineStyle(line)}>{line}</i>)
        : <em>lookup unavailable</em>}
    </div>
  );
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
          {listing.photo && isDisplayImageSource(listing.photo) ? (
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
          <span className="provider-pill">{listing.providerLabel}</span>
        </div>
        <div className="market-card-body">
          <div className="card-price-row">
            <strong>{rentLabel(listing)}</strong>
            <span>{listingDeadline(listing)}</span>
          </div>
          <h3>{listing.title}</h3>
          <p className="card-location">
            {[listing.neighborhood, listing.borough].filter(Boolean).join(", ")} · {listing.address}
          </p>
          <p className="card-units">
            {availableUnits || listing.units ? `${availableUnits || listing.units} available` : "Availability varies"}
            {` · ${bedrooms || "Unit mix available"}`}
          </p>
          <SubwayLines lines={listing.transit} />
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
                  ? "Precheck kit: live pricing unavailable"
                  : "Precheck kit: building record unavailable"}
            </span>
          </div>
        </div>
      </button>
    </article>
  );
}

function RecordedShowcaseCard({
  listing,
  selected,
  onOpen,
}: {
  listing: MarketplaceListing;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <article className={`recorded-showcase-card${selected ? " selected" : ""}`}>
      <button type="button" onClick={onOpen} aria-label={`Open recorded Precheck for ${listing.address}`}>
        <div className="recorded-risk">
          <span>Recorded risk</span>
          <strong>{listing.risk.level}</strong>
        </div>
        <div className="recorded-copy">
          <span>Public-data building case · not an available apartment</span>
          <h4>{listing.address}</h4>
          <p>{listing.risk.openCount?.toLocaleString()} open violations in the captured record · {listing.precheck.categories.map((category) => category.label).join(" · ")}</p>
        </div>
        <div className="recorded-cost">
          <span>Violation Precheck</span>
          <strong>{listing.precheck.total == null ? "Pricing unavailable" : `${formatMoney(listing.precheck.total)} once`}</strong>
          <i>Open report →</i>
        </div>
      </button>
    </article>
  );
}

function OfferRow({ offer, matched, householdSize }: { offer: UnitOffer; matched: boolean; householdSize: number }) {
  const band = offer.incomeBands.find((item) => item.householdSize === householdSize);
  const household = offer.minimumHouseholdSize > 0 || offer.maximumHouseholdSize > 0
    ? `household ${offer.minimumHouseholdSize}–${offer.maximumHouseholdSize}`
    : "household rule not published";
  const rent = offer.rent == null
    ? "Verify rent"
    : offer.rentMaximum != null && offer.rentMaximum !== offer.rent
      ? `${formatMoney(offer.rent)}–${formatMoney(offer.rentMaximum)}/mo`
      : `${formatMoney(offer.rent)}/mo`;
  return (
    <div className={`offer-row${matched ? " matched" : ""}`}>
      <div>
        <strong>{offer.count > 0 ? `${offer.count} ` : ""}{offer.label}{offer.count > 1 ? "s" : ""}</strong>
        <span>{offer.ami ? `${offer.ami}% AMI` : "AMI not listed"} · {household}</span>
      </div>
      <div className="offer-numbers">
        <strong>{rent}</strong>
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
}: {
  listing: MarketplaceListing | null;
  loading: boolean;
  error: string;
  householdSize: number;
  onClose: () => void;
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  useEffect(() => setPhotoIndex(0), [listing?.id]);
  if (!listing && !loading && !error) return null;
  const isShowcase = listing?.source === "showcase";
  const photos = listing?.photos ?? [];
  const activePhoto = photos[photoIndex] ?? listing?.photo ?? null;
  const visibleViolations = listing?.violations.slice(0, 30) ?? [];
  const optionalItems = listing?.precheck.items.filter((item) => item.optional) ?? [];
  const optionalTotal = optionalItems.reduce((sum, item) => sum + (item.product?.price ?? 0), 0);
  const optionalComplete = optionalItems.every((item) => item.product);
  return (
    <div className="detail-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="detail-panel" role="dialog" aria-modal="true" aria-label={listing?.title ?? "Listing details"}>
        <div className="detail-topbar">
          <span>{isShowcase ? "Recorded Precheck case study" : `${listing?.providerLabel ?? "Listing provider"} · Super pre-rental report`}</span>
          <button type="button" onClick={onClose} aria-label="Close listing details">Close ×</button>
        </div>
        {loading && !listing ? <Thinking label="Loading the full building record" /> : null}
        {error ? <div className="market-error">{error}</div> : null}
        {listing ? (
          <>
            {isShowcase ? (
              <div className="case-study-banner">
                <span>Recorded NYC building record</span>
                <strong>Not an active rental listing</strong>
                <p>This case keeps the violation-to-Shopify workflow available when current lotteries are clean or public APIs are temporarily unavailable.</p>
              </div>
            ) : <div className="detail-gallery">
              {activePhoto && isDisplayImageSource(activePhoto) ? (
                <Image src={activePhoto} alt={`Development photo ${photoIndex + 1} for ${listing.title}`} fill sizes="(max-width: 760px) 100vw, 760px" priority />
              ) : (
                <div className="photo-placeholder"><span>Super</span></div>
              )}
              <div className="gallery-label">Provider development photos · exact unit may differ</div>
              {photos.length > 1 ? (
                <div className="gallery-controls">
                  <button type="button" onClick={() => setPhotoIndex((photoIndex - 1 + photos.length) % photos.length)} aria-label="Previous photo">←</button>
                  <span>{photoIndex + 1} / {photos.length}</span>
                  <button type="button" onClick={() => setPhotoIndex((photoIndex + 1) % photos.length)} aria-label="Next photo">→</button>
                </div>
              ) : null}
            </div>}

            <div className="detail-content">
              <header className="detail-heading">
                <div>
                  <div className={`detail-status ${listing.eligibility.status}`}>
                    {isShowcase
                      ? "Recorded case study"
                      : listing.eligibility.status === "eligible"
                        ? "You match at least one unit band"
                        : listing.eligibility.status === "unknown"
                          ? "Eligibility needs provider verification"
                          : "Not an exact match"}
                  </div>
                  <h2>{listing.title}</h2>
                  <p>{listing.address} · {[listing.neighborhood, listing.borough].filter(Boolean).join(", ")}</p>
                </div>
                <div className="detail-rent">
                  <strong>{isShowcase ? "Building record only" : rentLabel(listing)}</strong>
                  <span>{isShowcase ? "Not currently for rent" : listingDeadline(listing)}</span>
                </div>
              </header>

              <div className="detail-summary-grid">
                <div><span>Eligibility</span><strong>{isShowcase ? "Case study" : listing.eligibility.status === "eligible" ? "Exact" : listing.eligibility.status === "near" ? "Near" : "Verify"}</strong></div>
                <div><span>Building record</span><strong>{listing.risk.level}</strong></div>
                <div><span>Open violations</span><strong>{listing.risk.openCount == null ? "Unavailable" : listing.risk.openCount}</strong></div>
                <div><span>Precheck cost</span><strong>{listing.precheck.total == null ? "Pricing unavailable" : formatMoney(listing.precheck.total)}</strong></div>
              </div>

              <section className="detail-section">
                <div className="section-kicker">Why Super picked it</div>
                <h3>{listing.matchExplanation}</h3>
                {!isShowcase && listing.eligibility.reasons.length ? (
                  <ul className="reason-list">{listing.eligibility.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                ) : null}
              </section>

              {!isShowcase ? <section className="detail-section">
                <div className="section-title-row">
                  <div>
                    <div className="section-kicker">Published requirements</div>
                    <h3>{listing.provider === "housing-connect" ? "Available unit bands" : "Provider-published unit details"}</h3>
                  </div>
                  <span>{listing.units ? `${listing.units} listed units` : "Availability varies"}</span>
                </div>
                <div className="offer-list">
                  {listing.offers.map((offer) => (
                    <OfferRow key={offer.id} offer={offer} matched={listing.matchedOfferIds.includes(offer.id)} householdSize={householdSize} />
                  ))}
                </div>
              </section> : null}

              {!isShowcase ? <section className="detail-section two-column-detail">
                <div>
                  <div className="section-kicker">Amenities</div>
                  <h3>What the development lists</h3>
                  <div className="tag-list">{listing.amenities.slice(0, 14).map((amenity) => <span key={amenity}>{amenity}</span>)}</div>
                </div>
                <div>
                  <div className="section-kicker">Nearby transit</div>
                  <SubwayLines lines={listing.transit} />
                  <ul className="nearby-list">
                    {listing.nearby.filter((place) => /Subway|Train/i.test(place.type)).slice(0, 5).map((place) => (
                      <li key={`${place.name}-${place.train}`}>{place.name}{place.train ? ` · ${place.train}` : ""}</li>
                    ))}
                  </ul>
                </div>
              </section> : null}

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
                <div className="section-title-row"><div><div className="section-kicker">Inspector-confirmed record</div><h3>Open HPD violations</h3></div><span>{isShowcase ? `${listing.violations.length} representative samples` : `${listing.violations.length} current`}</span></div>
                {visibleViolations.length ? (
                  <div className="violation-list">
                    {visibleViolations.map((violation, index) => (
                      <article className="violation-row" key={`${violation.id}-${index}`}>
                        <span className={`class-badge class-${violation.class.toLowerCase()}`}>Class {violation.class}</span>
                        <div><p>{violation.description || "Description unavailable"}</p><span>{isShowcase ? violation.status : formatDate(violation.inspectionDate)}{violation.floor ? ` · floor ${violation.floor}` : ""}{violation.apartment ? ` · apt ${violation.apartment}` : ""}{violation.rentImpairing ? " · rent impairing" : ""}</span></div>
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
                  <div className="section-kicker">Shopify violation Precheck + optional move-in fit</div>
                  <h3>{listing.precheck.total == null ? "Live Shopify pricing unavailable" : `${formatMoney(listing.precheck.total)} one time for violation mitigations`}</h3>
                  <p>Violation-backed mitigations determine the Precheck total. Optional fit items use public building facts, nearby transit, and carefully limited development-photo cues and are priced separately.</p>
                  {!listing.precheck.categories.length ? <p>No safe renter-scale or apartment-fit item was identified.</p> : null}
                  {listing.precheck.items.map((item) => (
                    <div className="kit-item" key={item.category}>
                      <div className="kit-thumb">
                        {item.product?.image && isDisplayImageSource(item.product.image) ? <Image src={item.product.image} alt="" fill sizes="56px" /> : null}
                      </div>
                      <div>
                        <strong>{item.product?.title ?? item.label}</strong>
                        <span>{item.reason}</span>
                        <em className={`kit-basis basis-${item.basis}`}>{PRECHECK_BASIS_LABEL[item.basis]}</em>
                        {item.supplemental ? <em>Supplemental only</em> : null}
                      </div>
                      <div className="kit-price">{item.product ? formatMoney(item.product.price) : "—"}</div>
                    </div>
                  ))}
                  {optionalItems.length ? (
                    <p className="fine-print">
                      Optional move-in extras: {optionalTotal > 0 ? formatMoney(optionalTotal) : "no live prices"}
                      {optionalComplete ? " priced separately." : " priced separately; some live prices are unavailable."}
                    </p>
                  ) : null}
                  {listing.precheck.photoAnalysisStatus === "unavailable" ? <p className="fine-print">Development-photo analysis was unavailable; no image-based recommendation was assumed.</p> : null}
                  <p className="fine-print">Photo cues come from development marketing images and may not depict the exact unit. Confirm fit and dimensions. Products never replace owner repairs or official safety guidance.</p>
                </div>
                <div className="redflag-card">
                  <div className="section-kicker">Landlord-action red flags</div>
                  <h3>{listing.landlordRedFlags.length ? `${listing.landlordRedFlags.length} system-level issue categories` : "None identified in the open record"}</h3>
                  {listing.landlordRedFlags.map((flag) => <div className="redflag" key={flag.kind}><strong>{flag.count} · {flag.kind}</strong><span>{flag.summary}</span></div>)}
                </div>
              </section>

              {!isShowcase && listing.applyUrl ? (
                <a className="apply-button" href={listing.applyUrl} target="_blank" rel="noreferrer">
                  {providerActionLabel(listing)} <span>↗</span>
                </a>
              ) : !isShowcase ? <p className="application-unavailable">Official application link unavailable · verify with {listing.providerLabel}</p> : null}
              <p className="official-note">
                {isShowcase
                  ? "Recorded public-data case study. It demonstrates Super's analysis and is not an available apartment."
                  : `Super checks public records and published eligibility details. Applications, current availability, and final determinations stay with ${listing.providerLabel}.`}
              </p>
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
  const [submittedInput, setSubmittedInput] = useState<RenterBrief | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<SearchPlan | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [partial, setPartial] = useState<MarketplaceListing[]>([]);
  const [exact, setExact] = useState<MarketplaceListing[]>([]);
  const [near, setNear] = useState<MarketplaceListing[]>([]);
  const [unknown, setUnknown] = useState<MarketplaceListing[]>([]);
  const [showcase, setShowcase] = useState<MarketplaceListing | null>(null);
  const [inspectedTotal, setInspectedTotal] = useState(0);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MarketplaceListing | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const detailRequest = useRef(0);
  const initialDeepLinkHandled = useRef(false);

  const allListings = useMemo(() => {
    const source = exact.length || near.length || unknown.length ? [...exact, ...near, ...unknown] : partial;
    return unique(source.map((listing) => listing.id)).map((id) => source.find((listing) => listing.id === id)!);
  }, [exact, near, partial, unknown]);

  const precheckSpotlight = phase === "searching"
    ? null
    : allListings.find((listing) => listing.spotlight === "precheck") ?? showcase;
  const visibleExact = exact.filter((listing) => listing.id !== precheckSpotlight?.id);
  const visibleNear = near.filter((listing) => listing.id !== precheckSpotlight?.id);
  const visibleUnknown = unknown.filter((listing) => listing.id !== precheckSpotlight?.id);

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
      setCheck("inventory", "Searching active affordable-housing sources", "active");
    } else if (event.stage === "inventory") {
      setCheck("inventory", `${event.message}${event.source === "snapshot" ? " · Housing Connect snapshot fallback active" : ""}`, "done");
      setCheck("eligibility", "Checking exact rent, bedroom, household, and income bands", "active");
    } else if (event.stage === "inspecting") {
      setInspectedTotal(event.total);
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
      setUnknown(event.unknown ?? []);
      setShowcase(event.showcase ?? null);
      setCheck("pricing", "Violation and apartment-fit items checked against Shopify", "done");
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
    detailAbort.current?.abort();
    detailRequest.current += 1;
    const controller = new AbortController();
    abort.current = controller;
    setPhase("searching");
    setSubmittedInput(input);
    setPlan(null);
    setChecks([]);
    setPartial([]);
    setExact([]);
    setNear([]);
    setUnknown([]);
    setShowcase(null);
    setInspectedTotal(0);
    setError("");
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    updateListingQuery(null);
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
      let sawTerminalEvent = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split(/\r?\n/).find((item) => item.startsWith("data:"));
          if (line) {
            const marketEvent = JSON.parse(line.slice(5).trim()) as MarketplaceEvent;
            if (marketEvent.stage === "done" || marketEvent.stage === "error") sawTerminalEvent = true;
            applyEvent(marketEvent);
          }
        }
      }
      if (!sawTerminalEvent) throw new Error("Search ended before Super finished checking the results.");
    } catch (reason: any) {
      if (reason?.name === "AbortError") return;
      setError(reason?.message ?? "Search failed");
      setPhase("error");
    }
  }

  const openListing = useCallback(
    async (id: string, updateUrl = true) => {
      detailAbort.current?.abort();
      const controller = new AbortController();
      detailAbort.current = controller;
      const requestNumber = detailRequest.current + 1;
      detailRequest.current = requestNumber;
      if (updateUrl) {
        const hasOpenListing = Boolean(new URLSearchParams(window.location.search).get("listing"));
        updateListingQuery(id, hasOpenListing ? "replace" : "push");
      }
      setSelectedId(id);
      setDetail(allListings.find((listing) => listing.id === id) ?? (showcase?.id === id ? showcase : null));
      setDetailLoading(true);
      setDetailError("");
      try {
        const response = submittedInput
          ? await fetch("/api/marketplace/listing", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ id, input: submittedInput }),
              signal: controller.signal,
            })
          : await fetch(`/api/marketplace/listing?id=${encodeURIComponent(id)}`, {
              signal: controller.signal,
            });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? "Listing details unavailable");
        if (detailRequest.current !== requestNumber) return;
        setDetail(body);
      } catch (reason: any) {
        if (reason?.name === "AbortError" || detailRequest.current !== requestNumber) return;
        setDetailError(reason?.message ?? "Listing details unavailable");
      } finally {
        if (detailRequest.current === requestNumber) setDetailLoading(false);
      }
    },
    [allListings, showcase, submittedInput]
  );

  const closeListing = useCallback(() => {
    if (
      window.history.state?.superListingEntry &&
      new URLSearchParams(window.location.search).has("listing")
    ) {
      window.history.back();
      return;
    }
    detailAbort.current?.abort();
    detailRequest.current += 1;
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    setDetailLoading(false);
    updateListingQuery(null);
  }, []);

  useEffect(() => () => {
    abort.current?.abort();
    detailAbort.current?.abort();
  }, []);

  useEffect(() => {
    if (initialDeepLinkHandled.current) return;
    initialDeepLinkHandled.current = true;
    const id = new URLSearchParams(window.location.search).get("listing");
    if (id) void openListing(id, false);
  }, [openListing]);

  useEffect(() => {
    const onPopState = () => {
      const id = new URLSearchParams(window.location.search).get("listing");
      if (id) {
        void openListing(id, false);
        return;
      }
      detailAbort.current?.abort();
      detailRequest.current += 1;
      setSelectedId(null);
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [openListing]);

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
        <div><span className="live-dot" /> NYC affordable housing · multiple sources</div>
        <a href="https://housingconnect.nyc.gov/PublicWeb/search-lotteries" target="_blank" rel="noreferrer">Housing Connect ↗</a>
      </nav>

      <section className="market-hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Agentic rental marketplace · New York City</p>
          <h1>Find the apartment.<br />Precheck the building.</h1>
          <p>Super searches Housing Connect and trusted affordable-housing providers, checks the published eligibility math, then reads each building&apos;s inspector-confirmed record before you apply.</p>
        </div>
        <div className="hero-proof"><strong>3 checks Zillow skips</strong><span>Exact eligibility</span><span>Open HPD violations</span><span>One-time Precheck cost</span></div>
      </section>

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
              <h2>One search. Five housing sources. No chatbot.</h2>
              <div className="intro-steps">
                <article><span>01</span><strong>Match</strong><p>The agent searches Housing Connect, NYC HDC, Fifth Avenue Committee, Reside, and Langsam; deterministic code verifies every published boundary.</p></article>
                <article><span>02</span><strong>Inspect</strong><p>Each address is joined to BBL/BIN and checked against open HPD violations, PLUTO, complaints, and building footprints.</p></article>
                <article><span>03</span><strong>Precheck</strong><p>Only safe renter-scale mitigations are priced. Building-system and life-safety issues stay landlord-action red flags.</p></article>
              </div>
            </div>
          ) : (
            <>
              <div className="results-heading">
                <div><p className="eyebrow">Live matches</p><h2>{phase === "searching" ? `${allListings.length} buildings checked so far` : exact.length ? `${exact.length} exact match${exact.length === 1 ? "" : "es"}` : "No exact match yet"}</h2></div>
                <span>{exact.length + near.length + unknown.length || partial.length} shown · {inspectedTotal || 12} inspected</span>
              </div>
              {precheckSpotlight ? (
                <section className="precheck-spotlight" aria-label="Precheck spotlight">
                  <div className="spotlight-heading">
                    <div><p className="eyebrow">{precheckSpotlight.source === "showcase" ? "Recorded Precheck case" : "Precheck spotlight"}</p><h3>Why the Shopify layer matters</h3></div>
                    <p>
                      {precheckSpotlight.source === "showcase"
                        ? "Not an active rental or a safety recommendation. This recorded public-data case keeps the commerce workflow demonstrable:"
                        : "Not a safety recommendation. Super retained this building because its real HPD record produced a renter-scale kit:"}
                      {` ${precheckSpotlight.precheck.categories.map((category) => category.label).join(" · ")}.`}
                    </p>
                  </div>
                  {precheckSpotlight.source === "showcase" ? (
                    <RecordedShowcaseCard listing={precheckSpotlight} selected={selectedId === precheckSpotlight.id} onOpen={() => openListing(precheckSpotlight.id)} />
                  ) : (
                    <ListingCard listing={precheckSpotlight} selected={selectedId === precheckSpotlight.id} onOpen={() => openListing(precheckSpotlight.id)} priority />
                  )}
                </section>
              ) : null}
              {visibleExact.map((listing, index) => <ListingCard key={listing.id} listing={listing} selected={selectedId === listing.id} onOpen={() => openListing(listing.id)} priority={index < 2 && !precheckSpotlight} />)}
              {phase === "searching" && !exact.length ? partial.map((listing, index) => <ListingCard key={listing.id} listing={listing} selected={selectedId === listing.id} onOpen={() => openListing(listing.id)} priority={index < 2} />) : null}
              {phase !== "searching" && visibleNear.length ? <div className="near-heading"><strong>Near matches</strong><span>Not eligible as entered · reason shown on every card</span></div> : null}
              {phase !== "searching" ? visibleNear.map((listing) => <ListingCard key={listing.id} listing={listing} selected={selectedId === listing.id} onOpen={() => openListing(listing.id)} />) : null}
              {phase !== "searching" && visibleUnknown.length ? <div className="unknown-heading"><strong>Eligibility to verify</strong><span>The provider has not published enough detail for an exact determination</span></div> : null}
              {phase !== "searching" ? visibleUnknown.map((listing) => <ListingCard key={listing.id} listing={listing} selected={selectedId === listing.id} onOpen={() => openListing(listing.id)} />) : null}
              {phase === "done" && !exact.length && !near.length && !unknown.length ? <div className="no-results"><h3>No active listing had enough data to verify a match.</h3><p>Try a broader borough or a higher rent ceiling. Super will keep your income and household boundaries exact.</p></div> : null}
            </>
          )}
        </div>
        <div className="map-pane"><CityMap markers={markers} selectedId={selectedId} onSelect={openListing} /></div>
      </section>

      <footer className="market-footer"><span>Super uses public NYC and provider data. Verify all terms with the listing provider.</span><strong>Built for NYChackathon August 15th by Ryan Lim</strong></footer>

      {selectedId ? <DetailPanel listing={detail} loading={detailLoading} error={detailError} householdSize={Number(householdSize) || 1} onClose={closeListing} /> : null}
    </main>
  );
}
