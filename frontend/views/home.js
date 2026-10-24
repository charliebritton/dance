// Home: what Rise & Fall is (for visitors), or your groups' latest lessons, next competitions and routines (members).
import { BASE, S, danceOf, esc, fmtDay, groupName, isCommittee, levelLabel, myGroupLessons, setAccent, today } from "../core.js";

const tiles = () => {
  const row = (style) => `<div class="strip-row"><div class="eyebrow">${style}</div>${S.dances.filter((d) => d.style === style).map((d) =>
    `<a class="dtile c-${d.color}" href="${BASE}/syllabus/${d.id}" data-link><span class="nm">${esc(d.name)}</span><span class="mt">${d.sig} · ${d.tempo[0]}–${d.tempo[1]} bars/min</span></a>`).join("")}</div>`;
  return `<div class="strip">${row("Standard")}${row("Latin")}</div>`;
};

export function render(el) {
  setAccent("waltz");
  el.innerHTML = S.me ? member() : visitor();
}

function visitor() {
  const charted = new Set([...Object.keys(S.starter), ...Object.keys(S.charts)]).size;
  return `
  <section class="intro">
    <div class="introcopy">
      <p>Every ISTD Standard and Latin figure from Bronze to Gold, plus the BDC restricted syllabus, with step charts laid out like the technique books and animated footprints you can play to the beat.</p>
      <div class="row"><a class="btn solid big" href="${BASE}/syllabus" data-link>Browse the syllabus</a><a class="btn big" href="${BASE}/login" data-link>Member sign in</a></div>
    </div>
    <ul class="features">
      <li><b>${S.figs.size} figures, ${charted} charted</b><span>Foot positions, alignment, turn, rise and fall, footwork, with tooltips for every abbreviation.</span></li>
      <li><b>Your own routines</b><span>Pick a partner, plan the figures round a real-sized floor, and practise your own part to the count.</span></li>
      <li><b>Lessons, recorded</b><span>What your group covered each week, the routine you danced, the videos and the comments.</span></li>
      <li><b>The competition calendar</b><span>University circuit dates, entry deadlines and whether we're travelling together.</span></li>
    </ul>
  </section>
  <div class="sec-title"><span>Find a figure</span></div>
  ${tiles()}
  <p class="small muted joinhint">Dance with the society? Ask a committee member for the join link to make an account.</p>`;
}

function member() {
  const lessons = myGroupLessons().slice(0, 4);
  const comps = S.competitions.filter((c) => c.start_date && (c.end_date || c.start_date) >= today()).slice(0, 3);
  const mine = S.routines.filter((r) => !r.example).slice(0, 4);
  return `
  <div class="pagehead"><div><div class="eyebrow">${esc(S.me.groups.map(groupName).join(" · ") || "Welcome")}</div><h1 class="display">Hi ${esc(S.me.name.split(" ")[0])}</h1></div></div>
  <div class="homegrid">
    <section class="panel pad">
      <div class="sec-title flush"><span>Latest lessons</span><a class="small" href="${BASE}/lessons" data-link>All lessons</a></div>
      ${lessons.map((l) => { const d = danceOf(l.dance); return `<a class="hrow" href="${BASE}/lessons/${l.id}" data-link><span class="mono small">${esc(fmtDay(l.date, { weekday: undefined }))}</span><span class="grow">${esc(l.title || (d ? d.name : "Lesson"))}<br><span class="small muted">${esc(groupName(l.group_id))} · ${l.figures.length} figures</span></span>${d ? `<span class="dot c-${d.color}"></span>` : ""}</a>`; }).join("")
        || `<p class="small muted">${isCommittee() ? `No lessons yet. <a href="${BASE}/lessons" data-link>Record one</a> after class.` : "Nothing recorded for your groups yet."}</p>`}
    </section>
    <section class="panel pad">
      <div class="sec-title flush"><span>Coming up</span><a class="small" href="${BASE}/competitions" data-link>All competitions</a></div>
      ${comps.map((c) => `<a class="hrow" href="${BASE}/competitions" data-link><span class="mono small">${esc(fmtDay(c.start_date, { weekday: undefined }))}</span><span class="grow">${esc(c.name)}<br><span class="small muted">${c.travel === "society" ? "Travelling together" : c.travel === "own" ? "Make your own way" : "Travel TBC"}${c.confirmed ? "" : " · unconfirmed"}</span></span></a>`).join("")
        || `<p class="small muted">No upcoming competitions listed.</p>`}
    </section>
    <section class="panel pad">
      <div class="sec-title flush"><span>Your routines</span><a class="small" href="${BASE}/routines" data-link>All routines</a></div>
      ${mine.map((r) => { const d = danceOf(r.dance); return `<a class="hrow" href="${BASE}/routines/${r.id}" data-link><span class="dot c-${d.color}"></span><span class="grow">${esc(r.name)}<br><span class="small muted">${esc(d.name)} · ${esc(levelLabel(r))}</span></span><span class="small">Practise ▶</span></a>`; }).join("")
        || `<p class="small muted">None yet. <a href="${BASE}/routines" data-link>Make your first routine</a> and pick your partner.</p>`}
    </section>
  </div>
  <div class="sec-title"><span>Find a figure</span></div>
  ${tiles()}`;
}

export const isBusy = () => false;
