// Routines: list, editor (figures, floor markers, bars), partner sign-off with "what changed", and the Claude planner.
import {
  BASE, $, S, api, attempt, chartBeats, chartFor, confirmTap, sliceChart, stepRange, danceOf, esc, fmtDate, hooks, ls, refresh, setAccent, slug,
  tempoMid, toast, uploadVideo, userName, videoBlock,
} from "../core.js";
import { drawFloor, planRoutine, roomFor, roomSelect, routineSegs } from "../floor.js";

const v = { id: ls.get("rid", null), chat: {}, sending: false, diff: {}, pendingMsg: "" };

export const QUICK = [
  "Draft a full routine for one long side and a corner",
  "What can follow the last figure?",
  "Check the flow: precedes, follows and alignments",
  "Make it fit a short side",
  "Suggest one more interesting figure at my level",
];

function bars(r) {
  const d = danceOf(r.dance); let total = 0, unknown = 0;
  for (const it of r.items) {
    if (it.type !== "fig") continue;
    if (it.bars) total += +it.bars;
    else { const c = it.fig && sliceChart(chartFor(it.fig), stepRange(it.notes)); if (c) total += chartBeats(c) / d.bpb; else unknown++; }
  }
  return { total, unknown };
}
export const signedOff = (r) => Object.entries(r.approvals || {}).filter(([, rev]) => rev === r.rev).map(([u]) => +u);

