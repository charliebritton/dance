// Shared state, API calls, syllabus helpers and small UI utilities used by every view.
import { parseAlign, simulate, STRIDE, TRACK } from "./engine.js";

// Where the app is mounted (e.g. "/dance" behind chza.me/dance); the server writes it into <html data-base>.
export const BASE = (document.documentElement.dataset.base || "").replace(/\/$/, "");
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const slug = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const ls = {
  get(k, d) { try { const v = localStorage.getItem("rf." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("rf." + k, JSON.stringify(v)); } catch {} },
};

export const S = {
  me: null, groups: [], users: [], routines: [], charts: {}, verified: {}, notes: {}, comment_counts: {}, videos: [],
  lessons: [], competitions: [], requests: [],
  levels: [], syllabi: [], dances: [], starter: {}, figs: new Map(),
  role: ls.get("role", null),
  syl: ls.get("syl", "istd"),   // which syllabus the figure list shows: "istd" | "bdc"
};
// who may do what (the server checks every write too)
export const isMember = () => !!S.me;
export const isCommittee = () => ["committee", "admin"].includes(S.me?.role);
export const isAdmin = () => S.me?.role === "admin";
export const canUseAI = () => !!S.me?.ai;
/** The "Steps for" switch: your own choice, else your Lead/Follow preference. */
export const roleDefault = () => ({ lead: "man", follow: "lady" })[S.me?.dance_role] || "man";
export const hooks = { render: () => {} };

// ── API ───────────────────────────────────────────────────────────────
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
export async function api(method, path, body) {
  const opt = { method, headers: {}, credentials: "same-origin" };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(BASE + path, opt); } catch { throw new ApiError(0, "You're offline. Check your connection and try again"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = typeof data.detail === "string" ? data.detail : "Something went wrong. Try again";
    throw new ApiError(r.status, msg);
  }
  return data;
}

export async function loadSyllabus() {
  const syl = await api("GET", "/api/syllabus");
  S.levels = syl.levels; S.syllabi = syl.syllabi; S.dances = syl.dances; S.starter = syl.charts;
  for (const d of S.dances) {
    for (const L of S.levels) for (const n of d.levels[L]) {
      const id = d.id + "." + slug(n);
      S.figs.set(id, { id, dance: d.id, name: n, level: L, bdc: false, slug: slug(n) });
    }
    for (const n of d.bdc) {
      const id = d.id + "." + slug(n), f = S.figs.get(id);
      if (f) f.bdc = true; else S.figs.set(id, { id, dance: d.id, name: n, level: null, bdc: true, slug: slug(n) });
    }
  }
}

// ── syllabi: ISTD medal levels, or the BDC restricted syllabus (one list) ──
export const sylOf = (id) => S.syllabi.find((s) => s.id === id) || S.syllabi[0];
/** {level: figure names} for a dance in a syllabus. */
export const figLists = (d, sid) => (sid === "bdc" ? { Restricted: d.bdc } : d.levels);
/** The lists a routine may use: its syllabus, up to its level. */
export function routineLists(r) {
  const d = danceOf(r.dance), all = figLists(d, r.syllabus), names = Object.keys(all);
  const upto = names.includes(r.level) ? names.slice(0, names.indexOf(r.level) + 1) : names;
  return Object.fromEntries(upto.map((L) => [L, all[L]]));
}
export const levelLabel = (r) => (r.syllabus === "bdc" ? "BDC syllabus" : r.level);
/** "ISTD Bronze" / "BDC restricted" as one choice, for routine forms. */
export const sylLevelOptions = (r) => S.syllabi.flatMap((s) => s.levels.map((L) => {
  const val = `${s.id}:${L}`, on = r && (r.syllabus || "istd") === s.id && r.level === L;
  return `<option value="${val}" ${on ? "selected" : ""}>${s.id === "bdc" ? "BDC syllabus" : `${s.name} ${L}`}</option>`;
})).join("");
export const parseSylLevel = (v) => { const [syllabus, level] = String(v).split(":"); return { syllabus, level }; };
/** A figure's medal (ISTD level) or, for figures only in the BDC list, a BDC tag. */
export const figTag = (f) => (f.level ? `<span class="medal m-${f.level}"></span> ${f.level}` : `<span class="bdctag">BDC</span> BDC only`);

export async function loadMe() {
  const r = await api("GET", "/api/me");
  S.me = r.me; S.groups = r.groups;
  if (!S.role) S.role = roleDefault();
}

const EMPTY = { users: [], routines: [], notes: {}, comment_counts: {}, videos: [], lessons: [], competitions: [], requests: [] };
export async function refresh() {
  const st = await api("GET", "/api/state");
  Object.assign(S, EMPTY, st);
  if (st.groups) S.groups = st.groups;
}

export const groupName = (id) => S.groups.find((g) => g.id === id)?.name || "All groups";
/** Lessons in which a figure was covered, newest first (members only). */
export const coveredIn = (figId) => S.lessons.filter((l) => l.figures.includes(figId));
export const myGroupLessons = () => S.lessons.filter((l) => !l.group_id || !S.me?.groups.length || S.me.groups.includes(l.group_id));

// ── syllabus helpers ──────────────────────────────────────────────────
export const DARK_ON = new Set(["scarlet", "blue"]);
export const danceOf = (id) => S.dances.find((d) => d.id === id);
export const figByName = (danceId, name) => S.figs.get(danceId + "." + slug(name || "")) || null;
export const chartFor = (figId) => {
  const c = S.charts[figId];
  if (c) return c;
  const b = S.starter[figId];
  return b ? { src: "starter", ...b } : null;
};
export const chartBeats = (c) => (c ? (c.man || []).reduce((a, s) => a + (+s.b || 0), 0) : 0);
export const userName = (id) => (id && id === S.me?.id ? "You" : S.users.find((u) => u.id === id)?.name || "Someone");
export const roleWord = (r) => (r === "lady" ? "Follower" : "Leader");
export const tempoMid = (d) => (d.tempo[0] + d.tempo[1]) / 2;
export const fmtBeats = (b) => ({ 0.25: "¼", 0.5: "½", 0.75: "¾", 1: "1", 1.5: "1½", 2: "2" })[+b] || String(b);
export function fmtDate(t) { try { return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" }); } catch { return ""; } }
/** "2026-11-02" → "Mon 2 Nov" (with the year when it isn't this year). */
export function fmtDay(iso, opts = {}) {
  if (!iso) return "Date TBC";
  const d = new Date(iso + "T12:00:00");
  const o = { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}), ...opts };
  try { return d.toLocaleDateString("en-GB", o); } catch { return iso; }
}
export const today = () => new Date().toISOString().slice(0, 10);
export function turnFrac(deg) {
  const m = { 45: "⅛", 90: "¼", 135: "⅜", 180: "½", 225: "⅝", 270: "¾", 315: "⅞", 360: "1" };
  return (m[Math.abs(deg)] || Math.abs(deg) + "°") + (deg > 0 ? " R" : deg < 0 ? " L" : "");
}
export const totalTurn = (steps) => { const t = steps.reduce((a, s) => a + (+s.t || 0), 0); return t ? turnFrac(t) : "None"; };
export function figUsage() {
  const u = {};
  for (const r of S.routines) for (const it of r.items) if (it.type === "fig" && it.fig) (u[it.fig] ||= new Set()).add(r);
  return u;
}

export function setAccent(danceId) {
  const d = danceOf(danceId) || S.dances[0];
  if (!d) return;
  document.documentElement.style.setProperty("--accent", `var(--${d.color})`);
  document.documentElement.style.setProperty("--on-accent", DARK_ON.has(d.color) ? "var(--on-dark)" : "var(--on-light)");
}

/** Footprint layers for a chart and role ('man' | 'lady' | 'both'). */
export function layersFor(c, d, role) {
  const latin = d.style === "Latin";
  const hm = (latin ? 0 : parseAlign(c.start?.man) ?? 135) + (c.turnBefore?.man || 0);
  const hl = (latin ? 180 : parseAlign(c.start?.lady) ?? (hm + 180) % 360) + (c.turnBefore?.lady || 0);
  const lead = "var(--accent)", fol = role === "both" ? "var(--ink)" : "var(--accent)";
  if (role === "man") return [{ sim: simulate(c.man || [], hm, null, latin), color: lead, steps: c.man || [] }];
  if (role === "lady") return [{ sim: simulate(c.lady || [], latin ? 0 : hl, null, latin), color: fol, steps: c.lady || [] }];
  const r = (hm * Math.PI) / 180, fx = Math.sin(r), fy = -Math.cos(r), rx = Math.cos(r), ry = Math.sin(r);
  const off = latin ? { x: fx * STRIDE * 1.05, y: fy * STRIDE * 1.05 } : { x: fx * STRIDE * 0.42 + rx * TRACK * 0.55, y: fy * STRIDE * 0.42 + ry * TRACK * 0.55 };
  return [
    { sim: simulate(c.man || [], hm, null, latin), color: lead, steps: c.man || [], tag: "Leader", bodyColor: "var(--ink)" },
    { sim: simulate(c.lady || [], hl, off, latin), color: fol, steps: c.lady || [], tag: "Follower", bodyColor: "var(--muted)" },
  ];
}

// ── UI bits ───────────────────────────────────────────────────────────
let toastT;
export function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3600);
}
export async function attempt(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) {
    toast(e.message || "Something went wrong");
    if (e.status === 409) { await refresh(); hooks.render(); }
    if (e.status === 401) { history.pushState(null, "", BASE + "/login"); hooks.route(); }
    return null;
  }
}
/** Two-tap confirm for destructive buttons. Returns true on the second tap. */
export function confirmTap(btn, label) {
  if (btn.dataset.armed === "1") return true;
  const was = btn.textContent;
  btn.dataset.armed = "1"; btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ""; btn.textContent = was; } }, 3500);
  return false;
}

