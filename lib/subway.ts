export function normalizeSubwayLines(lines: string[]) {
  return [...new Set(lines.map((line) => line.trim().toUpperCase()).filter(Boolean))];
}

export function subwayLineStyle(line: string) {
  const normalized = line.trim().toUpperCase();
  if (/^[123]$/.test(normalized)) return { background: "#EE352E", color: "#fff" };
  if (/^[456]$/.test(normalized)) return { background: "#00933C", color: "#fff" };
  if (normalized === "7") return { background: "#B933AD", color: "#fff" };
  if (/^[ACE]$/.test(normalized)) return { background: "#0039A6", color: "#fff" };
  if (/^[BDFM]$/.test(normalized)) return { background: "#FF6319", color: "#fff" };
  if (normalized === "G") return { background: "#6CBE45", color: "#fff" };
  if (/^[JZ]$/.test(normalized)) return { background: "#996633", color: "#fff" };
  if (/^[LS]$/.test(normalized)) return { background: "#A7A9AC", color: "#111" };
  if (/^[NQRW]$/.test(normalized)) return { background: "#FCCC0A", color: "#111" };
  return { background: "#555", color: "#fff" };
}
