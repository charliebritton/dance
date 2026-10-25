// Floor plan: lays a routine's figures end to end round a real-sized room.
// Each figure starts where the last finished, at its book alignment relative to the current line of dance.
// A "Corner" marker means the next figure turns the corner: after it, the line of dance swings 90° left
// (travel is anticlockwise). The first long side runs along the bottom wall heading right, as in the diagrams.
import { parseAlign, simulate } from "./engine.js";
import { S, chartFor, ls, sliceChart, stepRange } from "./core.js";

export const UNITS_PER_M = 150;            // one Standard stride (78 units) ≈ 0.52 m, a real walking step
export const ROOMS = {
  small: { label: "Small hall · 12 × 8 m", w: 12, h: 8 },
  medium: { label: "Studio · 16 × 10 m", w: 16, h: 10 },
  large: { label: "Competition floor · 22 × 14 m", w: 22, h: 14 },
};
const START_IN = { x: 2.2, y: 1.6 };       // metres from the left and bottom walls

export const roomFor = () => ROOMS[ls.get("room", "medium")] || ROOMS.medium;
export const roomSelect = () => `<select class="input auto sm" data-room aria-label="Room size">${Object.entries(ROOMS).map(([k, r]) => `<option value="${k}" ${ROOMS[ls.get("room", "medium")] === r ? "selected" : ""}>${r.label}</option>`).join("")}</select>`;

/** Figures of a routine with their charts (cut to "Steps a–b" when the notes say so) and the marker before each. */
export function routineSegs(r) {
  const segs = []; let mark = "";
  for (const it of r.items) {
    if (it.type === "mark") { mark = it.label; continue; }
    const range = stepRange(it.notes);
    segs.push({ c: it.fig ? sliceChart(chartFor(it.fig), range) : null, range, name: (it.fig && S.figs.get(it.fig)?.name) || it.name, mark, it });
    mark = "";
  }
  return segs;
}

const norm = (h) => ((h % 360) + 360) % 360;
const diff = (a, b) => Math.round(((a - b) % 360 + 540) % 360 - 180);
const f1 = (n) => n.toFixed(1);

export function planRoutine(segs, room, latin) {
  const W = room.w * UNITS_PER_M, H = room.h * UNITS_PER_M;
  let centre = { x: START_IN.x * UNITS_PER_M, y: H - START_IN.y * UNITS_PER_M };
  let rot = 0, prevEnd = null, corners = 0;
  const pieces = [];
  for (const [si, seg] of segs.entries()) {
    const isCorner = /corner/i.test(seg.mark || "");
    if (!seg.c || !(seg.c.man || []).length) {
      pieces.push({ si, pts: [{ ...centre, h: prevEnd ?? 90 + rot }], mark: seg.mark, missing: true });
      if (isCorner) { rot -= 90; corners++; }
      continue;
    }
    const base = latin ? 90 : parseAlign(seg.c.start?.man) ?? 135;
    const h0 = base + rot + (seg.c.turnBefore?.man || 0);
    const sim = simulate(seg.c.man, h0, centre, latin, rot);
    const feet = { L: sim.prints[0], R: sim.prints[1] };
    const pts = [{ ...centre, h: h0, k: -1 }];
    for (const p of sim.prints.slice(2)) {
      feet[p.foot] = p;
      pts.push({ x: (feet.L.x + feet.R.x) / 2, y: (feet.L.y + feet.R.y) / 2, h: p.body ?? p.h, k: p.i });
    }
    // does this figure start the way the last one finished? (skipped for Latin, which isn't danced round the room)
    const jump = !latin && prevEnd != null ? diff(h0, prevEnd) : 0;
    pieces.push({ si, pts, mark: seg.mark, jump, corner: isCorner });
    const last = pts.at(-1);
    centre = { x: last.x, y: last.y };
    prevEnd = last.h;
    // the corner figure is written against the old line of dance; afterwards the room has turned
    if (isCorner) { rot -= 90; corners++; }
  }
  return { pieces, W, H, corners };
}

const outside = (p, W, H) => p.x < 0 || p.y < 0 || p.x > W || p.y > H;

