// Lessons: what each group covered. The committee records the figures, the routine danced, videos and comments.
import {
  $, BASE, S, api, attempt, canUseAI, chartBeats, chartFor, confirmTap, danceOf, esc, fmtDate, fmtDay, groupName, hooks,
  isAdmin, isCommittee, ls, refresh, setAccent, slug, toast, today, uploadVideo, userName, videoBlock, figTag,
} from "../core.js";
import * as R from "../recorder.js";

/** A dance's figures for pickers: the ISTD levels, then the figures only the BDC syllabus has. */
const pickGroups = (d) => [...S.levels.map((L) => [L, d.levels[L]]), ["BDC only", d.bdc.filter((n) => !S.figs.get(d.id + "." + slug(n))?.level)]].filter(([, ns]) => ns.length);
import { drawFloor, planRoutine, roomFor, roomSelect, routineSegs } from "../floor.js";

const v = { filter: ls.get("lessonFilter", "mine"), comments: {}, picking: false, pickDance: null,
  // recordings: per lesson the list and unsent in-browser recordings; per recording unsaved notes and figures heard
  recs: {}, leftovers: {}, recDraft: {}, recFigs: {}, recPrompt: {}, recOk: false, recKeep: false, upload: "", uploading: false };

export function render(el, params) {
  if (params.id) return renderLesson(el, params.id);
  const mine = S.me.groups;
  const shown = S.lessons.filter((l) => v.filter === "all" || (v.filter === "mine" ? !mine.length || !l.group_id || mine.includes(l.group_id) : l.group_id === +v.filter));
  const vids = (id) => S.videos.filter((x) => x.ref === "lesson:" + id).length;
  el.innerHTML = `
  <div class="pagehead"><div><div class="eyebrow">Lessons</div><h1 class="display">What we've covered</h1></div>
    ${isCommittee() ? `<button class="btn solid" data-act="new">Record a lesson</button>` : ""}</div>
  <div class="filters" role="group" aria-label="Show lessons for">
    ${[["mine", mine.length ? "My groups" : "All groups"], ...(mine.length ? [["all", "Everyone"]] : []), ...S.groups.map((g) => [String(g.id), g.name])]
      .map(([k, l]) => `<button data-filter="${k}" aria-pressed="${v.filter === k}">${esc(l)}</button>`).join("")}
  </div>
  ${!mine.length ? `<p class="small muted">Pick your groups on <a href="${BASE}/account" data-link>your account</a> to see just their lessons.</p>` : ""}
  <div class="lessonlist">${shown.map((l) => {
    const d = danceOf(l.dance);
    return `<a class="lcard" href="${BASE}/lessons/${l.id}" data-link>
      <span class="ldate"><b>${esc(fmtDay(l.date, { weekday: undefined }))}</b><span>${esc(fmtDay(l.date, { day: undefined, month: undefined, year: undefined }))}</span></span>
      <span class="lbody"><span class="nm">${esc(l.title || (d ? d.name : "Lesson"))}</span>
        <span class="small muted">${esc(groupName(l.group_id))}${d ? " · " + esc(d.name) : ""} · ${l.figures.length} figure${l.figures.length === 1 ? "" : "s"}${l.items.length ? " · routine" : ""}${vids(l.id) ? ` · ▶ ${vids(l.id)}` : ""}</span></span>
      ${d ? `<span class="sw c-${d.color}"></span>` : ""}</a>`;
  }).join("") || `<div class="panel pad empty">No lessons recorded yet${isCommittee() ? ". Record the first one after your next class." : "."}</div>`}</div>`;
  el.onclick = async (ev) => {
    const f = ev.target.closest("[data-filter]");
    if (f) { v.filter = f.dataset.filter; ls.set("lessonFilter", v.filter); render(el, params); return; }
    if (ev.target.closest('[data-act="new"]')) {
      const r = await attempt(() => api("POST", "/api/lessons", { date: today(), group_id: S.me.groups[0] ?? null, dance: ls.get("dance", "waltz") }));
      if (r) { await refresh(); history.pushState(null, "", `${BASE}/lessons/${r.id}`); hooks.route(); }
    }
  };
  el.onchange = el.oninput = el.onsubmit = null;
}

