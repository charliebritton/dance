// Syllabus: dance picker, ISTD figure list, and the figure page (animated footprints, step chart, notes, videos).
import { DIRS, DIR_LABELS, MV_OPTS, alignName, drawFrame, makePlayer } from "../engine.js";
import {
  BASE, $, $$, S, api, attempt, chartBeats, chartFor, confirmTap, danceOf, esc, figByName, figUsage, fmtBeats, fmtDate,
  hooks, layersFor, ls, refresh, roleWord, setAccent, slug, tempoMid, totalTurn, uploadVideo, userName, videoBlock,
  count, footwork, glossed, head, sway, LEVEL_TIPS,
} from "../core.js";

const v = { dance: ls.get("dance", "waltz"), fig: null, q: "", step: -1, editing: false, draft: null, ctx: null, drafting: false };
const player = makePlayer((i, frac) => { v.step = i; paint(i + frac); });
export const stopSyllabus = () => player.pause();

export function render(el, params) {
  if (params.dance && danceOf(params.dance)) { v.dance = params.dance; ls.set("dance", v.dance); }
  const d = danceOf(v.dance);
  const want = params.fig ? S.figs.get(d.id + "." + params.fig) : null;
  const next = want?.id || (v.fig && S.figs.get(v.fig)?.dance === d.id ? v.fig : d.id + "." + slug(d.levels.Bronze[0]));
  if (next !== v.fig) { v.fig = next; v.step = -1; v.editing = false; player.pause(); }
  setAccent(d.id);
  el.innerHTML = `
    <div class="strip" id="strip">${strip()}</div>
    <div class="split">
      <aside class="panel figlist" aria-label="Figures">
        <input class="input" id="figSearch" type="search" placeholder="Search all figures…" aria-label="Search figures" value="${esc(v.q)}">
        <div class="groups" id="figGroups">${figList()}</div>
      </aside>
      <article id="figDetail">${detail()}</article>
    </div>`;
  setupStage();
  el.onclick = onClick; el.oninput = onInput; el.onchange = onChange; el.onsubmit = onSubmit;
}

function go(fid) {
  const f = S.figs.get(fid);
  history.pushState(null, "", BASE + `/syllabus/${f.dance}/${f.slug}`);
  hooks.route();
}

function strip() {
  const row = (style) => `<div class="strip-row"><div class="eyebrow">${style}</div>${S.dances.filter((d) => d.style === style).map((d) =>
    `<a class="dtile c-${d.color}" href="${BASE}/syllabus/${d.id}" data-link aria-current="${d.id === v.dance}">
      <span class="nm">${esc(d.name)}</span><span class="mt">${d.sig} · ${d.tempo[0]}–${d.tempo[1]} bars/min</span></a>`).join("")}</div>`;
  return row("Standard") + row("Latin");
}

function figList() {
  const q = v.q.trim().toLowerCase(), usage = figUsage();
  const vids = {};
  for (const x of S.videos) if (x.ref.startsWith("fig:")) vids[x.ref.slice(4)] = (vids[x.ref.slice(4)] || 0) + 1;
  const row = (f) => {
    const c = chartFor(f.id);
    return `<a class="frow" href="${BASE}/syllabus/${f.dance}/${f.slug}" data-link aria-current="${f.id === v.fig}">
      <span class="nm">${esc(f.name)}${q ? ` <span class="dn">${esc(danceOf(f.dance).name)}</span>` : ""}</span>
      ${c ? `<span class="ic" title="${c.src === "ai" ? "Chart drafted by Claude" : "Has a step chart"}">${c.src === "ai" ? "AI" : "Chart"}</span>` : ""}
      ${vids[f.id] ? `<span class="ic" title="Demo videos">▶ ${vids[f.id]}</span>` : ""}
      ${usage[f.id] ? `<span class="ic" title="In your routines">In ${usage[f.id].size}</span>` : ""}</a>`;
  };
  if (q) {
    const hits = [...S.figs.values()].filter((f) => f.name.toLowerCase().includes(q) || danceOf(f.dance).name.toLowerCase().includes(q));
    return hits.length ? `<div class="fgroup">${hits.slice(0, 80).map(row).join("")}</div>` : `<p class="empty">No figures match “${esc(v.q)}”.</p>`;
  }
  const d = danceOf(v.dance);
  return `<p class="lvl-help small muted">Bronze, Silver and Gold are the ISTD medal levels. Each one adds harder figures, and a routine at a level can use every figure up to it.</p>` + S.levels.map((L) => `<div class="fgroup"><h4><span class="medal m-${L}"></span><abbr class="tip" data-tip="${esc(LEVEL_TIPS[L])}">${L}</abbr><span class="muted mono count">${d.levels[L].length}</span></h4>${d.levels[L].map((n) => row(S.figs.get(d.id + "." + slug(n)))).join("")}</div>`).join("");
}