export function render(el, params) {
  if (params.id) { v.id = params.id; ls.set("rid", v.id); }
  if (!S.routines.find((r) => r.id === v.id)) v.id = S.routines[0]?.id || null;
  const r = S.routines.find((x) => x.id === v.id);
  setAccent(r?.dance || ls.get("dance", "waltz"));
  el.innerHTML = `<div class="rsplit">
    <aside class="panel pad rlist" aria-label="Routines">
      <div class="sec-title"><span>Routines</span></div>
      <div class="rcards">${cards()}</div>
      <form class="newform" id="newRoutine">
        <div class="eyebrow">New routine</div>
        <input class="input" name="name" placeholder="e.g. Bronze Waltz for the medal test" required aria-label="Routine name">
        <div class="row nowrap"><select class="input" name="dance" aria-label="Dance">${S.dances.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select>
        <select class="input" name="level" aria-label="Highest level">${S.levels.map((L) => `<option>${L}</option>`).join("")}</select></div>
        <button class="btn solid" type="submit">Create routine</button>
      </form>
    </aside>
    <article id="rEditor">${r ? editor(r) : `<div class="panel pad empty">Your routines appear here: the figures in order, how many bars they take, both partners' sign-off, and Claude to help you plan.</div>`}</article>
  </div>`;
  el.onclick = onClick; el.onchange = onChange; el.onsubmit = onSubmit; el.onkeydown = onKey;
  if (r) { paintFloor(r); loadChat(r.id); loadDiff(r); }
}

const ALIGN_WORDS = { 45: "⅛", 90: "¼", 135: "⅜", 180: "½" };
function paintFloor(r) {
  const svg = $("#floorSvg"); if (!svg) return;
  const segs = routineSegs(r), d = danceOf(r.dance);
  const plan = planRoutine(segs, roomFor(), d.style === "Latin");
  const { offFloor } = drawFloor(svg, plan, null);
  const notes = [];
  if (offFloor) notes.push(`<li class="warn">The routine runs off this floor. Put a Corner marker before the figure that turns the corner${plan.corners ? " sooner" : ""}, or pick a bigger room.</li>`);
  for (const pc of plan.pieces) {
    const seg = segs[pc.si];
    if (pc.missing) notes.push(`<li>Figure ${pc.si + 1} (${esc(seg.name)}) has no chart yet, so its travel is missing from the plan.</li>`);
    else if (Math.abs(pc.jump) >= 45) notes.push(`<li>Figure ${pc.si + 1} (${esc(seg.name)}) starts ${ALIGN_WORDS[Math.abs(pc.jump)] || Math.abs(pc.jump) + "°"} to the ${pc.jump > 0 ? "right" : "left"} of where figure ${pc.si} finishes. Check the precede and follow, the corner marker, or which steps you dance (write “steps 4–6 only” in the notes).</li>`);
  }
  $("#floorNotes").innerHTML = notes.join("") || `<li class="ok">Each figure follows on from the last, and the routine fits this floor.</li>`;
}

function cards() {
  if (!S.routines.length) return `<p class="muted small">No routines yet. Create one below, then ask Claude to help fill it in.</p>`;
  return S.routines.map((r) => {
    const d = danceOf(r.dance), ok = signedOff(r).length, { total } = bars(r);
    return `<a class="rcard" href="${BASE}/routines/${r.id}" data-link aria-current="${r.id === v.id}"><span class="sw c-${d.color}"></span>
      <span class="nm">${esc(r.name)}</span>
      <span class="small muted">${esc(d.name)} · ${esc(r.level)} · ${r.items.filter((i) => i.type === "fig").length} figures · ${Math.round(total)} bars</span>
      <span class="agree ${ok >= 2 ? "yes" : "no"}">${ok >= 2 ? "✓ Agreed by both" : ok === 1 ? "◐ One sign-off so far" : "○ Not signed off"}</span></a>`;
  }).join("");
}

function editor(r) {
  const d = danceOf(r.dance), { total, unknown } = bars(r);
  const secs = (total / tempoMid(d)) * 60;
  const ok = signedOff(r), mine = ok.includes(S.me.id);
  const myOld = r.approvals?.[S.me.id];
  const allowed = S.levels.slice(0, S.levels.indexOf(r.level) + 1);
  let n = 0;
  const items = r.items.map((it, i) => {
    const ctrls = `<span class="acts"><button class="iconbtn" data-act="up" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button><button class="iconbtn" data-act="down" data-i="${i}" ${i === r.items.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button><button class="iconbtn" data-act="del" data-i="${i}" aria-label="Remove">✕</button></span>`;
    if (it.type === "mark") return `<div class="mark"><span class="lbl">${esc(it.label)}</span>${ctrls}</div>`;
    n++;
    const f = it.fig && S.figs.get(it.fig), c = it.fig && chartFor(it.fig);
    const auto = c ? +(chartBeats(sliceChart(c, stepRange(it.notes))) / d.bpb).toFixed(2) : "";
    const high = f && !allowed.includes(f.level);
    return `<div class="item"><span class="n mono">${String(n).padStart(2, "0")}</span>
      <div class="fname">${f ? `<a href="${BASE}/syllabus/${f.dance}/${f.slug}" data-link>${esc(f.name)}</a>` : `<b>${esc(it.name)}</b>`}
        <span class="small muted">${f ? `<span class="medal m-${f.level}"></span> ${f.level}` : "Not in the ISTD list"}${c ? "" : " · no chart yet"}${high ? ` <span class="warn">· above ${esc(r.level)}</span>` : ""}</span></div>
      <label class="bars"><span class="sr">Bars</span><input class="input mono" type="number" min="0" step="0.5" data-k="bars" data-i="${i}" value="${esc(it.bars ?? "")}" placeholder="${auto ? auto + " bars" : "bars"}"></label>
      <label class="notes"><span class="sr">Notes</span><input class="input" data-k="notes" data-i="${i}" value="${esc(it.notes || "")}" placeholder="Alignment, timing, who leads what…"></label>
      ${ctrls}</div>`;
  }).join("");
  const figOpts = allowed.map((L) => `<optgroup label="${L}">${d.levels[L].map((nm) => `<option value="${d.id}.${slug(nm)}">${esc(nm)}</option>`).join("")}</optgroup>`).join("");
  const diff = v.diff[`${r.id}:${myOld}:${r.rev}`];
  return `
  <section class="panel pad rhead">
    <div class="row between"><span class="eyebrow">${esc(d.name)} · ISTD up to ${esc(r.level)}${r.example ? " · example" : ""}</span>
      <span class="row"><a class="btn sm acc" href="${BASE}/practice/${r.id}" data-link>▶ Practise this routine</a><button class="btn sm ghost danger" data-act="r-del">Delete</button></span></div>
    <input class="title display" id="rName" value="${esc(r.name)}" aria-label="Routine name">
    <div class="row"><label class="row small muted"><abbr class="tip" data-tip="Only figures up to this ISTD medal level are offered, and Claude keeps to them. Bronze is the foundation, Silver and Gold each add harder figures.">Highest level</abbr> <select class="input auto" id="rLevel">${S.levels.map((L) => `<option ${L === r.level ? "selected" : ""}>${L}</option>`).join("")}</select></label></div>
    <div class="tot">
      <div><b class="mono">${r.items.filter((i) => i.type === "fig").length}</b><span>figures</span></div>
      <div><b class="mono">${total % 1 ? total.toFixed(1) : total}</b><span>bars${unknown ? ` + ${unknown} unknown` : ""}</span></div>
      <div><b class="mono">${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, "0")}</b><span>at ${Math.round(tempoMid(d))} bars/min</span></div>
      <div><b class="mono">v${r.rev}</b><span>version</span></div>
    </div>
    <div class="signoff">
      <div class="who">${ok.length ? ok.map((id) => `<span class="person ok">✓ ${esc(userName(id))}</span>`).join("") : `<span class="muted small">Nobody has signed off version ${r.rev} yet.</span>`}
        ${S.users.filter((u) => !ok.includes(u.id)).map((u) => `<span class="person">○ ${esc(userName(u.id))}</span>`).join("")}</div>
      ${mine ? `<button class="btn sm" data-act="unapprove">Withdraw my sign-off</button>` : `<button class="btn sm solid" data-act="approve">I'm happy with version ${r.rev}</button>`}
    </div>
    ${!mine && myOld && diff ? `<div class="changes"><b>Since you signed off version ${myOld}</b>${diff}</div>` : ""}
    <p class="small muted">Last change by ${esc(userName(r.updated_by))} · ${fmtDate(r.updated_at)}. Changing the figures starts a new version, so you both sign off again.</p>
  </section>
  <div class="sec-title"><span>Figures in order</span></div>
  <div class="items">${items || `<div class="panel pad empty">Empty so far. Add figures below, or ask Claude to draft a routine.</div>`}</div>
  <div class="adder"><select class="input" id="addFig" aria-label="Figure to add">${figOpts}</select><button class="btn solid" data-act="add-fig">Add figure</button>
    <select class="input auto" id="addMark" aria-label="Floor marker"><option>Long side</option><option>Short side</option><option>Corner</option><option>Start</option><option>Ending</option></select><button class="btn" data-act="add-mark">Add marker</button></div>
  <div class="sec-title"><span>Floor plan</span><span class="acts">${roomSelect()}</span></div>
  <div class="floorwrap"><svg class="floor" id="floorSvg" role="img" aria-label="The routine's path round the room"></svg></div>
  <ul class="floor-notes small" id="floorNotes"></ul>
  ${assistant(r, d)}
  <div class="sec-title"><span>Practice recordings and demo videos</span></div>
  ${videoBlock("routine:" + r.id)}`;
}

function assistant(r, d) {
  const log = v.chat[r.id];
  const msgs = (log || []).map((m) => m.role === "user"
    ? `<div class="msg me"><span class="by">${esc(userName(m.user_id))}</span>${esc(m.content)}</div>`
    : `<div class="msg cl">${esc(m.content)}</div>${m.proposal ? proposal(r, m) : ""}`).join("");
  return `<section class="ai" aria-label="Plan with Claude">
    <div class="row between"><h2 class="display h3">Plan it with Claude</h2>${log?.length ? `<button class="btn sm ghost onpop" data-act="clear-chat">Clear conversation</button>` : ""}</div>
    <p>Claude sees this routine, your brief and the ISTD ${esc(d.name)} list up to ${esc(r.level)}. It checks precedes and follows, alignment and floor craft, and can propose figures you add in one click. You and your partner share this conversation.</p>
    <label class="field onpop">Brief for Claude<textarea class="input" id="rBrief" placeholder="e.g. Medal test, small hall about 10 × 14 m, start on the long side facing DW, my partner finds the Whisk hard">${esc(r.brief || "")}</textarea></label>
    ${S.me.ai ? `
    <div class="quick">${QUICK.map((q) => `<button data-ask="${esc(q)}" ${v.sending ? "disabled" : ""}>${esc(q)}</button>`).join("")}</div>
    <div class="log" id="chatLog">${log ? msgs : `<p class="small">Loading the conversation…</p>`}${v.sending ? `<div class="msg me"><span class="by">You</span>${esc(v.pendingMsg)}</div><div class="msg cl thinking">Claude is thinking…</div>` : ""}</div>
    <form class="composer" id="chatForm"><textarea class="input" id="chatIn" placeholder="Ask about this routine…" aria-label="Message to Claude" ${v.sending ? "disabled" : ""}></textarea><button class="btn solid" type="submit" ${v.sending ? "disabled" : ""}>Send</button></form>`
    : `<p class="small">Add a Claude API key to the server to use the planner.</p>`}
  </section>`;
}

function proposal(r, m) {
  const p = m.proposal;
  return `<div class="proposal"><div class="eyebrow">Proposed ${p.mode === "append" ? "additions" : "routine"}</div><ol>${p.items.map((it) =>
    it.kind === "marker" ? `<li class="pm">${esc(it.figure)}</li>` : `<li><b>${esc(it.figure)}</b>${it.fig ? "" : ` <span class="warn">(not in the ISTD list)</span>`}${it.notes ? ` · ${esc(it.notes)}` : ""}</li>`).join("")}</ol>
    <div class="row"><button class="btn sm solid" data-act="use" data-m="${m.id}" data-mode="replace">Replace routine with this</button><button class="btn sm" data-act="use" data-m="${m.id}" data-mode="append">Add to the end</button></div></div>`;
}

async function loadChat(id) {
  if (v.chat[id] || !S.me.ai) return;
  const log = await attempt(() => api("GET", `/api/routines/${id}/chat`));
  if (log) { v.chat[id] = log; if (v.id === id) rerenderEditor(); }
}

async function loadDiff(r) {
  const old = r.approvals?.[S.me.id], key = `${r.id}:${old}:${r.rev}`;
  if (!old || old === r.rev) return;
  if (v.diff[key]) { v.diff[r.id] = v.diff[key]; return; }
  const ver = await attempt(() => api("GET", `/api/routines/${r.id}/versions/${old}`));
  if (!ver) return;
  const name = (it) => (it.type === "mark" ? `[${it.label}]` : S.figs.get(it.fig)?.name || it.name);
  const a = ver.items.map(name), b = r.items.map(name);
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const ca = count(a), cb = count(b), added = [], removed = [];
  for (const [k, n] of cb) for (let i = 0; i < n - (ca.get(k) || 0); i++) added.push(k);
  for (const [k, n] of ca) for (let i = 0; i < n - (cb.get(k) || 0); i++) removed.push(k);
  const lines = [];
  if (added.length) lines.push(`Added: ${added.join(", ")}`);
  if (removed.length) lines.push(`Removed: ${removed.join(", ")}`);
  if (!added.length && !removed.length && a.join() !== b.join()) lines.push("Figures were reordered");
  if (ver.level !== r.level) lines.push(`Level changed from ${ver.level} to ${r.level}`);
  if (!lines.length) lines.push("Bars or notes were changed");
  const html = `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
  v.diff[r.id] = html; v.diff[key] = html;
  if (v.id === r.id) rerenderEditor();
}

