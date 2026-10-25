// Practice: play a whole routine figure by figure, to the beat, showing only your own steps.
import { drawFrame, makePlayer, placeSim } from "../engine.js";
import { BASE, $, $$, S, chartFor, danceOf, esc, hooks, layersFor, ls, roleWord, setAccent, sliceChart, stepRange, tempoMid, toast } from "../core.js";
import { UNITS_PER_M, drawFloor, planRoutine, roomFor, roomSelect, routineSegs } from "../floor.js";
import { load3d, mode, onStageChange, onStageClick, s3, stageBar } from "../view3d.js";
import { myPart } from "./routines.js";

/** A lesson's routine, shaped like a routine so the player can run it. */
function lessonRoutine(id) {
  const l = S.lessons.find((x) => x.id === id);
  if (!l || !l.dance) return null;
  return { id: "lesson:" + l.id, name: (l.title || danceOf(l.dance).name + " lesson") + " (lesson)", dance: l.dance, items: l.items, rev: l.updated_at, lesson: true };
}

const v = { id: null, sig: "", segs: [], ev: [], d: null, cur: 0, frac: 0.999 };
const player = makePlayer((i, frac) => {
  // "Loop the current figure": when the clock moves into the next figure, jump back to the start of this one
  if (v.loop && v.ev[i].si !== v.ev[v.cur]?.si) { const j = firstEv(v.ev[v.cur].si); player.seek(j); i = j; frac = 0; }
  if (i !== v.cur) callAhead(i);
  v.cur = i; v.frac = frac; paint();
});
export const stopPractice = () => { player.pause(); music?.pause(); speechSynthesis?.cancel?.(); };

// ── compass: keep the diagrams the room's way round as you turn with the phone ─────────────────────
// "Set" is pressed standing with your back to the wall, facing the centre, phone flat with its top to the centre:
// that is how the diagrams are drawn (wall at the bottom, LOD to the right). After that the drawings turn against
// the phone, and each "Corner" marker turns the figures after it a further quarter to the left, as the LOD does.
const compass = { on: false, heading: null, cal: ls.get("compassCal", null), listening: false };
function onOrient(e) {
  let h = e.webkitCompassHeading;
  if (h == null && (e.absolute || e.type === "deviceorientationabsolute") && e.alpha != null) h = 360 - e.alpha;
  if (h == null) return;
  h = (h + (screen.orientation?.angle || 0) + 360) % 360;
  // smooth on the circle so the drawing doesn't jitter
  if (compass.heading == null) compass.heading = h;
  else { const d = ((h - compass.heading + 540) % 360) - 180; compass.heading = (compass.heading + d * 0.25 + 360) % 360; }
  turnDiagrams();
}
async function startCompass() {
  try { if (typeof DeviceOrientationEvent?.requestPermission === "function" && (await DeviceOrientationEvent.requestPermission()) !== "granted") return false; } catch { return false; }
  if (!compass.listening) {
    compass.listening = true;
    if ("ondeviceorientationabsolute" in window) addEventListener("deviceorientationabsolute", onOrient);
    else addEventListener("deviceorientation", onOrient);
  }
  return true;
}
const cornersBefore = (si) => (v.plan?.pieces || []).filter((pc) => pc.si < si && pc.corner).length;
const compassTurn = () => (compass.on && compass.heading != null && compass.cal != null ? -(((compass.heading - compass.cal) % 360 + 360) % 360) : null);
function turnDiagrams() {
  const room = compassTurn();
  const si = (v.ev[v.cur] || v.ev[0])?.si ?? 0;
  const set = (el, deg) => { if (el) el.style.transform = deg == null ? "" : `rotate(${deg.toFixed(1)}deg)`; };
  set($("#pSvg"), room == null ? null : room - 90 * cornersBefore(si));
  set($("#pFloor"), room);
  const note = $("#pCompassNote");
  if (note) note.textContent = !compass.on ? "" : compass.heading == null ? "Waiting for the compass… (phones and tablets only)"
    : compass.cal == null ? "Stand with your back to the wall facing the centre, then press Set." : "Turning with you. The wall stays at the wall.";
}