/** Videos for a figure / lesson / routine. canAdd: whether this person may add to it (the server checks too). */
export function videoBlock(ref, canAdd = true) {
  if (!S.me) return `<p class="muted small">Videos are for society members. <a href="${BASE}/login" data-link>Sign in</a> to watch them.</p>`;
  const vids = S.videos.filter((v) => v.ref === ref);
  const list = vids.map((v) => {
    const by = `<span class="muted small">${esc(userName(v.created_by))}</span>`;
    const del = v.created_by === S.me.id || isCommittee() ? `<button class="btn sm ghost" data-act="vid-del" data-id="${v.id}">Remove</button>` : "";
    if (v.file) return `<div class="vid"><video controls preload="metadata" playsinline src="${BASE}/media/${encodeURIComponent(v.file)}"></video><div class="row"><span class="t">${esc(v.title || "Uploaded video")}</span>${by}${del}</div></div>`;
    let host = ""; try { host = new URL(v.url).hostname.replace(/^www\./, ""); } catch {}
    return `<div class="vid"><div class="row"><a class="link t" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer"><span class="play" aria-hidden="true">▶</span><span><b>${esc(v.title || host || "Video link")}</b><br><span class="muted small">${esc(host)} · opens in a new tab</span></span></a>${by}${del}</div></div>`;
  }).join("");
  if (!canAdd) return `<div class="vids">${list || `<p class="muted small">No videos yet.</p>`}</div>`;
  return `<div class="vids">${list || `<p class="muted small">No videos yet. Paste a YouTube or Instagram link, or upload a clip from your phone.</p>`}
    <form class="addrow" data-vidform="${esc(ref)}"><input class="input" name="url" type="url" placeholder="https://youtube.com/…" aria-label="Video link" required><input class="input" name="title" placeholder="Title (optional)" aria-label="Video title"><button class="btn" type="submit">Add link</button></form>
    <label class="btn upload">Upload a clip<input type="file" accept="video/*" data-upload="${esc(ref)}" hidden></label>
    <div class="saved" data-upstatus="${esc(ref)}"></div></div>`;
}

