// Footprint engine: turns a step chart into foot positions, draws them, and animates them to the beat.
// Room convention (Standard): LOD points east (90°), wall is south (180°, bottom of the diagram), centre north.

export const STRIDE = 78, TRACK = 20;
const HEADINGS = { C: 0, DC: 45, LOD: 90, DW: 135, W: 180 };
const AGAINST = { DC: 315, LOD: 270, DW: 225, C: 0, W: 180 };

export function parseAlign(str) {
  if (!str) return null;
  const m = String(str).toUpperCase().match(/\b(F|B|P|FACING|BACKING|POINTING)\s*(DW|DC|LOD|W|C|WALL|CENTRE|CENTER)\b(\s*(AG|AGAINST))?/);
  if (!m) {
    const a = String(str).toUpperCase().match(/^\s*(AGAINST LOD|LOD|DW|DC|W|C)\s*$/);
    if (!a) return null;
    return a[1] === "AGAINST LOD" ? 270 : HEADINGS[a[1]];
  }
  let key = m[2];
  if (key === "WALL") key = "W";
  if (key === "CENTRE" || key === "CENTER") key = "C";
  let h = m[3] ? AGAINST[key] : HEADINGS[key];
  if (m[1][0] === "B") h += 180;
  return ((h % 360) + 360) % 360;
}

const H_NAMES = { 0: "C", 45: "DC", 90: "LOD", 135: "DW", 180: "W", 225: "DW ag LOD", 270: "against LOD", 315: "DC ag LOD" };
const BACKY = new Set(["back", "diagback", "sideback", "backsmall", "backcbmp", "xbehind"]);
export function alignName(h, dir) {
  const n = ((Math.round(h / 45) * 45) % 360 + 360) % 360;
  const approx = Math.abs((((h % 360) + 360) % 360) - n) > 5 ? "≈ " : "";
  if (n === 225 || n === 270 || n === 315) return approx + "Backing " + H_NAMES[(n + 180) % 360];
  if ((n === 0 || n === 180) && BACKY.has(dir)) return approx + "Backing " + H_NAMES[(n + 180) % 360];
  return approx + "Facing " + H_NAMES[n];
}

// [forward amount in strides, sideways amount in px (towards the moving foot's side)]
export const DIRS = {
  fwd: [1, TRACK], back: [-1, TRACK], fwdsmall: [0.5, TRACK], backsmall: [-0.5, TRACK],
  side: [0, 0.62 * STRIDE], sidefwd: [0.28, 0.58 * STRIDE], sideback: [-0.28, 0.58 * STRIDE],
  diagfwd: [0.7, 0.42 * STRIDE], diagback: [-0.7, 0.42 * STRIDE], close: [0, TRACK], tap: [0, TRACK],
  xfront: [0.24, -0.55 * TRACK], xbehind: [-0.24, -0.55 * TRACK], fwdcbmp: [1, 2], backcbmp: [-1, 2], place: null,
};
export const DIR_LABELS = {
  fwd: "Forward", back: "Back", fwdsmall: "Small step forward", backsmall: "Small step back", side: "To side",
  sidefwd: "Side and slightly forward", sideback: "Side and slightly back", diagfwd: "Diagonally forward",
  diagback: "Diagonally back", close: "Close", tap: "Tap (no weight)", xfront: "Cross in front",
  xbehind: "Cross behind", fwdcbmp: "Forward in CBMP", backcbmp: "Back in CBMP", place: "In place / replace",
};
export const MV_OPTS = ["", "LOD", "DW", "DC", "W", "C", "against LOD"];

const rad = (d) => (d * Math.PI) / 180;