// ── calls and music ────────────────────────────────────────────────────────────────────────
// Spoken calls: two beats before each figure, its name and how both partners start, so lead and follow both know.
const WORDS = [[/\bRF\b/g, "right foot"], [/\bLF\b/g, "left foot"], [/\bfwd\b/gi, "forward"], [/\bbk\b/gi, "back"], [/\bdiag\b/gi, "diagonally"],
  [/\bPP\b/g, "promenade"], [/\bCPP\b/g, "counter promenade"], [/\bCBMP\b/g, "in CBMP"], [/\bLOD\b/g, "line of dance"], [/\bDW\b/g, "diagonal wall"], [/\bDC\b/g, "diagonal centre"], [/\(.*?\)/g, ""]];
const say = (t) => WORDS.reduce((a, [r, w]) => a.replace(r, w), String(t || "")).replace(/\s+/g, " ").trim();
function speak(text) {
  if (!ls.get("calls", false) || !window.speechSynthesis || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text); u.rate = 1.15; u.volume = 1;
  speechSynthesis.speak(u);
}
function figureCall(seg) {
  if (!seg) return "";
  if (!seg.c) return `${seg.name}, ${seg.events.length / v.d.bpb} bars`;
  const m = seg.c.man?.[0], l = seg.c.lady?.[0];
  return `${seg.name}. ${m ? "Leader " + say(m.p) : ""}${l ? ". Follower " + say(l.p) : ""}.`;
}
function callAhead(i) {
  const e = v.ev[i]; if (!e || !player.playing) return;
  const seg = v.segs[e.si], end = seg.events.at(-1), left = end.start + end.dur - e.start;
  if (i === 0 && v.calledFor !== -1) { v.calledFor = -1; speak("Starting with " + figureCall(seg)); return; }
  // two beats from the end of this figure, call the next one
  if (left <= 2 && left > 2 - e.dur - 1e-6 && v.calledFor !== e.si + 1 && v.segs[e.si + 1]) { v.calledFor = e.si + 1; speak("Next, " + figureCall(v.segs[e.si + 1])); }
}

// Music: Spotify can't change a song's speed (and its player needs Premium plus a developer app), so practice
// music is a track from your own device, sped up or slowed to the practice speed without changing its pitch.
let music = null;
// trackBars: the track's own tempo in bars a minute (tempoMid is the dance's competition tempo, also bars a minute)
function musicRate() { const bars = +ls.get("trackBars", 0); return (bars ? tempoMid(v.d) / bars : 1) * +ls.get("pspeed", 1); }
function syncMusic() {
  if (!music) return;
  music.playbackRate = Math.max(0.5, Math.min(2, musicRate())); music.preservesPitch = true;
  if (player.playing && music.paused) music.play().catch(() => {});
  if (!player.playing && !music.paused) music.pause();
}
export const isBusy = () => player.playing;

function build(r) {
  const d = danceOf(r.dance), segs = [];
  let t = 0, mark = "";
  for (const it of r.items) {
    if (it.type === "mark") { mark = it.label; continue; }
    const c = it.fig && sliceChart(chartFor(it.fig), stepRange(it.notes)), name = (it.fig && S.figs.get(it.fig)?.name) || it.name;
    const seg = { name, it, c, mark, start: t, events: [], layers: c ? layersFor(c, d, S.role) : null };
    if (c) for (const [k, s] of seg.layers[0].steps.entries()) { seg.events.push({ start: t, dur: +s.b || 1, k }); t += +s.b || 1; }
    else for (let k = 0; k < (+it.bars || 2) * d.bpb; k++) { seg.events.push({ start: t, dur: 1, k: -1 }); t += 1; }
    segs.push(seg); mark = "";
  }
  const ev = []; segs.forEach((s, si) => s.events.forEach((e) => ev.push({ ...e, si })));
  return { segs, ev, d };
}

/** 3D: both partners of each figure placed where the floor plan puts the figure, so the couple travels round the room,
 *  and the plan's path painted on the floor. */