export function uploadVideo(ref, file, statusEl) {
  const fd = new FormData(); fd.append("ref", ref); fd.append("file", file); fd.append("title", file.name.replace(/\.[^.]+$/, ""));
  const xhr = new XMLHttpRequest();
  xhr.open("POST", BASE + "/api/videos");
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) statusEl.textContent = `Uploading… ${Math.round((e.loaded / e.total) * 100)}%`; };
  xhr.onload = async () => {
    if (xhr.status < 300) { statusEl.textContent = "Uploaded"; await refresh(); hooks.render(); }
    else { let m = "Upload didn't work. Try again"; try { m = JSON.parse(xhr.responseText).detail || m; } catch {} statusEl.textContent = m; }
  };
  xhr.onerror = () => (statusEl.textContent = "Upload didn't work. Check your connection");
  xhr.send(fd);
}

// ── notation glossary (hover or tap anything dotted-underlined) ───────
const GLOSS = {
  "nfr": "No foot rise: the body rises but the heel of the supporting foot stays down",
  "e/o": "End of",
  "cbmp": "Contrary Body Movement Position: the foot is placed across the line of the other foot, without turning the body",
  "cbm": "Contrary Body Movement: turning the opposite side of the body towards the moving leg, to start a turn",
  "pp": "Promenade Position: a V-shaped position, open on the Man's left and Lady's right, both moving the same way",
  "cpp": "Counter Promenade Position: the mirror of Promenade, open on the Man's right",
  "dw": "Diagonal to wall: halfway between the line of dance and the wall",
  "dc": "Diagonal to centre: halfway between the line of dance and the centre of the room",
  "lod": "Line of dance: the direction of travel, anticlockwise around the room",
  "against lod": "Against the line of dance: the opposite way to the direction of travel",
  "ag lod": "Against the line of dance: the opposite way to the direction of travel",
  "lf": "Left foot", "rf": "Right foot",
  "lsp": "Left Side Position: the Lady is on the Man's left side",
  "rsp": "Right Side Position: the Lady is on the Man's right side",
  "facing": "Facing: the front of the body points this way",
  "backing": "Backing: the back of the body points this way",
  "pointing": "Pointing: the foot points this way while the body turns less",
  "fallaway": "Fallaway: moving backwards in Promenade Position",
  "heel turn": "Heel turn: turning on the heel of the supporting foot with the feet together, then the weight changes",
  "body turns less": "The body turns less than the feet on this step and catches up on the next",
  "replace weight": "Transfer the weight back onto the other foot, which stays where it is",
  "half closes": "Closes most of the way to the other foot, not quite together",
  "part weight": "Only part of the weight goes onto this foot",
  "check": "Checking: stopping the movement on this step, ready to go the other way",
  "checking": "Checking: stopping the movement on this step, ready to go the other way",
  "w": "Wall", "c": "Centre",
};
const TERM_RE = /\b(CBMP|CBM|NFR|CPP|PP|DW|DC|LF|RF|LSP|RSP)\b|e\/o|against LOD|ag LOD|\bLOD\b|[Hh]eel turn|[Bb]ody turns less|[Rr]eplace weight|[Hh]alf closes|[Pp]art weight|\b(Pointing|Backing|Facing|Fallaway)\b|\b[Cc]heck(ing)?\b|(?<=(Facing|Backing) )\b[WC]\b/g;
const tipSpan = (txt, tip) => `<abbr class="tip" data-tip="${esc(tip)}">${txt}</abbr>`;
/** Escape text and add tooltips to the ISTD abbreviations and terms in it. */
export function glossed(text) {
  return esc(text).replace(TERM_RE, (m) => { const t = GLOSS[m.toLowerCase()]; return t ? tipSpan(m, t) : m; });
}
const FW = { "IE": "inside edge", "BF": "ball flat", "WF": "whole foot", "BH": "ball, then heel", H: "heel", T: "toe", B: "ball", F: "flat" };
/** Footwork code ("HT", "IE of B, H") with a plain-English tooltip. */
export function footwork(code) {
  if (!code) return "";
  const parts = [];
  code.replace(/IE of B|IE|BF|WF|BH|H|T|B|F/g, (m) => { parts.push(m === "IE of B" ? "inside edge of the ball" : FW[m]); return m; });
  if (!parts.length) return esc(code);
  const words = parts.join(", then ");
  return tipSpan(`<span class="mono">${esc(code)}</span>`, `Footwork: ${words[0].toUpperCase() + words.slice(1)}. The part of the foot that meets the floor first, then next.`);
}
const SWAY = { S: "Straight: no sway", L: "Sway to the left: the body inclines left from the feet up", R: "Sway to the right: the body inclines right from the feet up" };
export const sway = (s) => (SWAY[s] ? tipSpan(esc(s), SWAY[s]) : esc(s || ""));
const COUNT = { S: "Slow", Q: "Quick", "&": "Half a beat, between the main counts", a: "A quarter of a beat, just before the next count" };
export function count(c, dance) {
  const slowBeats = dance?.bpb === 2 ? "1 beat" : "2 beats", quick = dance?.bpb === 2 ? "½ beat" : "1 beat";
  const t = c === "S" ? `Slow: ${slowBeats}` : c === "Q" ? `Quick: ${quick}` : COUNT[c];
  return t ? tipSpan(`<span class="mono">${esc(c)}</span>`, t) : `<span class="mono">${esc(c)}</span>`;
}
export const HEAD_TIPS = {
  "Foot position": "Which foot moves and where it goes, relative to the other foot",
  "Alignment": "The direction the body faces (or backs) in the room, relative to the line of dance, wall and centre",
  "Amount of turn": "How far the body turns, and between which steps. ⅛ = 45°, ¼ = 90°, ⅜ = 135°, ½ = 180°",
  "Turn": "How far you turn on or between steps. ⅛ = 45°, ¼ = 90°, ½ = 180°",
  "Rise & fall": "When you rise up onto the toes and lower again. NFR means no foot rise",
  "Footwork": "The part of the foot that meets the floor: H heel, T toe, B ball, F flat",
  "CBM": "Contrary Body Movement: the opposite side of the body turns towards the moving leg",
  "Sway": "The inclination of the body: S straight, L left, R right",
  "Timing": "The count and how many beats the step takes",
  "Count": "The count you call for this step. & and a are split beats",
  "Beats": "How many beats the step takes",
};
export const head = (h) => (HEAD_TIPS[h] ? tipSpan(esc(h), HEAD_TIPS[h]) : esc(h));