// ── one lesson ──────────────────────────────────────────────────────────

const payload = (l) => ({ date: l.date, group_id: l.group_id, dance: l.dance, title: l.title, summary: l.summary, figures: l.figures, items: l.items });

async function save(l, patch, msg) {
  const next = { ...l, ...patch };
  if (await attempt(() => api("PUT", `/api/lessons/${l.id}`, payload(next)), msg)) { await refresh(); hooks.render(); }
}

function renderLesson(el, id) {
  const l = S.lessons.find((x) => x.id === id);
  if (!l) { el.innerHTML = `<div class="panel pad empty">That lesson has been deleted. <a href="${BASE}/lessons" data-link>Back to lessons</a></div>`; return; }
  const edit = isCommittee(), d = danceOf(l.dance);
  setAccent(l.dance || "waltz");
  if (!v.pickDance) v.pickDance = l.dance || "waltz";
  if (!v.comments[id]) loadComments(id);
  if (!v.recs[id]) { v.recs[id] = null; loadRecs(id); R.leftovers(id).then((x) => { v.leftovers[id] = x; paintRecs(id); }); }
  const figs = l.figures.map((f) => S.figs.get(f)).filter(Boolean);
  el.innerHTML = `
  <a class="back small" href="${BASE}/lessons" data-link>← All lessons</a>
  <header class="panel pad lessonhead">
    ${edit ? `<div class="row">
      <label class="field">Date<input class="input auto" type="date" id="lDate" value="${esc(l.date)}"></label>
      <label class="field">Group<select class="input auto" id="lGroup"><option value="">All groups</option>${S.groups.map((g) => `<option value="${g.id}" ${g.id === l.group_id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}</select></label>
      <label class="field">Dance<select class="input auto" id="lDance"><option value="">Mixed</option>${S.dances.map((x) => `<option value="${x.id}" ${x.id === l.dance ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
    </div>
    <input class="title display" id="lTitle" value="${esc(l.title)}" placeholder="${esc(d ? d.name + " lesson" : "Lesson title")}" aria-label="Lesson title">
    <textarea class="input" id="lSummary" placeholder="What the teacher said, what to work on before next week…">${esc(l.summary)}</textarea>`
    : `<div class="eyebrow">${esc(fmtDay(l.date))} · ${esc(groupName(l.group_id))}${d ? " · " + esc(d.name) : ""}</div>
    <h1 class="display">${esc(l.title || (d ? d.name + " lesson" : "Lesson"))}</h1>
    ${l.summary ? `<p class="prewrap">${esc(l.summary)}</p>` : ""}`}
    <p class="small muted">Recorded by ${esc(userName(l.created_by))}${l.updated_by !== l.created_by ? ` · updated by ${esc(userName(l.updated_by))}` : ""} · ${fmtDate(l.updated_at)}</p>
  </header>

  <div class="sec-title"><span>Figures covered</span>${edit ? `<span class="acts"><button class="btn sm" data-act="pick">${v.picking ? "Done" : "Tick off figures"}</button></span>` : ""}</div>
  ${figs.length ? `<div class="pf">${figs.map((f) => `<a class="pfc" href="${BASE}/syllabus/${f.dance}/${f.slug}" data-link>${f.level ? `<span class="medal m-${f.level}"></span>` : `<span class="bdctag">BDC</span>`} ${esc(f.name)}${l.dance ? "" : ` <span class="small muted">${esc(danceOf(f.dance).name)}</span>`}</a>`).join("")}</div>`
    : `<p class="muted small">No figures ticked off yet.</p>`}
  ${edit && v.picking ? picker(l) : ""}

  <div class="sec-title"><span>The routine we did</span>${l.items.length ? `<span class="acts"><a class="btn sm acc" href="${BASE}/practice/lesson/${l.id}" data-link>▶ Practise it</a></span>` : ""}</div>
  ${itemsBlock(l, edit)}
  ${l.items.length && l.dance ? `<div class="floorwrap"><svg class="floor" id="lFloor" role="img" aria-label="The lesson routine round the room"></svg></div><div class="row small">${roomSelect()}</div>` : ""}

  <div class="sec-title"><span>Recordings</span></div>
  <section id="recs" data-lesson="${esc(id)}">${recsBlock(l)}</section>

  <div class="two">
    <section><div class="sec-title"><span>Videos</span></div>${videoBlock("lesson:" + l.id, edit)}</section>
    <section><div class="sec-title"><span>Comments</span></div>${commentsBlock(id)}</section>
  </div>
  ${edit ? `<p><button class="btn ghost sm danger" data-act="del">Delete this lesson</button></p>` : ""}`;
  if ($("#lFloor")) drawFloor($("#lFloor"), planRoutine(routineSegs(l), roomFor(), d?.style === "Latin"), null);

  el.onclick = async (ev) => {
    if (ev.target.closest(".recupload") && !v.recOk) { ev.preventDefault(); toast("Tick the box first: the teacher and class should know you're recording"); return; }
    const rt = ev.target.closest("[data-ract]");
    if (rt) return recAction(rt, l);
    const t = ev.target.closest("[data-act], [data-fig-toggle], [data-pick-dance], [data-cdel]");
    if (!t) return;
    if (t.dataset.figToggle) {
      const on = l.figures.includes(t.dataset.figToggle);
      return save(l, { figures: on ? l.figures.filter((f) => f !== t.dataset.figToggle) : [...l.figures, t.dataset.figToggle] });
    }
    if (t.dataset.pickDance) { v.pickDance = t.dataset.pickDance; return hooks.render(); }
    if (t.dataset.cdel) {
      if (!confirmTap(t, "Remove?")) return;
      if (await attempt(() => api("DELETE", `/api/lesson-comments/${t.dataset.cdel}`))) { delete v.comments[id]; loadComments(id); }
      return;
    }
    const i = +t.dataset.i, items = [...l.items];
    switch (t.dataset.act) {
      case "pick": v.picking = !v.picking; hooks.render(); break;
      case "up": case "down": { const j = t.dataset.act === "up" ? i - 1 : i + 1; [items[i], items[j]] = [items[j], items[i]]; save(l, { items }); break; }
      case "rm": items.splice(i, 1); save(l, { items }); break;
      case "add-fig": save(l, { items: [...items, { type: "fig", fig: $("#lAddFig").value }] }); break;
      case "add-mark": save(l, { items: [...items, { type: "mark", label: $("#lAddMark").value }] }); break;
      case "copy-covered": save(l, { items: [...items, ...l.figures.filter((f) => S.figs.get(f)?.dance === l.dance).map((fig) => ({ type: "fig", fig }))] }); break;
      case "vid-del":
        if (!confirmTap(t, "Remove for everyone?")) break;
        await attempt(() => api("DELETE", "/api/videos/" + t.dataset.id), "Video removed"); await refresh(); hooks.render(); break;
      case "del":
        if (!confirmTap(t, "Delete for everyone?")) break;
        if (await attempt(() => api("DELETE", `/api/lessons/${l.id}`), "Lesson deleted")) { await refresh(); history.pushState(null, "", BASE + "/lessons"); hooks.route(); }
        break;
    }
  };
  el.oninput = (ev) => { if (ev.target.dataset.notes) v.recDraft[ev.target.dataset.notes] = ev.target.value; };
  el.onchange = (ev) => {
    const t = ev.target;
    if (t.id === "recOk") v.recOk = t.checked;
    else if (t.id === "recKeep") v.recKeep = t.checked;
    else if (t.id === "recFile" && t.files?.[0]) { const f = t.files[0]; t.value = ""; uploadRecording(id, f, f.name).then((ok) => ok && loadRecs(id)); }
    else if (t.dataset.notes) return;
    else if (t.id === "lDate") save(l, { date: t.value || l.date });
    else if (t.id === "lGroup") save(l, { group_id: t.value ? +t.value : null });
    else if (t.id === "lDance") { v.pickDance = t.value || v.pickDance; save(l, { dance: t.value }); }
    else if (t.id === "lTitle") save(l, { title: t.value }, "Saved");
    else if (t.id === "lSummary") save(l, { summary: t.value }, "Saved");
    else if (t.dataset.k && t.closest(".item")) save(l, { items: l.items.map((x, i) => (i === +t.dataset.i ? { ...x, notes: t.value } : x)) });
    else if (t.dataset.room !== undefined) { ls.set("room", t.value); hooks.render(); }
    else if (t.dataset.upload && t.files?.[0]) { uploadVideo(t.dataset.upload, t.files[0], el.querySelector(`[data-upstatus="${CSS.escape(t.dataset.upload)}"]`)); t.value = ""; }
  };
  el.onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    if (f.id === "cForm") {
      const r = await attempt(() => api("POST", `/api/lessons/${id}/comments`, { text: f.text.value }));
      if (r) { v.comments[id] = r; hooks.render(); }
    } else if (f.dataset.vidform) {
      const fd = new FormData(f); fd.append("ref", f.dataset.vidform);
      if (await attempt(() => api("POST", "/api/videos", fd), "Video link added")) { await refresh(); hooks.render(); }
    }
  };
}

function picker(l) {
  const d = danceOf(v.pickDance) || S.dances[0];
  return `<div class="panel pad picker">
    <div class="filters">${S.dances.map((x) => `<button data-pick-dance="${x.id}" aria-pressed="${x.id === d.id}">${esc(x.name)}</button>`).join("")}</div>
    ${pickGroups(d).map(([L, names]) => `<div class="pgroup"><h4>${L === "BDC only" ? `<span class="bdctag">BDC</span>` : `<span class="medal m-${L}"></span>`}${L}</h4><div class="pf">${names.map((n) => {
      const id = d.id + "." + slug(n), on = l.figures.includes(id);
      return `<button class="pfc tick ${on ? "on" : ""}" data-fig-toggle="${id}" aria-pressed="${on}">${on ? "✓ " : ""}${esc(n)}</button>`;
    }).join("")}</div></div>`).join("")}
  </div>`;
}

function itemsBlock(l, edit) {
  const d = danceOf(l.dance);
  let n = 0;
  const rows = l.items.map((it, i) => {
    const acts = edit ? `<span class="acts"><button class="iconbtn" data-act="up" data-i="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button><button class="iconbtn" data-act="down" data-i="${i}" ${i === l.items.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button><button class="iconbtn" data-act="rm" data-i="${i}" aria-label="Remove">✕</button></span>` : "";
    if (it.type === "mark") return `<div class="mark"><span class="lbl">${esc(it.label)}</span>${acts}</div>`;
    n++;
    const f = it.fig && S.figs.get(it.fig), c = it.fig && chartFor(it.fig);
    return `<div class="item lesson"><span class="n mono">${String(n).padStart(2, "0")}</span>
      <div class="fname">${f ? `<a href="${BASE}/syllabus/${f.dance}/${f.slug}" data-link>${esc(f.name)}</a>` : `<b>${esc(it.name)}</b>`}
        <span class="small muted">${f ? figTag(f) : ""}${c && d ? ((b) => ` · ${b} bar${b === 1 ? "" : "s"}`)(+(chartBeats(c) / d.bpb).toFixed(1)) : ""}</span></div>
      ${edit ? `<label class="notes"><span class="sr">Notes</span><input class="input" data-k="notes" data-i="${i}" value="${esc(it.notes || "")}" placeholder="Alignment, timing…"></label>` : `<span class="notes small">${esc(it.notes || "")}</span>`}
      ${acts}</div>`;
  }).join("");
  const adder = edit ? (d ? `<div class="adder"><select class="input" id="lAddFig" aria-label="Figure to add">${pickGroups(d).map(([L, names]) => `<optgroup label="${L}">${names.map((nm) => `<option value="${d.id}.${slug(nm)}">${esc(nm)}</option>`).join("")}</optgroup>`).join("")}</select>
      <button class="btn solid" data-act="add-fig">Add figure</button><select class="input auto" id="lAddMark" aria-label="Floor marker"><option>Long side</option><option>Short side</option><option>Corner</option></select><button class="btn" data-act="add-mark">Add marker</button>
      ${l.figures.length && !l.items.length ? `<button class="btn ghost" data-act="copy-covered">Use the figures covered</button>` : ""}</div>`
    : `<p class="small muted">Pick the lesson's dance above to build the routine.</p>`) : "";
  return `<div class="items">${rows || `<p class="muted small">${edit ? "No routine recorded yet." : "No routine recorded for this lesson."}</p>`}</div>${adder}`;
}

function commentsBlock(id) {
  const list = v.comments[id];
  return `<div class="comments">${!list ? `<p class="small muted">Loading…</p>` : list.map((c) => `<div class="comment"><div class="small"><b>${esc(userName(c.user_id))}</b> <span class="muted">${fmtDate(c.created_at)}</span>
    ${c.user_id === S.me.id || isCommittee() ? `<button class="linkish small" data-cdel="${c.id}">Remove</button>` : ""}</div><p class="prewrap">${esc(c.text)}</p></div>`).join("") || `<p class="small muted">No comments yet.</p>`}
    <form id="cForm" class="stack"><textarea class="input" name="text" required placeholder="Add a comment: what clicked, what to practise, questions for next week"></textarea><button class="btn" type="submit">Post comment</button></form></div>`;
}

async function loadComments(id) {
  const r = await attempt(() => api("GET", `/api/lessons/${id}/comments`));
  if (r) { v.comments[id] = r; const box = document.querySelector(".comments"); if (box) hooks.render(); }
}

// ── recordings of the lesson ────────────────────────────────────────────

const POCKET_TIPS = `<details class="small muted rectips"><summary>Recording with the phone in a pocket, or on a watch</summary>
  <p><b>Most reliable:</b> your watch or phone's own voice recorder (Apple Watch or iPhone Voice Memos, Samsung Voice Recorder,
  Google Recorder). They keep recording with the screen off. Afterwards share or save the file (m4a, mp3…) and upload it here.</p>
  <p><b>Recording here:</b> the page keeps the screen awake while it records, so dim it rather than locking it. Android Chrome
  usually carries on with the screen off, though some battery savers stop it. On iPhone, recording stops if the screen locks or
  you switch apps. Whatever was recorded is kept on the phone and you can send it, then start another recording.</p>
  <p>The teacher's voice comes out clearest from a phone near where they stand rather than in a pocket under a jacket.</p></details>`;

function recsBlock(l) {
  const list = v.recs[l.id], left = v.leftovers[l.id] || [], live = R.rec.state === "recording" && R.rec.lesson === l.id;
  const busyElsewhere = R.rec.state === "recording" && !live;
  return `<div class="panel pad recbox">
    <p class="small"><b>Before you record:</b> a recording picks up everyone nearby, so ask the teacher and the class first.
      Only you and the committee can read the transcript. The audio is deleted once it's transcribed unless you keep it, and you can delete everything at any time.</p>
    ${live ? `<div class="row recnow"><span class="recdot" aria-hidden="true"></span><b class="mono" data-rectime>${R.clock(Date.now() - R.rec.started)}</b>
        <span class="small muted">${R.rec.locked ? "Keeping the screen on" : "Keep the screen on"}${R.rec.gaps ? ` · the microphone was interrupted ${R.rec.gaps}×` : ""}</span>
        <button class="btn solid" data-ract="stop">Stop and send</button></div>
      <p class="small muted">Dim the screen rather than locking it. On iPhone recording stops if the screen locks or you switch apps; what's recorded so far is kept.</p>`
    : `<label class="check"><input type="checkbox" id="recOk" ${v.recOk ? "checked" : ""}> The teacher and class know I'm recording</label>
      <label class="check"><input type="checkbox" id="recKeep" ${v.recKeep ? "checked" : ""}> Keep the audio after it's transcribed</label>
      <div class="row">${R.canRecord() && !busyElsewhere ? `<button class="btn acc" data-ract="start">● Record the lesson</button>` : ""}
        <label class="btn upload recupload">Upload a recording<input type="file" id="recFile" accept="audio/*,.m4a,.mp3,.wav,.webm,.ogg,.opus,.aac" hidden></label></div>
      ${busyElsewhere ? `<p class="small muted">You're recording another lesson. <a href="${BASE}/lessons/${R.rec.lesson}" data-link>Go back to it</a> to stop.</p>` : ""}
      ${POCKET_TIPS}`}
    <div class="saved" id="recStatus">${esc(v.upload)}</div>
    ${left.filter((x) => x.id !== v.sending).map((x) => `<div class="row small leftover"><span>${R.rec.id === x.id && R.rec.stoppedBy === "phone" ? "Recording stopped: the phone took the microphone away (screen locked or another app). " : ""}A recording from ${esc(new Date(x.started).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }))}
      (${R.clock(x.ms)}) hasn't been sent.</span><button class="btn sm solid" data-ract="send-left" data-id="${x.id}">Send it</button>
      <button class="btn sm ghost danger" data-ract="drop-left" data-id="${x.id}">Discard</button></div>`).join("")}
  </div>
  ${!list ? `<p class="small muted">Loading…</p>` : list.map((r) => recCard(r, l)).join("")}`;
}

