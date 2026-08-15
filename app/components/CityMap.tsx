"use client";

// Citywide violation heat map. Every building with open violations, drawn as a
// column whose height and colour track how many. Drag to orbit.
//
// Canvas 2D with a hand-rolled orthographic projection rather than a 3D library:
// a few thousand columns sort and draw comfortably per frame, and it keeps the
// same line-drawing language as the rest of the app.

import { useEffect, useMemo, useRef, useState } from "react";

type Streets = { segments: number; points: number; xs: number[]; ys: number[]; lens: number[] };

type City = {
  count: number;
  total: number;
  boros: string[];
  lat: number[];
  lon: number[];
  n: number[];
  boro: number[];
};

const PITCH_MIN = 0.18;
const PITCH_MAX = 0.95;

export default function CityMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [city, setCity] = useState<City | null>(null);
  const [streets, setStreets] = useState<Streets | null>(null);
  const [err, setErr] = useState("");
  const [hover, setHover] = useState<string>("");

  // Kept in a ref so dragging never triggers a React re-render.
  // Radius-fit guarantees no clipping at any rotation, but NYC is elongated so the
  // circle leaves wide margins. Default zoom compensates; the user can pull back.
  const view = useRef({ yaw: -0.6, pitch: 0.5, zoom: 1.45, dragging: false, lx: 0, ly: 0 });

  useEffect(() => {
    // Static snapshot first: the live aggregation is a full-table scan on NYC's
    // side and takes 15-25s cold, which reads as "broken" on stage. The snapshot
    // is served by Next as a plain file, so it paints immediately and works with
    // no network. Falls back to the live route if the file is missing.
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/citymap.json", { cache: "force-cache" });
        if (r.ok) {
          const d = await r.json();
          if (!cancelled && d?.count) return setCity(d);
        }
      } catch {}
      try {
        const r = await fetch("/api/citymap?limit=4000");
        const d = await r.json();
        if (!cancelled) d.error ? setErr(d.error) : setCity(d);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    })();
    // Street grid is a progressive enhancement: if it is missing or slow the map
    // still renders on the abstract lattice.
    (async () => {
      try {
        const r = await fetch("/streets.json", { cache: "force-cache" });
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled && d?.points) setStreets(d);
      } catch {}
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Rasterise the street grid once into an offscreen canvas. Stroking 112k
  // segments per frame would be far too slow; the ground plane's projection is a
  // pure affine map, so it can be drawn once here and merely *placed* per frame.
  const layer = useMemo(() => {
    if (!streets) return null;
    // Sized near display scale on purpose. At 4096 the layer is shrunk ~12x to
    // fit the canvas, thinning a 1px stroke to 0.09px and erasing the grid
    // entirely. 2048 keeps strokes visible at rest and sharp enough zoomed in.
    const SIZE = 2048;
    const { xs, ys, lens } = streets;

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < x0) x0 = xs[i];
      if (xs[i] > x1) x1 = xs[i];
      // ys arrive from the preprocessor in +lat space; negate to match north-up.
      const y = -ys[i];
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const k = SIZE / Math.max(x1 - x0, y1 - y0);

    const off = document.createElement("canvas");
    off.width = SIZE;
    off.height = SIZE;
    const g = off.getContext("2d");
    if (!g) return null;

    g.strokeStyle = "rgba(10,10,10,0.62)";
    g.lineWidth = 2.2;
    g.lineCap = "round";
    g.beginPath();
    let p = 0;
    for (const len of lens) {
      for (let j = 0; j < len; j++, p++) {
        const px = (xs[p] - x0) * k;
        const py = (-ys[p] - y0) * k;
        if (j === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
    }
    g.stroke();

    return { canvas: off, x0, y0, k };
  }, [streets]);

  useEffect(() => {
    if (!city) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Project lon/lat to local metres once, centred on the data.
    const lat0 = city.lat.reduce((a, b) => a + b, 0) / city.count;
    const lon0 = city.lon.reduce((a, b) => a + b, 0) / city.count;
    const cosLat = Math.cos((lat0 * Math.PI) / 180);
    const xs = city.lon.map((lo) => (lo - lon0) * 111320 * cosLat);
    // North up: screen y grows downward, so latitude has to be negated.
    const ys = city.lat.map((la) => -(la - lat0) * 110540);

    const maxN = Math.max(...city.n);
    // Height on a power curve so the median stays short and only genuine
    // outliers spike; colour on log so the low end is still distinguishable.
    // Log height made every column tall and the city read as a wall of red.
    const hs = city.n.map((v) => Math.pow(v / maxN, 0.55));
    const ts = city.n.map((v) => Math.log1p(v) / Math.log1p(maxN));

    // Centre on the bounding box, not the mean — the mean is dragged south by
    // dense Brooklyn/Bronx and parks the city low-left in the frame. Then size
    // by the enclosing radius so it still fits at any rotation.
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    for (let i = 0; i < xs.length; i++) {
      xs[i] -= cx;
      ys[i] -= cy;
    }
    const radius = Math.max(...xs.map((x, i) => Math.hypot(x, ys[i])));
    const bx0 = Math.min(...xs);
    const bx1 = Math.max(...xs);
    const by0 = Math.min(...ys);
    const by1 = Math.max(...ys);

    let raf = 0;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const { yaw, pitch, zoom } = view.current;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      const scale = ((Math.min(W, H) / (2.15 * radius)) * zoom) || 1;
      const colH = Math.min(W, H) * 0.17;

      // Rotate, then flatten by pitch. Depth is the rotated y, so sorting on it
      // draws back-to-front without a z-buffer.
      const idx = new Array(city.count);
      const px = new Float32Array(city.count);
      const py = new Float32Array(city.count);
      const depth = new Float32Array(city.count);

      for (let i = 0; i < city.count; i++) {
        const rx = xs[i] * cos - ys[i] * sin;
        const ry = xs[i] * sin + ys[i] * cos;
        px[i] = W / 2 + rx * scale;
        py[i] = H * 0.58 + ry * scale * pitch;
        depth[i] = ry;
        idx[i] = i;
      }
      idx.sort((a, b) => depth[a] - depth[b]);

      // Ground plane, drawn before the columns so they stand on it.
      const gp = (gx: number, gy: number) => {
        const rx = gx * cos - gy * sin;
        const ry = gx * sin + gy * cos;
        return [W / 2 + rx * scale, H * 0.58 + ry * scale * pitch] as const;
      };

      if (layer) {
        // Compose offscreen-pixel space -> world metres -> screen into one
        // affine transform, so the entire street grid costs a single drawImage.
        const { k, x0, y0 } = layer;
        const a = (scale * cos) / k;
        const b = (scale * pitch * sin) / k;
        const c = (-scale * sin) / k;
        const d = (scale * pitch * cos) / k;
        const e = scale * (cos * x0 - sin * y0) + W / 2;
        const f = scale * pitch * (sin * x0 + cos * y0) + H * 0.58;
        ctx.save();
        ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
        ctx.drawImage(layer.canvas, 0, 0);
        ctx.restore();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else {
        // Fallback lattice when the street snapshot is unavailable.
        const GRID_M = 2000;
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(10,10,10,0.075)";
        ctx.beginPath();
        for (let gx = Math.ceil(bx0 / GRID_M) * GRID_M; gx <= bx1; gx += GRID_M) {
          const a2 = gp(gx, by0);
          const b2 = gp(gx, by1);
          ctx.moveTo(a2[0], a2[1]);
          ctx.lineTo(b2[0], b2[1]);
        }
        for (let gy = Math.ceil(by0 / GRID_M) * GRID_M; gy <= by1; gy += GRID_M) {
          const a2 = gp(bx0, gy);
          const b2 = gp(bx1, gy);
          ctx.moveTo(a2[0], a2[1]);
          ctx.lineTo(b2[0], b2[1]);
        }
        ctx.stroke();
      }

      const w = Math.max(1.1, 1.9 * zoom);
      for (const i of idx) {
        const h = hs[i] * colH;
        const t = ts[i];
        const x = px[i];
        const y = py[i];
        if (x < -40 || x > W + 40 || y < -40 || y > H + 240) continue;

        // white -> alert red, matching the dossier's palette
        const r = Math.round(255 + (192 - 255) * t);
        const g = Math.round(255 + (57 - 255) * t);
        const b = Math.round(255 + (43 - 255) * t);

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x - w / 2, y - h, w, h);
        // Cap catches the light and gives the columns a top edge.
        ctx.fillStyle = `rgba(10,10,10,0.30)`;
        ctx.fillRect(x - w / 2, y - h, w, Math.max(0.7, w * 0.36));
      }

      raf = 0;
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    draw();

    const onDown = (e: PointerEvent) => {
      view.current.dragging = true;
      view.current.lx = e.clientX;
      view.current.ly = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const v = view.current;
      if (!v.dragging) return;
      v.yaw += (e.clientX - v.lx) * 0.006;
      v.pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, v.pitch + (e.clientY - v.ly) * 0.004));
      v.lx = e.clientX;
      v.ly = e.clientY;
      schedule();
    };
    const onUp = (e: PointerEvent) => {
      view.current.dragging = false;
      canvas.releasePointerCapture?.(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      v.zoom = Math.max(0.5, Math.min(6, v.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
      schedule();
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [city, layer]);

  return (
    <section className="citymap">
      <div className="citymap-head">
        <span className="floors-title">
          {city
            ? `Open violations citywide · ${city.total.toLocaleString()} across ${city.count.toLocaleString()} buildings`
            : err
              ? "City map unavailable"
              : "Loading citywide record…"}
        </span>
        <span className="citymap-hint">drag to orbit · scroll to zoom</span>
      </div>
      <canvas ref={canvasRef} className="citymap-canvas" />
      {err && <div className="error">{err}</div>}
    </section>
  );
}