function place3d() {
  for (const pc of v.plan.pieces) {
    const seg = v.segs[pc.si];
    if (!seg?.c || pc.missing) continue;
    const both = layersFor(seg.c, v.d, "both"), c0 = pc.pts[0];
    seg.layers3 = both.map((l) => ({ ...l, sim: placeSim(l.sim, c0.x, c0.y, c0.h - both[0].sim.prints[0].h) }));
  }
  const room = roomFor();
  v.room3 = { w: room.w, h: room.h, at: { x: 0, z: 0 }, paths: v.plan.pieces.map((pc) => pc.pts.map((p) => ({ x: p.x / UNITS_PER_M, y: p.y / UNITS_PER_M }))) };
}

export function render(el, params) {
  const speed = +ls.get("pspeed", 1), metro = ls.get("metro", true), loop = (v.loop = ls.get("ploop", false));
  const fromLesson = params.lesson ? lessonRoutine(params.lesson) : null;
  if (params.id) v.id = params.id;
  if (fromLesson) v.id = fromLesson.id;
  const list = fromLesson ? [fromLesson, ...S.routines] : S.routines;
  if (!list.find((r) => r.id === v.id)) v.id = ls.get("rid", null);
  const r = list.find((x) => x.id === v.id) || list[0];
  // open on your own part of the routine
  if (r && r.id !== v.lastOpened) { v.lastOpened = r.id; const part = !r.lesson && myPart(r); if (part && S.role !== "both") S.role = part; hooks.headerOnly?.(); }
  el.innerHTML = `<div class="pbar">
      <label class="field">Routine<select class="input" id="pRoutine">${list.map((x) => `<option value="${x.id}" ${x.id === r?.id ? "selected" : ""}>${esc(x.name)}</option>`).join("") || `<option>No routines yet</option>`}</select></label>
      <label class="field">Speed<select class="input" id="pSpeed">${[[0.5, "50% · learning"], [0.75, "75%"], [0.9, "90%"], [1, "100% · competition tempo"]].map(([x, l]) => `<option value="${x}" ${x === speed ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" id="pMetro" ${metro ? "checked" : ""}> Metronome</label>
      <label class="check"><input type="checkbox" id="pLoop" ${loop ? "checked" : ""}> Loop the current figure</label>
      <label class="check" title="Says each figure two beats before it starts, with how the leader and follower begin"><input type="checkbox" id="pCalls" ${ls.get("calls", false) ? "checked" : ""}> Call out the next figure</label>
      <label class="check" title="On a phone: the diagrams turn as you turn, so the wall stays at the wall"><input type="checkbox" id="pCompass" ${compass.on ? "checked" : ""}> Room's way round</label>
      ${compass.on ? `<button class="btn sm" data-act="compass-set">Set: back to the wall</button>` : ""}
    </div>
    <div class="pbar small">
      <label class="field">Music (from this device)<input class="input" type="file" accept="audio/*" id="pMusic"></label>
      <label class="field narrow" title="The track's own speed in bars a minute, so it can be played at the practice speed. Leave empty to scale it by the speed only">Track bars/min<input class="input" type="number" min="10" max="80" step="1" id="pTrackBpm" value="${esc(ls.get("trackBars", "") || "")}"></label>
      <span class="muted" id="pMusicName">${music ? esc(music.dataset.name || "") : ""}</span>
      <span class="muted" id="pCompassNote"></span>
    </div><div id="pBody"></div>`;
  el.onclick = onClick; el.onchange = onChange;
  if (!r) { $("#pBody").innerHTML = `<div class="panel pad empty">Create a routine first, then come back here to drill it to the beat.</div>`; return; }
  v.id = r.id; setAccent(r.dance);
  const sig = `${r.id}:${r.rev}:${S.role}:${JSON.stringify(S.charts).length}`;
  if (sig !== v.sig) {
    Object.assign(v, build(r), { sig, cur: 0, frac: 0.999 });
    v.plan = planRoutine(routineSegs(r), roomFor(), v.d.style === "Latin");
    place3d();
    player.load(v.ev, { bpm: tempoMid(v.d) * v.d.bpb * speed, bpb: v.d.bpb, loop: true, metro });
  }
  if (!v.segs.length) { $("#pBody").innerHTML = `<div class="panel pad empty">This routine has no figures yet.</div>`; return; }
  $("#pBody").innerHTML = `<div class="psplit">
    <div>
      <div class="now"><span class="eyebrow" id="pMark"></span><h1 class="display" id="pFig"></h1><span class="muted" id="pStep"></span></div>
      ${stageBar()}
      <div class="stage big ${mode() === "3d" ? "s3d" : ""}"><div class="counts mono" id="pCount"></div>${mode() === "3d"
        ? `<div class="dia3host" id="p3" role="img" aria-label="3D dancers going round the floor. Drag to look round"></div>`
        : `<svg class="dia" id="pSvg" role="img" aria-label="Animated footprints for the current figure"></svg>`}<div class="beat display" id="pBeat"></div></div>
      <div class="transport">
        <button class="btn sm" data-act="restart" aria-label="Back to the start">⟲</button>
        <button class="btn sm" data-act="prevfig">◀ Figure</button>
        <button class="btn acc" data-act="play" id="pPlay">▶ Start</button>
        <button class="btn sm" data-act="nextfig">Figure ▶</button>
      </div>
      <p class="small muted">Showing ${esc(S.role === "both" ? "both partners'" : roleWord(S.role) + "'s")} steps. Switch with “Steps for” at the top.</p>
    </div>
    <div>
      <div class="sec-title"><span>Where you are</span><span class="acts">${roomSelect()}</span></div>
      <div class="floorwrap mini"><svg class="floor" id="pFloor" role="img" aria-label="Your position in the room"></svg></div>
      <div class="sec-title"><span>${esc(r.name)}</span></div>
      <div class="seq" id="pSeq">${v.segs.map((s, i) => `${s.mark ? `<div class="mk">${esc(s.mark)}</div>` : ""}<button data-seg="${i}"><span class="mono muted">${String(i + 1).padStart(2, "0")}</span><span>${esc(s.name)}${s.it.notes ? `<br><span class="muted small">${esc(s.it.notes)}</span>` : ""}</span><span class="mono muted small">${s.c ? esc(s.c.timing || "") : "no chart"}</span><span class="pg"></span></button>`).join("")}</div>
    </div></div>`;
  if (mode() === "3d" && !s3.stage) load3d().then(() => hooks.render());
  paint();
}

function paint() {
  if (!$("#pSvg") && !$("#p3")) return;
  const e = v.ev[v.cur] || v.ev[0], seg = v.segs[e.si], d = v.d;
  $("#pMark").textContent = seg.mark || `Figure ${e.si + 1} of ${v.segs.length}`;
  $("#pFig").textContent = seg.name;
  if ($("#p3")) {
    // a figure with no chart holds the last charted figure's finishing position
    const held = seg.layers3 ? null : v.segs.slice(0, e.si).reverse().find((x) => x.layers3);
    const src = seg.layers3 || held?.layers3;
    if (s3.stage && src) {
      s3.stage.mount($("#p3"));
      s3.stage.draw(src, seg.layers3 ? e.k + v.frac : src[0].steps.length, { latin: d.style === "Latin", room: v.room3, turn: compassTurn() || 0 });
    }
  }
  if (seg.c) {
    if ($("#pSvg")) drawFrame($("#pSvg"), seg.layers, e.k + v.frac, { room: d.style === "Standard" });
    const s = seg.layers[0].steps[e.k];
    $("#pStep").textContent = s ? `Step ${e.k + 1}: ${s.p}${s.fw ? " · " + s.fw : ""}` : "";
    $("#pCount").innerHTML = seg.layers[0].steps.map((x, i) => `<span class="${i === e.k ? "on" : ""}">${esc(x.c)}</span>`).join(" ");
    $("#pBeat").textContent = s ? s.c : "";
  } else {
    const svg = $("#pSvg");
    if (svg) {
      svg._key = null;
      svg.setAttribute("viewBox", "-120 -60 240 120");
      svg.innerHTML = `<text text-anchor="middle" y="4" class="roomtx">NO CHART YET: COUNT THE BARS</text>`;
    }
    const beat = e.start - seg.start;
    $("#pStep").textContent = seg.it.notes || "Add a chart on the Syllabus page to see the footprints.";
    $("#pCount").textContent = `bar ${Math.floor(beat / d.bpb) + 1} of ${seg.events.length / d.bpb}`;
    $("#pBeat").textContent = String((beat % d.bpb) + 1);
  }
  $("#pPlay").textContent = player.playing ? "❚❚ Pause" : "▶ Start";
  if (compass.on) turnDiagrams();
  if ($("#pFloor") && v.plan) drawFloor($("#pFloor"), v.plan, { si: e.si, k: e.k, frac: v.frac });
  for (const b of $$("#pSeq button[data-seg]")) {
    const i = +b.dataset.seg, s = v.segs[i], end = s.events.at(-1), span = end.start + end.dur - s.start;
    b.setAttribute("aria-current", String(i === e.si));
    const pct = i < e.si ? 100 : i > e.si ? 0 : Math.min(100, ((e.start + e.dur * v.frac - s.start) / span) * 100);
    b.querySelector(".pg").style.width = pct + "%";
  }
}
const firstEv = (si) => v.ev.findIndex((e) => e.si === si);

async function onClick(ev) {
  if (await onStageClick(ev, () => hooks.render())) return;
  const seg = ev.target.closest("[data-seg]");
  if (seg) { const i = firstEv(+seg.dataset.seg); v.cur = i; v.frac = 0.999; player.seek(i); paint(); return; }
  const t = ev.target.closest("[data-act]"); if (!t) return;
  const e = v.ev[v.cur] || v.ev[0];
  switch (t.dataset.act) {
    case "play":
      if (player.playing) player.pause(); else { v.calledFor = null; player.play(v.cur); callAhead(v.cur); }
      if (music && v.cur === 0 && player.playing) music.currentTime = 0;
      syncMusic(); paint(); break;
    case "restart": v.cur = 0; v.frac = 0.999; player.seek(0); v.calledFor = null; if (music) music.currentTime = 0; paint(); break;
    case "compass-set":
      if (compass.heading == null) { toast("No compass reading yet. This works on phones and tablets"); break; }
      compass.cal = compass.heading; ls.set("compassCal", compass.cal); turnDiagrams(); toast("Set. The diagrams now turn with you"); break;
    case "prevfig": case "nextfig": {
      const si = Math.max(0, Math.min(v.segs.length - 1, e.si + (t.dataset.act === "nextfig" ? 1 : -1)));
      v.cur = firstEv(si); v.frac = 0.999; player.seek(v.cur); paint(); break;
    }
  }
}

function onChange(ev) {
  const t = ev.target;
  if (onStageChange(t, paint)) return;
  if (t.id === "pRoutine") { player.pause(); history.pushState(null, "", BASE + (t.value.startsWith("lesson:") ? "/practice/lesson/" + t.value.slice(7) : "/practice/" + t.value)); hooks.route(); }
  else if (t.id === "pSpeed") { ls.set("pspeed", +t.value); player.set({ bpm: tempoMid(v.d) * v.d.bpb * +t.value }); syncMusic(); }
  else if (t.id === "pMetro") { ls.set("metro", t.checked); player.set({ metro: t.checked }); }
  else if (t.dataset.room !== undefined) { ls.set("room", t.value); v.sig = ""; hooks.render(); }
  else if (t.id === "pLoop") { v.loop = t.checked; ls.set("ploop", t.checked); }
  else if (t.id === "pCalls") { ls.set("calls", t.checked); if (t.checked) speak("Calls on"); }
  else if (t.id === "pCompass") {
    if (t.checked) startCompass().then((ok) => { compass.on = ok; if (!ok) toast("The compass needs permission, on a phone or tablet"); hooks.render(); });
    else { compass.on = false; turnDiagrams(); hooks.render(); }
  }
  else if (t.id === "pMusic" && t.files?.[0]) {
    music?.pause(); if (music?.src) URL.revokeObjectURL(music.src);
    music = new Audio(URL.createObjectURL(t.files[0])); music.loop = true; music.dataset.name = t.files[0].name;
    $("#pMusicName").textContent = t.files[0].name + " · plays with Start";
    syncMusic();
  }
  else if (t.id === "pTrackBpm") { ls.set("trackBars", t.value ? +t.value : 0); syncMusic(); }
}