/** Draws the room and the whole path once; later calls with the same plan only move the "you are here" marker. */
export function drawFloor(svg, plan, cur) {
  const { pieces, W, H } = plan;
  if (svg._plan !== plan) {
    svg._plan = plan; svg._si = null;
    const pad = 70, m = UNITS_PER_M;
    svg.setAttribute("viewBox", `${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`);
    let s = `<defs><pattern id="fl-grid" width="${m}" height="${m}" patternUnits="userSpaceOnUse"><path d="M${m} 0H0V${m}" fill="none" stroke="var(--line)" stroke-width="2"/></pattern>
      <marker id="fl-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,1 L9,5 L0,9 z" fill="var(--accent)"/></marker>
      <marker id="fl-lod" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,1 L9,5 L0,9 z" fill="var(--muted)"/></marker></defs>`;
    s += `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#fl-grid)" stroke="var(--ink)" stroke-width="10"/>`;
    const i = 0.7 * m;
    for (const [x1, y1, x2, y2] of [[i * 2, H - i, W - i * 2, H - i], [W - i, H - i * 2, W - i, i * 2], [W - i * 2, i, i * 2, i], [i, i * 2, i, H - i * 2]])
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--muted)" stroke-width="5" stroke-dasharray="18 22" marker-end="url(#fl-lod)" opacity=".5"/>`;
    s += `<text class="fltx" x="${W / 2}" y="${H + 50}" text-anchor="middle">LONG SIDE · LOD →</text>`;
    s += `<text class="fltx" x="${W / 2}" y="-26" text-anchor="middle">← LOD · LONG SIDE</text>`;
    s += `<text class="fltx" transform="translate(${W + 48},${H / 2}) rotate(-90)" text-anchor="middle">SHORT SIDE · LOD →</text>`;
    s += `<text class="fltx" transform="translate(-34,${H / 2}) rotate(90)" text-anchor="middle">SHORT SIDE · LOD →</text>`;
    s += `<text class="fltx small" x="${W - 14}" y="${H - 16}" text-anchor="end">${room(W)} × ${room(H)} m · 1 square = 1 m</text>`;
    let off = false;
    for (const pc of pieces) {
      if (pc.pts.length < 2) continue;
      const d = pc.pts.map((p, k) => `${k ? "L" : "M"}${f1(p.x)},${f1(p.y)}`).join(" ");
      s += `<path class="flpath" data-si="${pc.si}" d="${d}" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linejoin="round" stroke-linecap="round" marker-end="url(#fl-arr)"/>`;
      if (pc.pts.some((p) => outside(p, W, H))) off = true;
    }
    for (const pc of pieces) {
      const p = pc.pts[0];
      if (pc.mark) s += `<g transform="translate(${f1(p.x)},${f1(p.y)})"><rect x="-5" y="-62" width="10" height="40" fill="var(--ink)"/><text class="fltx mk" x="12" y="-46">${pc.mark.toUpperCase()}</text></g>`;
      s += `<g class="flnum" data-si="${pc.si}" transform="translate(${f1(p.x)},${f1(p.y)})"><circle r="20" stroke-width="4"/><text y="9" text-anchor="middle">${pc.si + 1}</text></g>`;
    }
    s += `<g id="flHere"></g>`;
    svg.innerHTML = s;
    svg._off = off;
  }
  const here = svg.querySelector("#flHere");
  if (!cur) { here.innerHTML = ""; return { offFloor: svg._off }; }
  if (svg._si !== cur.si) {
    svg._si = cur.si;
    svg.querySelectorAll(".flpath").forEach((p) => p.classList.toggle("dim", +p.dataset.si > cur.si));
    svg.querySelectorAll(".flnum").forEach((g) => g.classList.toggle("hot", +g.dataset.si === cur.si));
  }
  const pc = pieces.find((x) => x.si === cur.si);
  if (pc) {
    const k = Math.max(0, Math.min(pc.pts.length - 1, cur.k ?? 0)), j = Math.min(pc.pts.length - 1, k + 1);
    const a = pc.pts[k], b = pc.pts[j], t = cur.frac ?? 0;
    here.setAttribute("transform", `translate(${f1(a.x + (b.x - a.x) * t)},${f1(a.y + (b.y - a.y) * t)}) rotate(${f1(a.h + (b.h - a.h) * t)})`);
    if (!here.firstChild) here.innerHTML = `<circle r="30" fill="var(--ink)" opacity=".18"/><path d="M-13,8 L0,-26 L13,8 Z" fill="var(--ink)"/>`;
  }
  return { offFloor: svg._off };
}
const room = (u) => (u / UNITS_PER_M).toFixed(0);
