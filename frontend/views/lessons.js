// Lessons: what each group covered. The committee records the figures, the routine danced, videos and comments.
import {
  $, BASE, S, api, attempt, chartBeats, chartFor, confirmTap, danceOf, esc, fmtDate, fmtDay, groupName, hooks,
  isCommittee, ls, refresh, setAccent, slug, today, uploadVideo, userName, videoBlock,
} from "../core.js";
import { drawFloor, planRoutine, roomFor, roomSelect, routineSegs } from "../floor.js";

const v = { filter: ls.get("lessonFilter", "mine"), comments: {}, picking: false, pickDance: null };

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
  ${figs.length ? `<div class="pf">${figs.map((f) => `<a class="pfc" href="${BASE}/syllabus/${f.dance}/${f.slug}" data-link><span class="medal m-${f.level}"></span> ${esc(f.name)}${l.dance ? "" : ` <span class="small muted">${esc(danceOf(f.dance).name)}</span>`}</a>`).join("")}</div>`
    : `<p class="muted small">No figures ticked off yet.</p>`}
  ${edit && v.picking ? picker(l) : ""}

  <div class="sec-title"><span>The routine we did</span>${l.items.length ? `<span class="acts"><a class="btn sm acc" href="${BASE}/practice/lesson/${l.id}" data-link>▶ Practise it</a></span>` : ""}</div>
  ${itemsBlock(l, edit)}
  ${l.items.length && l.dance ? `<div class="floorwrap"><svg class="floor" id="lFloor" role="img" aria-label="The lesson routine round the room"></svg></div><div class="row small">${roomSelect()}</div>` : ""}

  <div class="two">
    <section><div class="sec-title"><span>Videos</span></div>${videoBlock("lesson:" + l.id, edit)}</section>
    <section><div class="sec-title"><span>Comments</span></div>${commentsBlock(id)}</section>
  </div>
  ${edit ? `<p><button class="btn ghost sm danger" data-act="del">Delete this lesson</button></p>` : ""}`;
  if ($("#lFloor")) drawFloor($("#lFloor"), planRoutine(routineSegs(l), roomFor(), d?.style === "Latin"), null);

  el.onclick = async (ev) => {
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
  el.onchange = (ev) => {
    const t = ev.target;
    if (t.id === "lDate") save(l, { date: t.value || l.date });
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
    ${S.levels.map((L) => `<div class="pgroup"><h4><span class="medal m-${L}"></span>${L}</h4><div class="pf">${d.levels[L].map((n) => {
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
        <span class="small muted">${f ? `<span class="medal m-${f.level}"></span> ${f.level}` : ""}${c && d ? ((b) => ` · ${b} bar${b === 1 ? "" : "s"}`)(+(chartBeats(c) / d.bpb).toFixed(1)) : ""}</span></div>
      ${edit ? `<label class="notes"><span class="sr">Notes</span><input class="input" data-k="notes" data-i="${i}" value="${esc(it.notes || "")}" placeholder="Alignment, timing…"></label>` : `<span class="notes small">${esc(it.notes || "")}</span>`}
      ${acts}</div>`;
  }).join("");
  const adder = edit ? (d ? `<div class="adder"><select class="input" id="lAddFig" aria-label="Figure to add">${S.levels.map((L) => `<optgroup label="${L}">${d.levels[L].map((nm) => `<option value="${d.id}.${slug(nm)}">${esc(nm)}</option>`).join("")}</optgroup>`).join("")}</select>
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

export const isBusy = () => false;