function recCard(r, l) {
  const mine = r.user_id === S.me.id, pct = Math.round(r.progress * 100);
  const head = `<div class="row between"><b>${mine ? "Your recording" : esc(userName(r.user_id)) + "'s recording"}</b>
    <span class="small muted">${fmtDate(r.created_at)}${r.duration ? " · " + R.clock(r.duration * 1000) : ""}</span></div>`;
  const tail = `<div class="row">${r.has_audio && r.status === "done" ? `<audio controls preload="none" src="${BASE}/api/recordings/${r.id}/audio"></audio>
      <button class="btn sm ghost" data-ract="drop-audio" data-id="${r.id}">Delete the audio</button>` : ""}
    <button class="btn sm ghost danger" data-ract="del" data-id="${r.id}">Delete recording</button></div>`;
  const transcript = (label) => (r.transcript ? `<details class="small"><summary>${label}</summary><pre class="transcript">${esc(r.transcript)}</pre></details>` : "");
  if (r.status === "queued") return `<div class="panel pad reccard">${head}<p class="small muted">Waiting to be transcribed${r.ahead ? ` (${r.ahead} ahead of it)` : ""}…</p>${tail}</div>`;
  if (r.status === "running") return `<div class="panel pad reccard">${head}
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
    <p class="small muted">Transcribing on the server: ${pct ? pct + "%" : "starting"}. You can leave this page; it carries on.</p>${transcript("The transcript so far")}${tail}</div>`;
  if (r.status === "failed") return `<div class="panel pad reccard">${head}<p class="small bad">${esc(r.error)}</p>
    ${r.has_audio ? `<button class="btn sm" data-ract="retry" data-id="${r.id}">Try again</button>` : ""}${tail}</div>`;
  const text = v.recDraft[r.id] ?? r.notes, figs = (v.recFigs[r.id] || r.figures || []).filter((f) => !l.figures.includes(f) && S.figs.get(f));
  return `<div class="panel pad reccard">${head}
    ${transcript(((n) => `Transcript (${n} line${n === 1 ? "" : "s"})`)(r.transcript.split("\n").length)) || `<p class="small muted">Nothing was heard in this recording.</p>`}
    ${mine ? `<label class="field">Notes<textarea class="input recnotes" data-notes="${r.id}" rows="9"
        placeholder="Pick notes out of the transcript with a button below, or paste the notes Claude wrote for you">${esc(text)}</textarea></label>
      <div class="row"><button class="btn sm" data-ract="rough" data-id="${r.id}">Rough notes (free)</button>
        <button class="btn sm" data-ract="copy" data-id="${r.id}">Copy transcript for Claude</button>
        ${isAdmin() && canUseAI() ? `<button class="btn sm" data-ract="claude" data-id="${r.id}">Draft with Claude (API)</button>` : ""}
        <button class="btn sm solid" data-ract="save" data-id="${r.id}">Save notes</button></div>
      <p class="small muted">“Copy transcript for Claude” copies it with instructions. Paste that into your own Claude chat, then paste the notes it writes back here and save.</p>
      ${v.recPrompt[r.id] ? `<label class="field">Couldn't copy automatically: select all of this and copy it<textarea class="input" rows="4" readonly>${esc(v.recPrompt[r.id])}</textarea></label>` : ""}`
    : r.notes ? `<p class="prewrap">${esc(r.notes)}</p>` : `<p class="small muted">No notes from it yet.</p>`}
    ${text.trim() ? `<div class="row">${mine ? `<button class="btn sm" data-ract="comment" data-id="${r.id}">Post the notes as a comment</button>` : ""}
      ${isCommittee() ? `<button class="btn sm" data-ract="summary" data-id="${r.id}">Add to the lesson summary</button>` : ""}
      ${isCommittee() && figs.length ? `<button class="btn sm" data-ract="figs" data-id="${r.id}">Tick off ${figs.map((f) => esc(S.figs.get(f).name)).join(", ")}</button>` : ""}</div>` : ""}
    ${tail}</div>`;
}