export const LEVEL_TIPS = {
  Bronze: "ISTD Bronze medal: the foundation figures, such as basic turns, changes and chassés. Everything else builds on these.",
  Silver: "ISTD Silver medal: adds figures with more turn, sway and shaping, such as telemarks, wings and hip twists. A Silver routine can also use every Bronze figure.",
  Gold: "ISTD Gold medal: the hardest syllabus figures, such as contra checks, hover corté and advanced hip twists. A Gold routine can use Bronze, Silver and Gold figures.",
  Restricted: "BDC restricted syllabus: the figures allowed in beginner, novice and juvenile competitions run under British Dance Council rules. One list per dance, no medal levels. Figures must be danced as charted in the technique books.",
};

/** "Steps 4–6 only" in a routine item's notes → [4, 6]; null when the whole figure is danced. */
export function stepRange(notes) {
  const m = String(notes || "").match(/\bsteps?\s*(\d+)\s*(?:[–—-]|to)\s*(\d+)/i);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  return a >= 1 && b >= a ? [a, b] : null;
}
/** A chart cut down to the steps actually danced, keeping the alignment the cut starts on. */
export function sliceChart(c, range) {
  if (!c || !range) return c;
  const [a, b] = range, pre = (arr) => (arr || []).slice(0, a - 1).reduce((t, s) => t + (+s.t || 0), 0);
  return { ...c, man: (c.man || []).slice(a - 1, b), lady: (c.lady || []).slice(a - 1, b), turnBefore: { man: pre(c.man), lady: pre(c.lady) } };
}