export function simulate(steps, startHeading = 0, origin = null, latin = false, rot = 0) {
  let h = startHeading;
  const scale = latin ? 0.7 : 1;
  const ox = origin?.x || 0, oy = origin?.y || 0;
  const r0 = rad(h), rt0 = { x: Math.cos(r0), y: Math.sin(r0) };
  const pos = {
    L: { x: ox - (rt0.x * TRACK) / 2, y: oy - (rt0.y * TRACK) / 2, h },
    R: { x: ox + (rt0.x * TRACK) / 2, y: oy + (rt0.y * TRACK) / 2, h },
  };
  const prints = [
    { foot: "L", ...pos.L, i: -1, w: true },
    { foot: "R", ...pos.R, i: -1, w: true },
  ];
  steps.forEach((s, i) => {
    const prevH = h;
    h += +s.t || 0;
    const M = s.f === "L" ? "L" : "R", S = M === "L" ? "R" : "L", sg = M === "R" ? 1 : -1;
    const from = { ...pos[M] };
    let tx, ty;
    const mvH = s.mv && parseAlign(s.mv) != null ? parseAlign(s.mv) + rot : null;
    if (mvH != null && s.d !== "place") {
      const rv = rad(mvH), k = (s.d === "side" ? 0.7 : 1) * STRIDE * scale;
      tx = pos[S].x + Math.sin(rv) * k;
      ty = pos[S].y - Math.cos(rv) * k;
    } else if (s.d === "place" || !DIRS[s.d]) {
      tx = pos[M].x; ty = pos[M].y;
    } else {
      const [a, b] = DIRS[s.d], r = rad(h);
      const f = { x: Math.sin(r), y: -Math.cos(r) }, rt = { x: Math.cos(r), y: Math.sin(r) };
      const A = a * STRIDE * scale, B = (b > TRACK * 1.5 ? b * scale : b) * sg;
      tx = pos[S].x + f.x * A + rt.x * B;
      ty = pos[S].y + f.y * A + rt.y * B;
    }
    // When the moving foot passes the standing foot (from behind it to in front, or the reverse) it brushes
    // close by it, so its path bends towards the standing foot. Side and closing steps travel directly.
    const rr = rad(h), fw = { x: Math.sin(rr), y: -Math.cos(rr) };
    const ahead = (q) => (q.x - pos[S].x) * fw.x + (q.y - pos[S].y) * fw.y;
    const passes = ahead(from) * ahead({ x: tx, y: ty }) < 0 && Math.abs(ahead(from)) > TRACK * 0.6 && Math.abs(ahead({ x: tx, y: ty })) > TRACK * 0.6;
    // On a big turn (¼ or more) the moving foot comes round the outside of the standing foot with the body,
    // e.g. step 5 of a Natural Turn, instead of cutting past it: its path runs through a point just outside the
    // standing foot, on the moving foot's side of the body as it is halfway through the turn.
    const turn = +s.t || 0;
    let round = null;
    if (Math.abs(turn) >= 90 && !["place", "close", "tap"].includes(s.d)) {
      const mh = rad(prevH + turn / 2), out = { x: Math.cos(mh) * sg, y: Math.sin(mh) * sg };
      round = { x: pos[S].x + out.x * TRACK * 1.5, y: pos[S].y + out.y * TRACK * 1.5 };
    }
    const via = round || (s.d !== "place" && passes
      ? { x: pos[S].x + Math.cos(rr) * sg * TRACK * 0.9, y: pos[S].y + Math.sin(rr) * sg * TRACK * 0.9 } : null);
    pos[M] = { x: tx, y: ty, h };
    prints.push({ foot: M, x: tx, y: ty, h, i, w: s.d !== "tap", fw: s.fw || "", from, via, through: !!round, t: turn, bodyFrom: prevH });
  });
  return { prints };
}

// Shoe-sole outline (right foot, toe up). Left foot is mirrored.
export const FORE = "M-0.8,-18.5 C4.6,-18.6 7.4,-13.6 7,-8 C6.7,-3.8 5.2,-0.6 4.4,2.6 L-3.8,2.6 C-4.8,-0.4 -7.2,-4.2 -6.9,-9.6 C-6.6,-14.8 -4.4,-18.4 -0.8,-18.5 Z";
export const HEEL = "M-3.6,6.4 L4.2,6.4 C4.8,9.8 4.6,14.4 2.8,16.9 C1.4,18.6 -1.6,18.6 -3.1,16.9 C-4.8,14.4 -4.5,9.8 -3.6,6.4 Z";

