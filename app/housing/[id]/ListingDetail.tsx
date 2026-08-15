"use client";

import { useEffect, useState } from "react";
import type { Listing } from "@/lib/listings";
import type { Address, BuildingProfile, Pick, ScanEvent } from "@/lib/types";

const subwayColors: Record<string, { background: string; color?: string }> = {
  "1": { background: "#EE352E" }, "2": { background: "#EE352E" }, "3": { background: "#EE352E" },
  "4": { background: "#00933C" }, "5": { background: "#00933C" }, "6": { background: "#00933C" },
  "7": { background: "#B933AD" }, A: { background: "#0039A6" }, C: { background: "#0039A6" }, E: { background: "#0039A6" },
  B: { background: "#FF6319" }, D: { background: "#FF6319" }, F: { background: "#FF6319" }, M: { background: "#FF6319" },
  G: { background: "#6CBE45" }, J: { background: "#996633" }, Z: { background: "#996633" }, L: { background: "#A7A9AC" },
  N: { background: "#FCCC0A", color: "#111" }, Q: { background: "#FCCC0A", color: "#111" }, R: { background: "#FCCC0A", color: "#111" }, W: { background: "#FCCC0A", color: "#111" },
  S: { background: "#808183" },
};

export default function ListingDetail({ listing }: { listing: Listing }) {
  const images = listing.imageUrls?.length ? listing.imageUrls : listing.imageUrl ? [listing.imageUrl] : [];
  const [image, setImage] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState("");
  const [address, setAddress] = useState<Address | null>(null);
  const [profile, setProfile] = useState<BuildingProfile | null>(null);
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [error, setError] = useState("");
  const [stations, setStations] = useState<{ name: string; routes: string[]; distanceMiles: number }[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/nearby-transit?address=${encodeURIComponent(`${listing.address}, ${listing.borough}`)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Transit lookup failed")))
      .then((data) => setStations(data.stations ?? []))
      .catch((cause) => { if (cause?.name !== "AbortError") setStations([]); });
    return () => controller.abort();
  }, [listing.address, listing.borough]);

  async function scanAndShop() {
    setScanning(true); setError(""); setProfile(null); setPicks(null);
    try {
      const response = await fetch("/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: `${listing.address}, ${listing.borough}` }) });
      if (!response.body) throw new Error("No scan stream returned");
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const frames = buffer.split("\n\n"); buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((item) => item.startsWith("data:")); if (!line) continue;
          const event = JSON.parse(line.slice(5).trim()) as ScanEvent;
          if (event.stage === "resolving" || event.stage === "records" || event.stage === "thinking" || event.stage === "shopping") setStatus(event.message);
          else if (event.stage === "address") setAddress(event.address);
          else if (event.stage === "profile") setProfile(event.profile);
          else if (event.stage === "picks") setPicks(event.picks);
          else if (event.stage === "error") throw new Error(event.message);
          else if (event.stage === "done") setStatus("Scan complete");
        }
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Scan failed"); }
    finally { setScanning(false); }
  }

  const mapQuery = encodeURIComponent(listing.address);
  return (
    <main className="shell listing-detail-page">
      <a className="detail-back" href="/housing">← Back to housing search</a>
      <section className="detail-hero">
        {images.length ? <div className="detail-gallery">
          <div className={`gallery-stage${images.length > 1 ? " has-thumbs" : ""}`}><img src={images[image]} alt={`${listing.name} · photo ${image + 1}`} />{images.length > 1 ? <div className="gallery-thumbs">{images.slice(0, 4).map((src, thumbIndex) => <button className={thumbIndex === image ? "active" : ""} key={src} onClick={() => setImage(thumbIndex)} aria-label={`Show photo ${thumbIndex + 1}`}><img src={src} alt="" /></button>)}</div> : null}</div>
          {images.length > 1 ? <><button className="gallery-arrow prev" onClick={() => setImage((image - 1 + images.length) % images.length)} aria-label="Previous image">‹</button><button className="gallery-arrow next" onClick={() => setImage((image + 1) % images.length)} aria-label="Next image">›</button><span className="gallery-count">{image + 1}/{images.length}</span></> : null}
        </div> : null}
        <div className="detail-copy">
          <div className="wordmark">Super · Housing</div>
          <h1>{listing.name || listing.address}</h1>
          <p className="detail-address">{listing.address} · {listing.borough}</p>
          <div className="detail-price">{listing.rentRange || (listing.rent ? `$${listing.rent.toLocaleString()}/mo` : "Rent not published")}</div>
          <div className="detail-tags">{[listing.unitSize, listing.ami ? `${listing.ami}% AMI` : null, listing.units ? `${listing.units} units` : null].filter(Boolean).map((tag) => <span key={String(tag)}>{tag}</span>)}</div>
          {listing.description ? <p className="detail-description">{listing.description}</p> : null}
          <div className="detail-actions">
            {(listing.applicationUrl || listing.url) ? <a className="checkout" href={listing.applicationUrl || listing.url} target="_blank" rel="noreferrer">View application →</a> : null}
            <button className="go" onClick={scanAndShop} disabled={scanning}>{scanning ? "Scanning…" : "Scan violations & shop"}</button>
          </div>
          {status ? <div className="detail-status">{status}</div> : null}{error ? <div className="error">{error}</div> : null}
        </div>
      </section>

      <section className="detail-map-section"><div><h2>Location</h2><p>{listing.address}</p>{stations.length ? <div className="nearby-transit"><h3>Nearby subway</h3>{stations.map((station) => <div className="station" key={station.name}><span className="route-dots">{station.routes.map((route) => <b key={route} style={subwayColors[route] ?? subwayColors.S}>{route}</b>)}</span><span><strong>{station.name}</strong><small>{station.distanceMiles < .1 ? station.distanceMiles.toFixed(2) : station.distanceMiles.toFixed(1)} mi away</small></span></div>)}</div> : <p className="transit-loading">Finding nearby subway stations…</p>}</div><iframe title={`Map of ${listing.address}`} src={`https://www.google.com/maps?q=${mapQuery}&output=embed`} loading="lazy" referrerPolicy="no-referrer-when-downgrade" /></section>

      {profile ? <section className="detail-record">
        <div className="detail-section-head"><div><h2>Building record</h2><p>{address?.label || listing.address}</p></div><div className={`record-count${profile.openViolations > 100 ? " bad" : ""}`}><b>{profile.openViolations.toLocaleString()}</b><span>open violations</span></div></div>
        {profile.facts ? <div className="detail-facts"><span>Built <b>{profile.facts.yearBuilt}</b></span><span>Floors <b>{profile.facts.floors}</b></span><span>Units <b>{profile.facts.residentialUnits}</b></span></div> : null}
        <div className="detail-signals">{profile.signals.slice(0, 6).map((signal) => <article key={signal.kind}><b>{signal.count} {signal.kind}</b><p>{signal.sample}</p></article>)}</div>
      </section> : null}

      {picks?.length ? <section className="cart detail-shop"><div className="cart-title">Shop for this building</div>{picks.map(({ need, product }) => <div className={`item${product ? "" : " missing"}`} key={need.label}>{product?.image ? <img className="thumb" src={product.image} alt="" /> : <div className="thumb" />}<div className="info"><div className="label">{need.label}</div><div className="name">{product?.title ?? "No match found"}</div><div className="why">{need.reason}</div></div><div className="price">{product ? `$${product.price.toFixed(2)}` : "—"}</div></div>)}</section> : null}
    </main>
  );
}