function paintRecs(id) {
  const box = document.getElementById("recs"), a = document.activeElement;
  if (!box || box.dataset.lesson !== id || (box.contains(a) && a.tagName === "TEXTAREA")) return;
  const l = S.lessons.find((x) => x.id === id);
  if (l) box.innerHTML = recsBlock(l);
}

let recTimer = null;
async function loadRecs(id) {
  clearTimeout(recTimer);
  try { v.recs[id] = await api("GET", `/api/lessons/${id}/recordings`); paintRecs(id); } catch {}
  // while one is being transcribed, keep checking on it (only while this lesson is on screen)
  if ((v.recs[id] || []).some((r) => r.status === "queued" || r.status === "running"))
    recTimer = setTimeout(() => { if (document.getElementById("recs")?.dataset.lesson === id) loadRecs(id); }, 4000);
}
setInterval(() => { const e = document.querySelector("[data-rectime]"); if (e && R.rec.state === "recording") e.textContent = R.clock(Date.now() - R.rec.started); }, 1000);

function uploadRecording(lid, blob, name) {
  const say = (m) => { v.upload = m; const s = document.getElementById("recStatus"); if (s) s.textContent = m; };
  return new Promise((done) => {
    const fd = new FormData(); fd.append("file", blob, name); fd.append("keep_audio", v.recKeep ? "true" : "false");
    const xhr = new XMLHttpRequest();
    v.uploading = true;
    xhr.open("POST", `${BASE}/api/lessons/${lid}/recordings`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) say(`Uploading… ${Math.round((e.loaded / e.total) * 100)}%`); };
    xhr.onload = () => {
      v.uploading = false;
      if (xhr.status < 300) { say("Uploaded. The server transcribes it in about a fifth of the recording's length; it'll appear below."); return done(true); }
      let m = "Upload didn't work. Try again"; try { m = JSON.parse(xhr.responseText).detail || m; } catch {}
      say(m); done(false);
    };
    xhr.onerror = () => { v.uploading = false; say("Upload didn't work. Check your connection and try again"); done(false); };
    xhr.send(fd);
  });
}

