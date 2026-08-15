"use client";

// Axonometric massing of the actual building, extruded from NYC's real footprint
// polygon and roof height. Floors are tinted by how many open violations were
// filed on them, which is the point: it shows *where* the building hurts.
//
// Pure SVG, no dependencies — it reads as a technical drawing, which matches the
// rest of the page better than a rendered 3D object would.

import type { Footprint, FloorBreakdown } from "@/lib/types";

const W = 260;
const H = 210;
const PAD = 18;

// Isometric-ish: 30° axes.
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = Math.sin(Math.PI / 6);
const FT_TO_M = 0.3048;

type Props = {
  footprint: Footprint;
  floorCount: number;
  breakdown: FloorBreakdown;
};

export default function Massing({ footprint, floorCount, breakdown }: Props) {
  const ring = footprint.ring;
  if (ring.length < 3) return null;

  // Drop a duplicated closing vertex so edges aren't drawn twice.
  const pts = ring.slice();
  const [fx, fy] = pts[0];
  const [lx, ly] = pts[pts.length - 1];
  if (fx === lx && fy === ly) pts.pop();
  if (pts.length < 3) return null;

  const floors = Math.max(1, Math.min(floorCount || 1, 60));

  // lon/lat -> local metres, centred on the footprint.
  const lon0 = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const local = pts.map(([lon, lat]) => ({
    x: (lon - lon0) * 111320 * cosLat,
    y: (lat - lat0) * 110540,
  }));

  const totalH = (footprint.heightRoof || floors * 10) * FT_TO_M;
  const floorH = totalH / floors;

  const proj = (x: number, y: number, z: number) => ({
    sx: (x - y) * COS30,
    sy: (x + y) * SIN30 - z,
  });

  // Fit: project every corner at both z extremes, then scale into the viewBox.
  const probe = [
    ...local.map((p) => proj(p.x, p.y, 0)),
    ...local.map((p) => proj(p.x, p.y, totalH)),
  ];
  const minX = Math.min(...probe.map((p) => p.sx));
  const maxX = Math.max(...probe.map((p) => p.sx));
  const minY = Math.min(...probe.map((p) => p.sy));
  const maxY = Math.max(...probe.map((p) => p.sy));
  const scale = Math.min((W - PAD * 2) / (maxX - minX || 1), (H - PAD * 2) / (maxY - minY || 1));
  const offX = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (H - (maxY - minY) * scale) / 2 - minY * scale;

  const P = (x: number, y: number, z: number) => {
    const { sx, sy } = proj(x, y, z);
    return [sx * scale + offX, sy * scale + offY] as const;
  };

  const maxCount = Math.max(1, ...Object.values(breakdown.counts));

  // Normalise to counter-clockwise so outward normals are predictable.
  const area2 = local.reduce((a, p, i) => {
    const q = local[(i + 1) % local.length];
    return a + (p.x * q.y - q.x * p.y);
  }, 0);
  const ccw = area2 > 0 ? local : [...local].reverse();

  // Every wall is drawn, sorted far-to-near, and painted opaquely so near walls
  // cover far ones. Culling back faces instead leaves holes in the silhouette on
  // concave footprints (this building is an L-shaped rowhouse), which made the
  // roof look detached. This projection views along (1,1,1), so larger x+y is
  // nearer and ascending depth is back-to-front.
  const ordered = ccw
    .map((p, i) => {
      const q = ccw[(i + 1) % ccw.length];
      return { p, q, depth: (p.x + p.y + q.x + q.y) / 2 };
    })
    .sort((a, b) => a.depth - b.depth);

  // Opaque tint: white -> alert red. Transparency would let walls bleed through.
  const tint = (t: number) =>
    t <= 0
      ? "#ffffff"
      : `rgb(${Math.round(255 + (192 - 255) * t)},${Math.round(255 + (57 - 255) * t)},${Math.round(255 + (43 - 255) * t)})`;

  const slabs = [];
  for (let f = 0; f < floors; f++) {
    const zb = f * floorH;
    const zt = (f + 1) * floorH;
    const count = breakdown.counts[f + 1] ?? 0;
    // Tint by share of the worst floor; 0 stays plain white.
    const fill = tint(count ? 0.14 + 0.62 * (count / maxCount) : 0);

    slabs.push(
      <g
        key={f}
        className="slab"
        style={{ animationDelay: `${f * 90}ms` }}
        data-floor={f + 1}
      >
        {ordered.map(({ p, q }, i) => {
          const a = P(p.x, p.y, zb);
          const b = P(q.x, q.y, zb);
          const c = P(q.x, q.y, zt);
          const d = P(p.x, p.y, zt);
          return (
            <polygon
              key={i}
              points={`${a} ${b} ${c} ${d}`}
              fill={fill}
              stroke="var(--ink)"
              strokeWidth={0.6}
              strokeLinejoin="round"
            />
          );
        })}
      </g>
    );
  }

  // Roof cap, drawn last so it sits above every wall.
  const roof = ccw.map((p) => P(p.x, p.y, totalH).join(",")).join(" ");

  return (
    <svg
      className="massing"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Massing of the building, ${floors} floors`}
    >
      {slabs}
      <polygon
        className="slab roof"
        style={{ animationDelay: `${floors * 90}ms` }}
        points={roof}
        fill="#ffffff"
        stroke="var(--ink)"
        strokeWidth={0.9}
        strokeLinejoin="round"
      />
    </svg>
  );
}
