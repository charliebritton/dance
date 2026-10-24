// Practice: play a whole routine figure by figure, to the beat, showing only your own steps.
import { drawFrame, makePlayer } from "../engine.js";
import { BASE, $, $$, S, chartFor, danceOf, esc, hooks, layersFor, ls, roleWord, setAccent, sliceChart, stepRange, tempoMid } from "../core.js";
import { drawFloor, planRoutine, roomFor, roomSelect, routineSegs } from "../floor.js";

const v = { id: null, sig: "", segs: [], ev: [], d: null, cur: 0, frac: 0.999 };
const player = makePlayer((i, frac) => {
  // "Loop the current figure": when the clock moves into the next figure, jump back to the start of this one
  if (v.loop && v.ev[i].si !== v.ev[v.cur]?.si) { const j = firstEv(v.ev[v.cur].si); player.seek(j); i = j; frac = 0; }
  v.cur = i; v.frac = frac; paint();
});
export const stopPractice = () => player.pause();
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

export function render(el, params) {
  const speed = +ls.get("pspeed", 1), metro = ls.get("metro", true), loop = (v.loop = ls.get("ploop", false));
  if (params.id) v.id = params.id;
  if (!S.routines.find((r) => r.id === v.id)) v.id = ls.get("rid", null);
  const r = S.routines.find((x) => x.id === v.id) || S.routines[0];
  el.innerHTML = `<div class="pbar">
      <label class="field">Routine<select class="input" id="pRoutine">${S.routines.map((x) => `<option value="${x.id}" ${x.id === r?.id ? "selected" : ""}>${esc(x.name)}</option>`).join("") || `<option>No routines yet</option>`}</select></label>
      <label class="field">Speed<select class="input" id="pSpeed">${[[0.5, "50% · learning"], [0.75, "75%"], [0.9, "90%"], [1, "100% · competition tempo"]].map(([x, l]) => `<option value="${x}" ${x === speed ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="check"><input type="checkbox" id="pMetro" ${metro ? "checked" : ""}> Metronome</label>
      <label class="check"><input type="checkbox" id="pLoop" ${loop ? "checked" : ""}> Loop the current figure</label>
    </div><div id="pBody"></div>`;
  el.onclick = onClick; el.onchange = onChange;
  if (!r) { $("#pBody").innerHTML = `<div class="panel pad empty">Create a routine first, then come back here to drill it to the beat.</div>`; return; }
  v.id = r.id; setAccent(r.dance);
  const sig = `${r.id}:${r.rev}:${S.role}:${JSON.stringify(S.charts).length}`;
  if (sig !== v.sig) {
    Object.assign(v, build(r), { sig, cur: 0, frac: 0.999 });
    v.plan = planRoutine(routineSegs(r), roomFor(), v.d.style === "Latin");
    player.load(v.ev, { bpm: tempoMid(v.d) * v.d.bpb * speed, bpb: v.d.bpb, loop: true, metro });
  }
  if (!v.segs.length) { $("#pBody").innerHTML = `<div class="panel pad empty">This routine has no figures yet.</div>`; return; }
  $("#pBody").innerHTML = `<div class="psplit">
    <div>
      <div class="now"><span class="eyebrow" id="pMark"></span><h1 class="display" id="pFig"></h1><span class="muted" id="pStep"></span></div>
      <div class="stage big"><div class="counts mono" id="pCount"></div><svg class="dia" id="pSvg" role="img" aria-label="Animated footprints for the current figure"></svg><div class="beat display" id="pBeat"></div></div>
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
  paint();
}

function paint() {
  if (!$("#pSvg")) return;
  const e = v.ev[v.cur] || v.ev[0], seg = v.segs[e.si], d = v.d;
  $("#pMark").textContent = seg.mark || `Figure ${e.si + 1} of ${v.segs.length}`;
  $("#pFig").textContent = seg.name;
  if (seg.c) {
    drawFrame($("#pSvg"), seg.layers, e.k + v.frac, { room: d.style === "Standard" });
    const s = seg.layers[0].steps[e.k];
    $("#pStep").textContent = s ? `Step ${e.k + 1}: ${s.p}${s.fw ? " · " + s.fw : ""}` : "";
    $("#pCount").innerHTML = seg.layers[0].steps.map((x, i) => `<span class="${i === e.k ? "on" : ""}">${esc(x.c)}</span>`).join(" ");
    $("#pBeat").textContent = s ? s.c : "";
  } else {
    const svg = $("#pSvg"); svg._key = null;
    svg.setAttribute("viewBox", "-120 -60 240 120");
    svg.innerHTML = `<text text-anchor="middle" y="4" class="roomtx">NO CHART YET: COUNT THE BARS</text>`;
    const beat = e.start - seg.start;
    $("#pStep").textContent = seg.it.notes || "Add a chart on the Syllabus page to see the footprints.";
    $("#pCount").textContent = `bar ${Math.floor(beat / d.bpb) + 1} of ${seg.events.length / d.bpb}`;
    $("#pBeat").textContent = String((beat % d.bpb) + 1);
  }
  $("#pPlay").textContent = player.playing ? "❚❚ Pause" : "▶ Start";
  if ($("#pFloor") && v.plan) drawFloor($("#pFloor"), v.plan, { si: e.si, k: e.k, frac: v.frac });
  for (const b of $$("#pSeq button[data-seg]")) {
    const i = +b.dataset.seg, s = v.segs[i], end = s.events.at(-1), span = end.start + end.dur - s.start;
    b.setAttribute("aria-current", String(i === e.si));
    const pct = i < e.si ? 100 : i > e.si ? 0 : Math.min(100, ((e.start + e.dur * v.frac - s.start) / span) * 100);
    b.querySelector(".pg").style.width = pct + "%";
  }
}
const firstEv = (si) => v.ev.findIndex((e) => e.si === si);

function onClick(ev) {
  const seg = ev.target.closest("[data-seg]");
  if (seg) { const i = firstEv(+seg.dataset.seg); v.cur = i; v.frac = 0.999; player.seek(i); paint(); return; }
  const t = ev.target.closest("[data-act]"); if (!t) return;
  const e = v.ev[v.cur] || v.ev[0];
  switch (t.dataset.act) {
    case "play": if (player.playing) player.pause(); else player.play(v.cur); paint(); break;
    case "restart": v.cur = 0; v.frac = 0.999; player.seek(0); paint(); break;
    case "prevfig": case "nextfig": {
      const si = Math.max(0, Math.min(v.segs.length - 1, e.si + (t.dataset.act === "nextfig" ? 1 : -1)));
      v.cur = firstEv(si); v.frac = 0.999; player.seek(v.cur); paint(); break;
    }
  }
}

function onChange(ev) {
  const t = ev.target;
  if (t.id === "pRoutine") { player.pause(); history.pushState(null, "", BASE + "/practice/" + t.value); hooks.route(); }
  else if (t.id === "pSpeed") { ls.set("pspeed", +t.value); player.set({ bpm: tempoMid(v.d) * v.d.bpb * +t.value }); }
  else if (t.id === "pMetro") { ls.set("metro", t.checked); player.set({ metro: t.checked }); }
  else if (t.dataset.room !== undefined) { ls.set("room", t.value); v.sig = ""; hooks.render(); }
  else if (t.id === "pLoop") { v.loop = t.checked; ls.set("ploop", t.checked); }
}