async function sendLeftover(lid, recId) {
  v.sending = recId;
  const blob = await R.blobOf(recId);
  const l = S.lessons.find((x) => x.id === lid);
  if (await uploadRecording(lid, blob, `lesson-${l?.date || today()}${R.extFor(blob.type)}`)) await R.forget(recId);
  else v.upload += " The recording is kept on this device: send it again from here.";
  v.sending = null;
  v.leftovers[lid] = await R.leftovers(lid);
  loadRecs(lid);
}

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch {}
  const t = Object.assign(document.createElement("textarea"), { value: s });
  document.body.append(t); t.select();
  let ok = false; try { ok = document.execCommand("copy"); } catch {}
  t.remove();
  return ok;
}

async function saveNotes(r, text, msg) {
  const out = await attempt(() => api("PUT", `/api/recordings/${r.id}/notes`, { text }), msg);
  if (out) { r.notes = text; delete v.recDraft[r.id]; v.recFigs[r.id] = out.figures; }
  return out;
}

async function recAction(t, l) {
  const id = t.dataset.id, r = (v.recs[l.id] || []).find((x) => x.id === id), text = () => (v.recDraft[id] ?? r?.notes ?? "").trim();
  const repaint = () => paintRecs(l.id);
  switch (t.dataset.ract) {
    case "start":
      if (!v.recOk) return toast("Tick the box first: the teacher and class should know you're recording");
      try {
        await R.start(l.id, async () => { if (R.rec.state === "stopped") v.leftovers[l.id] = await R.leftovers(l.id); repaint(); });
      } catch (e) { toast(e?.name === "NotAllowedError" ? "Allow the microphone to record the lesson" : "Couldn't start the microphone on this device"); }
      return repaint();
    case "stop": { t.disabled = true; const recId = await R.stop(); return sendLeftover(l.id, recId); }
    case "send-left": t.disabled = true; return sendLeftover(l.id, id);
    case "drop-left":
      if (!confirmTap(t, "Discard for good?")) return;
      await R.forget(id); v.leftovers[l.id] = await R.leftovers(l.id); return repaint();
    case "retry": if (await attempt(() => api("POST", `/api/recordings/${id}/retry`), "Queued again")) loadRecs(l.id); return;
    case "del":
      if (!confirmTap(t, "Delete transcript and audio?")) return;
      if (await attempt(() => api("DELETE", `/api/recordings/${id}`), "Recording deleted")) loadRecs(l.id);
      return;
    case "drop-audio":
      if (!confirmTap(t, "Delete the audio?")) return;
      if (await attempt(() => api("PATCH", `/api/recordings/${id}`, { keep_audio: false }), "Audio deleted")) loadRecs(l.id);
      return;
    case "rough": case "copy": {
      const d = await attempt(() => api("GET", `/api/recordings/${id}/draft`));
      if (!d) return;
      if (t.dataset.ract === "rough") {
        if (text() && !confirmTap(t, "Replace your notes?")) return;
        v.recDraft[id] = d.notes; v.recFigs[id] = d.figures; repaint();
        return toast("Rough notes picked out of the transcript. Check them, then save");
      }
      if (await copyText(d.prompt)) { delete v.recPrompt[id]; repaint(); return toast("Copied. Paste it into Claude, then paste its notes back here"); }
      v.recPrompt[id] = d.prompt; return repaint();
    }
    case "claude": {
      if (!confirmTap(t, "Uses the paid API: tap again")) return;
      t.disabled = true; t.textContent = "Drafting…";
      const d = await attempt(() => api("POST", `/api/recordings/${id}/draft`));
      if (d) { v.recDraft[id] = d.notes; v.recFigs[id] = d.figures; toast("Claude drafted the notes. Check them, then save"); }
      return repaint();
    }
    case "save": if (await saveNotes(r, text(), "Notes saved")) repaint(); return;
    case "comment": {
      if (!confirmTap(t, "Every member will see it: tap again")) return;
      if (!(await saveNotes(r, text()))) return;
      const c = await attempt(() => api("POST", `/api/lessons/${l.id}/comments`, { text: text() || r.notes }), "Posted as a comment");
      if (c) { v.comments[l.id] = c; hooks.render(); }
      return;
    }
    case "summary": return save(l, { summary: (l.summary.trim() ? l.summary.trim() + "\n\n" : "") + text() }, "Added to the lesson summary");
    case "figs": {
      const add = (v.recFigs[id] || r.figures || []).filter((f) => !l.figures.includes(f) && S.figs.get(f));
      return save(l, { figures: [...l.figures, ...add] }, `Ticked off ${add.length} figure${add.length === 1 ? "" : "s"}`);
    }
  }
}

export const isBusy = () => R.rec.state === "recording" || v.uploading;