function srcBadge(c) {
  if (c.src === "ai") return `<span class="badge ai" title="Drafted by Claude. Check it against your technique book.">Drafted by Claude · check it</span>`;
  if (c.src === "edited") return `<span class="badge ed">Edited by ${esc(userName(c.updated_by))}</span>`;
  return `<span class="badge st" title="Starter chart in the style of the technique books. Check it with your teacher.">Starter chart</span>`;
}
function pfChips(danceId, list) {
  if (!list?.length) return `<span class="muted">—</span>`;
  return list.map((n) => {
    const f = figByName(danceId, n.replace(/\s*\(.*\)\s*$/, ""));
    return f ? `<a class="pfc" href="${BASE}/syllabus/${f.dance}/${f.slug}" data-link>${esc(n)}</a>` : `<span class="pfc off">${esc(n)}</span>`;
  }).join("");
}

function detail() {
  const f = S.figs.get(v.fig), d = danceOf(f.dance), c = chartFor(f.id), latin = d.style === "Latin";
  const usage = [...(figUsage()[f.id] || [])];
  const mine = S.routines.filter((r) => r.dance === f.dance);
  const note = S.notes[f.id];
  const bars = c ? chartBeats(c) / d.bpb : 0;
  return `
  <header class="fig-head">
    <div class="min0">
      <div class="eyebrow">${esc(d.name)} · ISTD ${esc(d.style)}</div>
      <h1 class="display">${esc(f.name)}</h1>
      <div class="chips">
        <span class="chip"><span class="medal m-${f.level}"></span><abbr class="tip" data-tip="${esc(LEVEL_TIPS[f.level])}">${f.level}</abbr></span>
        <span class="chip mono">${d.sig} · ${d.tempo[0]}–${d.tempo[1]} bars/min</span>
        ${c ? `<span class="chip mono">Timing ${esc(c.timing || "")}</span><span class="chip mono">${bars % 1 ? bars.toFixed(1) : bars} bar${bars === 1 ? "" : "s"}</span>${srcBadge(c)}` : ""}
      </div>
    </div>
    ${mine.length ? `<select class="input auto" id="addToR" aria-label="Add to a routine"><option value="">Add to a routine…</option>${mine.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select>`
      : `<button class="btn" data-act="new-routine-with">Start a routine with this</button>`}
  </header>
  ${c ? `
  <div class="stage-grid">
    <div>
      <div class="stage"><div class="counts mono" id="counts"></div><svg class="dia" id="dia" role="img" aria-label="Animated footprint diagram for ${esc(f.name)}"></svg><div class="beat display" id="beat"></div></div>
      <div class="transport">
        <button class="btn sm" data-act="prev" aria-label="Previous step">◀</button>
        <button class="btn sm acc" data-act="play" id="playBtn">▶ Play to the beat</button>
        <button class="btn sm" data-act="next" aria-label="Next step">▶</button>
        <label class="small muted tempo">Speed <select class="input auto sm" id="speed">${[0.5, 0.75, 1].map((x) => `<option value="${x}" ${x === (ls.get("speed", 0.75)) ? "selected" : ""}>${x * 100}%</option>`).join("")}</select></label>
        <button class="btn sm ghost" data-act="all">Show all steps</button>
      </div>
      <div class="legend small muted"><span><i class="lg-r"></i>right foot</span><span><i class="lg-l"></i>left foot</span><span><i class="lg-n"></i>start, or where the foot is going</span><span><i class="lg-b"></i>shoulders and facing</span>${latin ? "" : "<span>Wall at the bottom, LOD →</span>"}</div>
    </div>
    <div class="facts">
      <dl>
        <dt>Start</dt><dd>Leader: ${glossed(c.start?.man || "—")}<br>Follower: ${glossed(c.start?.lady || "—")}</dd>
        <dt>Turn</dt><dd>Leader: ${totalTurn(c.man || [])} · Follower: ${totalTurn(c.lady || [])}</dd>
        <dt>Precede</dt><dd class="pf">${pfChips(f.dance, c.pre)}</dd>
        <dt>Follow</dt><dd class="pf">${pfChips(f.dance, c.fol)}</dd>
        ${c.tip ? `<dt>Notes</dt><dd>${glossed(c.tip)}</dd>` : ""}
        ${usage.length ? `<dt>In routines</dt><dd class="pf">${usage.map((r) => `<a class="pfc" href="${BASE}/routines/${r.id}" data-link>${esc(r.name)}</a>`).join("")}</dd>` : ""}
      </dl>
      <div class="callout" id="callout"></div>
    </div>
  </div>
  <div class="sec-title"><span>Step chart · ${esc(S.role === "both" ? "Leader and Follower" : roleWord(S.role))}</span>
    <span class="acts">${v.editing ? `<button class="btn sm solid" data-act="save-chart">Save steps</button><button class="btn sm" data-act="cancel-edit">Cancel</button>`
      : `<button class="btn sm" data-act="edit-chart">Edit steps</button>${S.me?.ai ? `<button class="btn sm ghost" data-act="ai-chart" ${v.drafting ? "disabled" : ""}>${v.drafting ? "Claude is checking…" : c.src === "starter" ? "Ask Claude to check it" : "Redraft with Claude"}</button>` : ""}${S.charts[f.id] && S.starter[f.id] ? `<button class="btn sm ghost" data-act="reset-chart">Back to starter chart</button>` : ""}`}</span></div>
  <div id="chartTables">${v.editing ? editTables(latin) : tables(f, c, d)}</div>
  <p class="abbr small muted">${latin ? "BF ball flat · B ball · IE inside edge · F flat. “&” and “a” are split beats." : "H heel · T toe · B ball · WF whole foot · IE inside edge · NFR no foot rise · e/o end of · DW/DC diagonal to wall/centre · LOD line of dance · PP promenade position · CBM(P) contrary body movement (position)."}</p>`
  : `
  <div class="panel pad nochart">
    <h2 class="h3">No step chart yet</h2>
    ${S.me?.readonly ? `<p>This figure hasn't been charted yet. The figures marked “Chart” in the list have full step charts and footprints.</p>` : ""}
    <p class="rw-only">Claude can draft one in the style of Alex Moore's and Walter Laird's technique books, with the footprints worked out from it. Correct any step afterwards. Your partner sees the same chart.</p>
    <div class="row">${S.me?.ai ? `<button class="btn acc" data-act="ai-chart" ${v.drafting ? "disabled" : ""}>${v.drafting ? "Claude is writing it…" : "Draft the steps with Claude"}</button>` : `<span class="muted small">Add a Claude API key to the server to draft charts.</span>`}
    <button class="btn" data-act="blank-chart">Write the steps myself</button></div>
    ${v.drafting ? `<p class="small muted">This usually takes under a minute.</p>` : ""}
  </div>`}
  <div class="two">
    <section>
      <div class="sec-title"><span>Our notes</span></div>
      <textarea class="input notes" id="figNote" placeholder="What your teacher said, the bits you keep getting wrong, counts…">${esc(note?.text || "")}</textarea>
      <div class="saved" id="noteSaved">${note ? `Last edited by ${esc(userName(note.updated_by))} · ${fmtDate(note.updated_at)}` : ""}</div>
    </section>
    <section>
      <div class="sec-title"><span>Demo videos</span></div>
      ${videoBlock("fig:" + f.id)}
    </section>
  </div>`;
}

function tables(f, c, d) {
  const latin = d.style === "Latin";
  const roles = S.role === "both" ? ["man", "lady"] : [S.role];
  return roles.map((role) => {
    const steps = (role === "lady" ? c.lady : c.man) || [];
    const sim = layersFor(c, d, role)[0].sim;
    const hasCbm = steps.some((s) => s.cbm), hasSw = steps.some((s) => s.sw), hasRf = steps.some((s) => s.rf);
    const cols = latin ? ["", "Foot position", "Turn", "Footwork", "Count", "Beats"]
      : ["", "Foot position", "Alignment", "Amount of turn", hasRf && "Rise & fall", "Footwork", hasCbm && "CBM", hasSw && "Sway", "Timing"].filter((x) => x !== false);
    const rows = steps.map((s, i) => {
      const pr = sim.prints.find((p) => p.i === i);
      const al = s.al || (pr ? alignName(pr.h, s.d) : "");
      const cells = latin ? [glossed(s.p), glossed(s.tt), footwork(s.fw), count(s.c, d), fmtBeats(s.b)]
        : [glossed(s.p), glossed(al) + (s.mv ? `<div class="small muted">moving ${glossed(s.mv)}</div>` : ""), glossed(s.tt), hasRf && glossed(s.rf), footwork(s.fw), hasCbm && (s.cbm ? glossed("CBM") : ""), hasSw && sway(s.sw), `${count(s.c, d)} <span class="small muted">${fmtBeats(s.b)}</span>`].filter((x) => x !== false);
      return `<tr data-step="${i}" tabindex="0"><td class="n mono">${i + 1}</td>${cells.map((x) => `<td>${x}</td>`).join("")}</tr>`;
    }).join("");
    return `${roles.length > 1 ? `<div class="eyebrow tbl-cap">${roleWord(role)}</div>` : ""}<div class="tablewrap"><table class="chart"><thead><tr>${cols.map((h) => `<th>${head(h)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");
}

function editTables(latin) {
  const dr = v.draft;
  const opts = (list, val) => list.map((o) => `<option value="${esc(o)}" ${o === val ? "selected" : ""}>${esc(o || "—")}</option>`).join("");
  const dirOpts = (val) => Object.keys(DIRS).map((k) => `<option value="${k}" ${k === val ? "selected" : ""}>${esc(DIR_LABELS[k])}</option>`).join("");
  const tbl = (role) => `
    <div class="eyebrow tbl-cap">${roleWord(role)} · starts <input class="input inline" data-start="${role}" value="${esc(dr.start[role])}" title="e.g. F DW, B DC, Facing partner"></div>
    <div class="tablewrap"><table class="chart edit"><thead><tr><th></th><th>Foot</th><th>Foot position</th><th>Direction</th><th title="Degrees turned before this step lands: 45 = ⅛, 90 = ¼, 135 = ⅜, 180 = ½. + right, − left">Turn °</th><th>Turn as written</th>${latin ? "" : "<th>Moving</th><th>Rise & fall</th>"}<th>Footwork</th>${latin ? "" : "<th>CBM</th><th>Sway</th>"}<th>Count</th><th>Beats</th><th></th></tr></thead><tbody>
    ${dr[role].map((s, i) => `<tr data-role="${role}" data-i="${i}"><td class="n mono">${i + 1}</td>
      <td><select data-k="f">${opts(["L", "R"], s.f)}</select></td>
      <td class="wide"><input data-k="p" value="${esc(s.p)}"></td>
      <td><select data-k="d">${dirOpts(s.d)}</select></td>
      <td><input data-k="t" type="number" step="45" value="${esc(s.t)}" class="w70"></td>
      <td class="wide"><input data-k="tt" value="${esc(s.tt)}"></td>
      ${latin ? "" : `<td><select data-k="mv">${opts(MV_OPTS, s.mv || "")}</select></td><td class="wide"><input data-k="rf" value="${esc(s.rf)}"></td>`}
      <td><input data-k="fw" value="${esc(s.fw)}" class="w70"></td>
      ${latin ? "" : `<td><input data-k="cbm" type="checkbox" ${s.cbm ? "checked" : ""}></td><td><select data-k="sw">${opts(["", "S", "L", "R"], s.sw)}</select></td>`}
      <td><input data-k="c" value="${esc(s.c)}" class="w52"></td>
      <td><input data-k="b" type="number" step="0.25" min="0.25" value="${esc(s.b)}" class="w64"></td>
      <td><button class="iconbtn" data-act="row-del" title="Remove step" aria-label="Remove step ${i + 1}">✕</button></td></tr>`).join("")}
    </tbody></table></div>
    <button class="btn sm" data-act="row-add" data-role="${role}">+ Add step</button>`;
  return `<label class="field narrow">Timing<input class="input" id="edTiming" value="${esc(dr.timing)}"></label>${tbl("man")}${tbl("lady")}
    <p class="small muted">Turn ° drives the diagram: the amount turned before the step lands. Direction is relative to the way the body faces; “Moving” overrides it for steps travelling in PP.</p>`;
}

// ── animated stage ────────────────────────────────────────────────────
function setupStage() {
  const f = S.figs.get(v.fig), c = chartFor(f.id), svg = $("#dia");
  if (!c || !svg) { v.ctx = null; return; }
  const d = danceOf(f.dance), layers = layersFor(c, d, S.role), steps = layers[0].steps;
  let t = 0;
  const events = steps.map((s) => { const e = { start: t, dur: +s.b || 1 }; t += e.dur; return e; });
  v.ctx = { f, c, d, layers, steps };
  const speed = +ls.get("speed", 0.75);
  player.load(events, { bpm: tempoMid(d) * d.bpb * speed, bpb: d.bpb, loop: true });
  if (v.step >= steps.length) v.step = -1;
  paint(v.step < 0 ? -1 : v.step + 0.999);
}

function paint(pos) {
  if (!v.ctx || !$("#dia")) return;
  const { d, layers, steps } = v.ctx;
  drawFrame($("#dia"), layers, pos, { room: d.style === "Standard" });
  const k = pos < 0 ? -1 : Math.floor(pos);
  $("#counts").innerHTML = steps.map((x, i) => `<span class="${i === k ? "on" : ""}">${esc(x.c)}</span>`).join(" ");
  $("#beat").textContent = k >= 0 ? `${k + 1}` : "";
  $("#playBtn").textContent = player.playing ? "❚❚ Pause" : "▶ Play to the beat";
  if (v.lastCallout !== k + ":" + S.role) {
    v.lastCallout = k + ":" + S.role;
    callout(k);
    $$("#chartTables tr[data-step]").forEach((tr) => tr.classList.toggle("cur", +tr.dataset.step === k));
  }
}

function callout(k) {
  const el = $("#callout"); if (!el) return;
  const { d, layers } = v.ctx;
  if (k < 0) { el.innerHTML = `<div class="eyebrow">Step by step</div><p>Press play to hear the count and watch each foot travel and land, or tap a row of the chart.</p>`; return; }
  el.innerHTML = layers.map((l) => {
    const x = l.steps[k]; if (!x) return "";
    const pr = l.sim.prints.find((p) => p.i === k);
    const al = x.al || (d.style === "Standard" && pr ? alignName(pr.h, x.d) : "");
    return `<div class="cstep"><div class="eyebrow">${layers.length > 1 ? esc(l.tag) : esc(roleWord(S.role))} · step ${k + 1} · count ${esc(x.c)}</div>
      <div class="cbig">${glossed(x.p)}</div>
      <div class="small">${[al && glossed(al), x.tt && glossed(x.tt), x.fw && footwork(x.fw), x.rf && glossed(x.rf)].filter(Boolean).join(" · ")}</div></div>`;
  }).join("");
}

// ── events ────────────────────────────────────────────────────────────
async function onClick(ev) {
  const tr = ev.target.closest("tr[data-step]");
  if (tr && !v.editing) { player.pause(); v.step = +tr.dataset.step; paint(v.step + 0.999); return; }
  const t = ev.target.closest("[data-act]"); if (!t) return;
  const f = S.figs.get(v.fig), n = v.ctx?.steps.length || 0;
  switch (t.dataset.act) {
    case "play":
      if (player.playing) { player.pause(); paint(v.step + 0.999); }
      else player.play(v.step >= 0 && v.step < n - 1 ? v.step + 1 : 0);
      break;
    case "prev": player.pause(); v.step = v.step <= 0 ? n - 1 : v.step - 1; animateTo(v.step); break;
    case "next": player.pause(); v.step = (v.step + 1) % n; animateTo(v.step); break;
    case "all": player.pause(); v.step = -1; paint(-1); break;
    case "edit-chart": {
      const c = chartFor(f.id); player.pause();
      v.draft = structuredClone({ timing: c.timing || "", start: { man: c.start?.man || "", lady: c.start?.lady || "" }, man: c.man || [], lady: c.lady || [], pre: c.pre || [], fol: c.fol || [], tip: c.tip || "" });
      v.editing = true; hooks.render(); break;
    }
    case "blank-chart": {
      const latin = danceOf(f.dance).style === "Latin";
      const blank = (foot) => ({ f: foot, p: "", d: "fwd", t: 0, tt: "", fw: "", rf: "", cbm: false, sw: "", c: "1", b: 1 });
      v.draft = { timing: "", start: { man: latin ? "Facing partner" : "F DW", lady: latin ? "Facing partner" : "B DW" }, man: [blank("R")], lady: [blank("L")], pre: [], fol: [], tip: "" };
      v.editing = true; hooks.render(); break;
    }
    case "cancel-edit": v.editing = false; v.draft = null; hooks.render(); break;
    case "row-add": { const arr = v.draft[t.dataset.role], last = arr.at(-1); arr.push({ f: last?.f === "L" ? "R" : "L", p: "", d: "fwd", t: 0, tt: "", fw: "", rf: "", cbm: false, sw: "", c: last?.c || "1", b: last?.b || 1 }); hooks.render(); break; }
    case "row-del": { const row = t.closest("tr"); v.draft[row.dataset.role].splice(+row.dataset.i, 1); hooks.render(); break; }
    case "save-chart":
      if (await attempt(() => api("PUT", `/api/charts/${f.id}`, v.draft), "Steps saved for both of you")) { v.editing = false; v.draft = null; v.step = -1; await refresh(); hooks.render(); }
      break;
    case "reset-chart":
      if (!confirmTap(t, "Discard your edits?")) break;
      await attempt(() => api("DELETE", `/api/charts/${f.id}`), "Back to the starter chart"); await refresh(); hooks.render(); break;
    case "ai-chart":
      v.drafting = true; hooks.render();
      await attempt(() => api("POST", `/api/charts/${f.id}/draft`), "Claude's chart is saved. Check it against your book");
      v.drafting = false; v.step = -1; await refresh(); hooks.render(); break;
    case "new-routine-with": {
      const d = danceOf(f.dance);
      const r = await attempt(() => api("POST", "/api/routines", { name: `${f.level} ${d.name}`, dance: d.id, level: f.level, items: [{ type: "fig", fig: f.id }] }));
      if (r) { await refresh(); history.pushState(null, "", BASE + "/routines/" + r.id); hooks.route(); }
      break;
    }
    case "vid-del":
      if (!confirmTap(t, "Remove for both?")) break;
      await attempt(() => api("DELETE", "/api/videos/" + t.dataset.id), "Video removed"); await refresh(); hooks.render(); break;
  }
}

// a single step animated on its own (prev / next buttons)
function animateTo(k) {
  const t0 = performance.now(), d = v.ctx.d, dur = Math.min(900, 60000 / (tempoMid(d) * d.bpb) * (+v.ctx.steps[k].b || 1));
  const tick = (now) => { const u = Math.min(1, (now - t0) / dur); paint(k + u * 0.999); if (u < 1 && !player.playing && v.step === k) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

function onInput(ev) {
  const t = ev.target;
  if (t.id === "figSearch") { v.q = t.value; $("#figGroups").innerHTML = figList(); return; }
  if (v.editing && t.closest("table.edit")) {
    const row = t.closest("tr"), s = v.draft[row.dataset.role][+row.dataset.i], k = t.dataset.k;
    s[k] = t.type === "checkbox" ? t.checked : k === "t" || k === "b" ? +t.value : t.value;
    if (k === "mv" && !t.value) delete s.mv;
    return;
  }
  if (t.dataset.start) { v.draft.start[t.dataset.start] = t.value; return; }
  if (t.id === "edTiming") v.draft.timing = t.value;
}

async function onChange(ev) {
  const t = ev.target, f = S.figs.get(v.fig);
  if (t.id === "figNote") {
    if (await attempt(() => api("PUT", `/api/notes/${f.id}`, { text: t.value }))) { $("#noteSaved").textContent = "Saved for both of you"; refresh(); }
  } else if (t.id === "addToR" && t.value) {
    const r = S.routines.find((x) => x.id === t.value);
    if (await attempt(() => api("PATCH", `/api/routines/${r.id}`, { base_rev: r.rev, items: [...r.items, { type: "fig", fig: f.id }] }), `Added to ${r.name}`)) { await refresh(); hooks.render(); }
  } else if (t.id === "speed") {
    ls.set("speed", +t.value); const was = player.playing; setupStage(); if (was) player.play(Math.max(0, v.step));
  } else if (t.dataset.upload && t.files?.[0]) {
    uploadVideoFrom(t);
  }
}

async function onSubmit(ev) {
  ev.preventDefault();
  const fm = ev.target;
  if (fm.dataset.vidform) {
    const fd = new FormData(fm); fd.append("ref", fm.dataset.vidform);
    if (await attempt(() => api("POST", "/api/videos", fd), "Video link added")) { await refresh(); hooks.render(); }
  }
}

function uploadVideoFrom(input) {
  uploadVideo(input.dataset.upload, input.files[0], document.querySelector(`[data-upstatus="${CSS.escape(input.dataset.upload)}"]`));
  input.value = "";
}

/** Keep the stage animating across the poll-driven re-renders. */
export function isBusy() { return player.playing || v.editing || v.drafting; }
export function reRole() { v.lastCallout = null; if (v.ctx) { const was = player.playing; setupStage(); if (was) player.play(Math.max(0, v.step)); } }
