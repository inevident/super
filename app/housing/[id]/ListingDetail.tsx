"use client";

import { useEffect, useState } from "react";
import type { Listing } from "@/lib/listings";
import { subwayLineStyle } from "@/lib/subway";

export default function ListingDetail({ listing }: { listing: Listing }) {
  const images = listing.imageUrls?.length ? listing.imageUrls : listing.imageUrl ? [listing.imageUrl] : [];
  const [image, setImage] = useState(0);
  const [stations, setStations] = useState<{ name: string; routes: string[]; distanceMiles: number }[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/nearby-transit?address=${encodeURIComponent(`${listing.address}, ${listing.borough}`)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Transit lookup failed")))
      .then((data) => setStations(data.stations ?? []))
      .catch((cause) => { if (cause?.name !== "AbortError") setStations([]); });
    return () => controller.abort();
  }, [listing.address, listing.borough]);

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
            {(listing.applicationUrl || listing.url) ? <a className="legacy-apply" href={listing.applicationUrl || listing.url} target="_blank" rel="noreferrer">View source listing ↗</a> : <span className="legacy-unavailable">Application link unavailable</span>}
            <a className="legacy-market-link" href="/">Search live Housing Connect</a>
          </div>
        </div>
      </section>

      <section className="detail-map-section"><div><h2>Location</h2><p>{listing.address}</p>{stations.length ? <div className="nearby-transit"><h3>Nearby subway</h3>{stations.map((station) => <div className="station" key={station.name}><span className="route-dots">{station.routes.map((route) => <b key={route} style={subwayLineStyle(route)}>{route}</b>)}</span><span><strong>{station.name}</strong><small>{station.distanceMiles < .1 ? station.distanceMiles.toFixed(2) : station.distanceMiles.toFixed(1)} mi away</small></span></div>)}</div> : <p className="transit-loading">Finding nearby subway stations…</p>}</div><iframe title={`Map of ${listing.address}`} src={`https://www.google.com/maps?q=${mapQuery}&output=embed`} loading="lazy" referrerPolicy="no-referrer-when-downgrade" /></section>

    </main>
  );
}