const lerp = (a, b, t) => a + (b - a) * t;
// quadratic curve: bends towards the standing foot when brushing past it, passes through the outside point on turns
const ctrl = (p) => (p.through ? { x: 2 * p.via.x - (p.from.x + p.x) / 2, y: 2 * p.via.y - (p.from.y + p.y) / 2 } : p.via);
function along(p, u) {
  if (!p.via) return { x: lerp(p.from.x, p.x, u), y: lerp(p.from.y, p.y, u) };
  const c = ctrl(p), a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, d = u * u;
  return { x: a * p.from.x + b * c.x + d * p.x, y: a * p.from.y + b * c.y + d * p.y };
}
function pathD(p, u = 1) {
  if (!p.via) { const e = along(p, u); return `M${f1(p.from.x)},${f1(p.from.y)} L${f1(e.x)},${f1(e.y)}`; }
  if (u >= 1) { const c = ctrl(p); return `M${f1(p.from.x)},${f1(p.from.y)} Q${f1(c.x)},${f1(c.y)} ${f1(p.x)},${f1(p.y)}`; }
  let d = `M${f1(p.from.x)},${f1(p.from.y)}`;
  for (let k = 1; k <= 12; k++) { const q = along(p, (u * k) / 12); d += ` L${f1(q.x)},${f1(q.y)}`; }
  return d;
}
const FRAC = { 45: "⅛", 90: "¼", 135: "⅜", 180: "½", 225: "⅝", 270: "¾", 315: "⅞", 360: "1" };
// curved arrow round the landing foot showing which way and how far the body turns on this step
function turnArc(p, t, color, mk) {
  const R = 31, a0 = p.h - t, a1 = a0 + Math.max(-359, Math.min(359, t));
  const pt = (a) => ({ x: p.x + R * Math.sin(rad(a)), y: p.y - R * Math.cos(rad(a)) });
  const A = pt(a0), B = pt(a1), mid = pt((a0 + a1) / 2);
  const lx = p.x + (R + 11) * Math.sin(rad((a0 + a1) / 2)), ly = p.y - (R + 11) * Math.cos(rad((a0 + a1) / 2));
  const txt = (FRAC[Math.abs(Math.round(t))] || Math.abs(Math.round(t)) + "°") + (t > 0 ? "R" : "L");
  return `<path d="M${f1(A.x)},${f1(A.y)} A${R},${R} 0 ${Math.abs(t) > 180 ? 1 : 0} ${t > 0 ? 1 : 0} ${f1(B.x)},${f1(B.y)}" fill="none" stroke="${color}" stroke-width="1.6" marker-end="url(#${mk})"/>` +
    `<text class="lbl turn" x="${f1(lx)}" y="${f1(ly + 3)}" text-anchor="middle" fill="${color}">${txt}</text>` + (mid ? "" : "");
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => (1 - Math.cos(Math.PI * t)) / 2;
const f1 = (n) => n.toFixed(1);

// Moore's convention: the left foot is drawn in outline, the right foot solid.
function foot(p, x, y, h, { fill, stroke, sw = 1.2, op = 1, dash = "", lift = 0, contact = null }) {
  const mir = p.foot === "L" ? -1 : 1, sc = 1 + lift * 0.1;
  if (p.foot === "L" && fill !== "none") { stroke = fill; fill = "var(--surface)"; sw = Math.max(sw + 0.6, 2); }
  else if (p.foot === "L") sw = Math.max(sw, 1.6);
  const shadow = lift > 0.02 ? `<g transform="translate(${f1(x + 3 * lift)},${f1(y + 4 * lift)}) rotate(${f1(h)}) scale(${mir},1)" opacity="${0.18 * lift}"><path d="${FORE}" fill="var(--ink)"/><path d="${HEEL}" fill="var(--ink)"/></g>` : "";
  const d = dash ? `stroke-dasharray="${dash}"` : "";
  return shadow + `<g transform="translate(${f1(x)},${f1(y)}) rotate(${f1(h)}) scale(${mir * sc},${sc})" opacity="${op}">` +
    `<path d="${FORE}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${d}/>` +
    `<path d="${HEEL}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${d}/>` +
    (contact ? `<circle cx="0" cy="${contact === "heel" ? 12 : -11}" r="2.8" fill="var(--ink)" stroke="var(--surface)" stroke-width="1.2"/>` : "") +
    `</g>`;
}

function label(p, txt, hot, color) {
  const r = rad(p.h), side = p.foot === "L" ? -1 : 1;
  const lx = p.x + Math.cos(r) * side * 17, ly = p.y + Math.sin(r) * side * 17, w = 8 + txt.length * 6.2;
  return `<g transform="translate(${f1(lx)},${f1(ly)})"><rect x="${-w / 2}" y="-7.5" width="${w}" height="15" rx="2" fill="${hot ? "var(--ink)" : "var(--surface)"}" stroke="${color}"/>` +
    `<text class="lbl" text-anchor="middle" y="3.6" fill="${hot ? "var(--surface)" : "var(--ink)"}">${txt}</text></g>`;
}

function bounds(layers, min = 200) {
  const pts = layers.flatMap((l) => l.sim.prints);
  let x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
  let y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
  const pad = 34; x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  if (x1 - x0 < min) { const c = (x0 + x1) / 2; x0 = c - min / 2; x1 = c + min / 2; }
  if (y1 - y0 < min) { const c = (y0 + y1) / 2; y0 = c - min / 2; y1 = c + min / 2; }
  return { x0, x1, y0, y1 };
}

let uid = 0;
/**
 * Draw one frame. layers: [{sim, color, tag?}]. pos: -1 shows every step; otherwise step index + progress
 * through that step (2.5 = halfway through step 3). opt.room draws the wall, centre and LOD.
 */
export function drawFrame(svg, layers, pos, opt = {}) {
  if (!layers.length || !layers[0].sim.prints.length) { svg.innerHTML = ""; return; }
  const key = layers.map((l) => l.sim.prints.length + ":" + l.sim.prints.map((p) => f1(p.x) + f1(p.y)).join()).join("|") + !!opt.room;
  if (svg._key !== key) {
    const b = bounds(layers, opt.min);
    if (opt.room) { b.y0 -= 14; b.y1 += 18; }
    svg._b = b; svg._key = key; svg._id = "e" + ++uid;
    svg.setAttribute("viewBox", `${f1(b.x0)} ${f1(b.y0)} ${f1(b.x1 - b.x0)} ${f1(b.y1 - b.y0)}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }
  const { x0, x1, y0, y1 } = svg._b, id = svg._id;
  let s = `<defs><pattern id="${id}p" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="var(--line)" stroke-width=".7"/></pattern>` +
    layers.map((l, k) => `<marker id="${id}m${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" fill="${l.color}"/></marker>`).join("") + `</defs>` +
    `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="url(#${id}p)"/>`;
  if (opt.room) {
    s += `<line class="room" x1="${x0 + 6}" y1="${y1 - 12}" x2="${x1 - 6}" y2="${y1 - 12}" stroke-width="2"/>` +
      `<line class="room" x1="${x0 + 6}" y1="${y1 - 8}" x2="${x1 - 6}" y2="${y1 - 8}" stroke-width=".8"/>` +
      `<text class="roomtx" x="${(x0 + x1) / 2}" y="${y1 - 1}" text-anchor="middle">WALL</text>` +
      `<text class="roomtx" x="${(x0 + x1) / 2}" y="${y0 + 11}" text-anchor="middle">CENTRE</text>` +
      `<g transform="translate(${x1 - 60},${y0 + 8})"><line class="room" x1="0" y1="0" x2="42" y2="0" stroke-width="1.4"/><path d="M42,0 l-6,-3.5 v7 z" fill="var(--muted)"/><text class="roomtx" x="0" y="12">LOD</text></g>`;
  }
  const live = pos >= 0;
  const cur = live ? Math.floor(pos) : -1, u = live ? pos - cur : 1;
  const e = live ? ease(clamp(u / 0.9, 0, 1)) : 1;

  layers.forEach((l, li) => {
    const { prints } = l.sim, c = l.color, mk = `${id}m${li}`;
    const track = (p, op, u = 1, dash = true) => p.from && (Math.hypot(p.x - p.from.x, p.y - p.from.y) > 3)
      ? `<path class="trk${dash ? "" : " solid"}" d="${pathD(p, u)}" stroke="${c}" opacity="${op}" ${u >= 1 ? `marker-end="url(#${mk})"` : ""}/>` : "";
    if (!live) {
      for (const p of prints) s += track(p, 0.6);
      for (const p of prints) if (Math.abs(p.t || 0) >= 90) s += turnArc(p, p.t, c, mk);
      for (const p of prints) {
        s += p.i < 0 ? foot(p, p.x, p.y, p.h, { fill: "none", stroke: c, dash: "2 2", op: 0.8 })
          : foot(p, p.x, p.y, p.h, { fill: p.w ? c : "none", stroke: c, dash: p.w ? "" : "2 1.5", op: 0.9 });
      }
      s += labels(prints, -1, c);
      if (l.tag) s += `<text class="lbl" x="${f1((prints[0].x + prints[1].x) / 2)}" y="${f1(prints[0].y + 32)}" text-anchor="middle" fill="${c}">${l.tag}</text>`;
      return;
    }
    const m = prints.find((p) => p.i === cur);
    const placed = prints.filter((p) => p.i < cur);
    const latest = {};
    for (const p of placed) latest[p.foot] = p;
    // trail of earlier steps, fading with age
    for (const p of placed) if (p.i >= cur - 3) s += track(p, Math.max(0.15, 0.45 - (cur - p.i) * 0.1));
    for (const p of placed) {
      if (m && p === latest[m.foot]) continue;   // this foot is the one moving now
      const age = cur - p.i, isStance = latest[p.foot] === p;
      if (p.i < 0) { s += foot(p, p.x, p.y, p.h, { fill: isStance ? c : "none", stroke: c, dash: isStance ? "" : "2 2", op: isStance ? 0.85 : 0.35 }); continue; }
      s += foot(p, p.x, p.y, p.h, { fill: p.w ? c : "none", stroke: c, op: isStance ? 0.85 : Math.max(0.12, 0.5 - age * 0.09) });
    }
    if (m) {
      const at = along(m, e), fx = at.x, fy = at.y, fh = lerp(m.from.h, m.h, e);
      const lift = Math.sin(Math.PI * e);
      // where the foot is going, and its path so far
      if (e < 1) s += foot(m, m.x, m.y, m.h, { fill: "none", stroke: c, dash: "2 2", op: 0.55 });
      s += track(m, 0.45) + track(m, 1, e, false);
      if (Math.abs(m.t) >= 45) s += turnArc({ ...m, h: m.h - m.t + m.t * e }, m.t * e || 0.01, c, mk);
      const landed = e >= 0.98;
      s += foot(m, fx, fy, fh, { fill: m.w ? c : "none", stroke: "var(--ink)", sw: 1.6, lift, dash: m.w ? "" : "2 1.5",
        contact: landed || e > 0.8 ? (/^H/.test(m.fw) ? "heel" : "ball") : null });
    }
    s += labels(prints.filter((p) => p.i < cur || (p === m && e > 0.9)), cur, c);
    if (l.tag) s += `<text class="lbl" x="${f1((prints[0].x + prints[1].x) / 2)}" y="${f1(prints[0].y + 32)}" text-anchor="middle" fill="${c}">${l.tag}</text>`;
  });
  svg.innerHTML = s;
}

function labels(prints, cur, color) {
  const groups = new Map();
  for (const p of prints) {
    if (p.i < 0) continue;
    const k = p.foot + Math.round(p.x / 6) + "," + Math.round(p.y / 6);
    if (!groups.has(k)) groups.set(k, { p, ns: [] });
    groups.get(k).ns.push(p.i + 1);
  }
  let s = "";
  for (const { p, ns } of groups.values()) s += label(p, ns.join("·"), ns.includes(cur + 1), color);
  return s;
}

// ── metronome + beat clock ─────────────────────────────────────────────────
let actx = null;
function audio() {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    return actx;
  } catch { return null; }
}
export function click(accent) {
  const a = audio(); if (!a) return;
  const o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
  o.type = "square"; o.frequency.value = accent ? 1480 : 920;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(accent ? 0.22 : 0.12, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(a.destination); o.start(t); o.stop(t + 0.06);
}

/** A clock over a list of events [{start, dur}] in beats. onTick(index, progressWithinEvent). */
export function makePlayer(onTick) {
  let raf = 0, t0 = 0, base = 0, ev = [], total = 0, msPerBeat = 600, playing = false, lastBeat = -1;
  let bpb = 4, loop = true, metro = true, onEnd = null;
  const idxAt = (b) => { for (let i = ev.length - 1; i >= 0; i--) if (b >= ev[i].start - 1e-6) return i; return 0; };
  function frame(now) {
    let b = base + (now - t0) / msPerBeat;
    if (b >= total) {
      if (loop) { base = 0; t0 = now; b = 0; lastBeat = -1; }
      else { b = total - 1e-4; stop(); const i = ev.length - 1; onTick(i, 1); onEnd?.(); return; }
    }
    const fb = Math.floor(b + 1e-6);
    if (fb !== lastBeat) { lastBeat = fb; if (metro) click(fb % bpb === 0); }
    const i = idxAt(b);
    onTick(i, clamp((b - ev[i].start) / ev[i].dur, 0, 1));
    raf = requestAnimationFrame(frame);
  }
  function stop() { playing = false; cancelAnimationFrame(raf); }
  return {
    load(events, o) {
      stop(); ev = events; total = events.reduce((a, e) => Math.max(a, e.start + e.dur), 0);
      msPerBeat = 60000 / (o.bpm || 90); bpb = o.bpb || 4; loop = o.loop !== false; metro = o.metro !== false;
      onEnd = o.onEnd || null; base = 0; lastBeat = -1;
    },
    set(o) {
      if ("metro" in o) metro = o.metro;
      if ("loop" in o) loop = o.loop;
      if ("bpm" in o) { const now = performance.now(); if (playing) { base += (now - t0) / msPerBeat; t0 = now; } msPerBeat = 60000 / o.bpm; }
    },
    play(fromIdx) {
      if (metro) audio();
      if (fromIdx != null && ev[fromIdx]) base = ev[fromIdx].start;
      lastBeat = Math.floor(base) - 1; t0 = performance.now(); playing = true;
      cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
    },
    pause() { if (!playing) return; base += (performance.now() - t0) / msPerBeat; stop(); },
    seek(i) { if (ev[i]) base = ev[i].start; lastBeat = Math.floor(base) - 1; if (playing) t0 = performance.now(); },
    get playing() { return playing; },
  };
}