function rerenderEditor() {
  const r = S.routines.find((x) => x.id === v.id), ed = $("#rEditor");
  if (!r || !ed) return;
  const a = document.activeElement;
  if (a && ed.contains(a) && (a.tagName === "TEXTAREA" || a.tagName === "INPUT")) return;
  ed.innerHTML = editor(r);
  paintFloor(r);
  const lg = $("#chatLog"); if (lg) lg.scrollTop = lg.scrollHeight;
}

async function save(r, patch, okMsg) {
  const res = await attempt(() => api("PATCH", `/api/routines/${r.id}`, { base_rev: r.rev, ...patch }), okMsg);
  if (res) { await refresh(); hooks.render(); }
}

async function ask(r, text) {
  v.sending = true; v.pendingMsg = text; rerenderEditor();
  const log = await attempt(() => api("POST", `/api/routines/${r.id}/chat`, { message: text }));
  v.sending = false;
  if (log) v.chat[r.id] = log; else delete v.chat[r.id];
  rerenderEditor(); if (!log) loadChat(r.id);
}

async function onClick(ev) {
  const t = ev.target.closest("[data-act], [data-ask]"); if (!t) return;
  const r = S.routines.find((x) => x.id === v.id);
  if (t.dataset.ask) { ask(r, t.dataset.ask); return; }
  const i = +t.dataset.i;
  switch (t.dataset.act) {
    case "up": case "down": {
      const j = t.dataset.act === "up" ? i - 1 : i + 1, items = [...r.items];
      [items[i], items[j]] = [items[j], items[i]]; save(r, { items }); break;
    }
    case "del": { const items = [...r.items]; items.splice(i, 1); save(r, { items }); break; }
    case "add-fig": save(r, { items: [...r.items, { type: "fig", fig: $("#addFig").value }] }); break;
    case "add-mark": save(r, { items: [...r.items, { type: "mark", label: $("#addMark").value }] }); break;
    case "approve":
      if (await attempt(() => api("POST", `/api/routines/${r.id}/approve`, { rev: r.rev }), "Signed off. Your partner will see it")) { await refresh(); hooks.render(); }
      break;
    case "unapprove":
      if (await attempt(() => api("DELETE", `/api/routines/${r.id}/approve`))) { await refresh(); hooks.render(); }
      break;
    case "r-del":
      if (!confirmTap(t, "Delete for both of you?")) break;
      if (await attempt(() => api("DELETE", `/api/routines/${r.id}`), "Routine deleted")) { v.id = null; await refresh(); history.pushState(null, "", BASE + "/routines"); hooks.route(); }
      break;
    case "use": {
      const m = v.chat[r.id]?.find((x) => String(x.id) === t.dataset.m); if (!m) break;
      const items = m.proposal.items.map((it) => (it.kind === "marker" ? { type: "mark", label: it.figure } : { type: "fig", fig: it.fig, name: it.figure, notes: it.notes }));
      save(r, { items: t.dataset.mode === "append" ? [...r.items, ...items] : items }, t.dataset.mode === "append" ? "Added to the routine" : "Routine replaced. You'll both need to sign off again");
      break;
    }
    case "clear-chat":
      if (!confirmTap(t, "Clear for both of you?")) break;
      if (await attempt(() => api("DELETE", `/api/routines/${r.id}/chat`))) { v.chat[r.id] = []; rerenderEditor(); }
      break;
    case "vid-del":
      if (!confirmTap(t, "Remove for both?")) break;
      await attempt(() => api("DELETE", "/api/videos/" + t.dataset.id), "Video removed"); await refresh(); hooks.render(); break;
  }
}

function onChange(ev) {
  const t = ev.target, r = S.routines.find((x) => x.id === v.id); if (!r) return;
  if (t.dataset.room !== undefined) { ls.set("room", t.value); paintFloor(r); return; }
  if (t.id === "rName") save(r, { name: t.value });
  else if (t.id === "rLevel") save(r, { level: t.value });
  else if (t.id === "rBrief") save(r, { brief: t.value });
  else if (t.dataset.k && t.closest(".item")) {
    const k = t.dataset.k, items = r.items.map((x, i) => (i === +t.dataset.i ? { ...x, [k]: k === "bars" ? (t.value === "" ? null : +t.value) : t.value } : x));
    save(r, { items });
  } else if (t.dataset.upload && t.files?.[0]) {
    uploadVideo(t.dataset.upload, t.files[0], document.querySelector(`[data-upstatus="${CSS.escape(t.dataset.upload)}"]`)); t.value = "";
  }
}

async function onSubmit(ev) {
  ev.preventDefault();
  const fm = ev.target, r = S.routines.find((x) => x.id === v.id);
  if (fm.id === "newRoutine") {
    const fd = new FormData(fm);
    const res = await attempt(() => api("POST", "/api/routines", { name: fd.get("name"), dance: fd.get("dance"), level: fd.get("level") }));
    if (res) { await refresh(); history.pushState(null, "", BASE + "/routines/" + res.id); hooks.route(); }
  } else if (fm.id === "chatForm") {
    const text = $("#chatIn").value.trim(); if (text) ask(r, text);
  } else if (fm.dataset.vidform) {
    const fd = new FormData(fm); fd.append("ref", fm.dataset.vidform);
    if (await attempt(() => api("POST", "/api/videos", fd), "Video link added")) { await refresh(); hooks.render(); }
  }
}

function onKey(ev) {
  if (ev.target.id === "chatIn" && ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); $("#chatForm").requestSubmit(); }
}

export const isBusy = () => v.sending;
