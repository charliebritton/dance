// Competitions on the UK university circuit: dates, venue, whether the society travels together, entry links.
import { BASE, S, api, attempt, confirmTap, esc, fmtDay, hooks, isCommittee, refresh, today, userName } from "../core.js";

const v = { editing: null };
const TRAVEL = {
  society: ["Travelling together as a team", "go"],
  own: ["Make your own way there", "own"],
  tbc: ["Travel plans to be confirmed", "tbc"],
};

function dates(c) {
  if (!c.start_date) return "Date to be confirmed";
  if (!c.end_date || c.end_date === c.start_date) return fmtDay(c.start_date);
  return `${fmtDay(c.start_date)} – ${fmtDay(c.end_date)}`;
}
function daysUntil(iso) { return Math.round((new Date(iso + "T12:00:00") - new Date(today() + "T12:00:00")) / 86400000); }

function card(c) {
  if (v.editing === c.id) return form(c);
  const [travel, cls] = TRAVEL[c.travel] || TRAVEL.tbc;
  const dl = c.entry_deadline ? daysUntil(c.entry_deadline) : null;
  return `<article class="ccard panel ${c.confirmed ? "" : "unconfirmed"}">
    <div class="cdate">${c.start_date ? `<b>${esc(fmtDay(c.start_date, { weekday: undefined, year: undefined, month: undefined }))}</b><span>${esc(fmtDay(c.start_date, { weekday: undefined, day: undefined }))}</span>` : `<b>?</b><span>TBC</span>`}</div>
    <div class="cbody">
      <h3 class="display">${esc(c.name)}</h3>
      <p class="small muted">${esc(dates(c))}${c.venue ? ` · ${esc(c.venue)}` : ""}${c.host ? ` · hosted by ${esc(c.host)}` : ""}</p>
      <div class="row">
        <span class="travel ${cls}">${travel}</span>
        ${c.team_entry ? `<span class="chip">Team entry</span>` : ""}
        ${!c.confirmed ? `<span class="badge ai" title="${esc(c.source || "Found online; not yet checked by the committee or admin")}">Unconfirmed</span>` : ""}
      </div>
      ${c.notes ? `<p class="prewrap small">${esc(c.notes)}</p>` : ""}
      <div class="row">
        ${c.entry_url ? `<a class="btn sm solid" href="${esc(c.entry_url)}" target="_blank" rel="noopener noreferrer">Entry form ↗</a>` : `<span class="small muted">No entry link yet</span>`}
        ${dl !== null ? `<span class="small ${dl >= 0 && dl <= 7 ? "warn" : "muted"}">${dl < 0 ? "Entries closed" : dl === 0 ? "Entries close today" : `Entries close ${esc(fmtDay(c.entry_deadline))} (${dl} day${dl === 1 ? "" : "s"})`}</span>` : ""}
        ${isCommittee() ? `<span class="grow"></span><button class="btn sm ghost" data-edit="${c.id}">Edit</button>` : ""}
      </div>
      ${c.updated_by ? `<p class="tiny muted">Updated by ${esc(userName(c.updated_by))}</p>` : ""}
    </div></article>`;
}

function form(c = {}) {
  const val = (k) => esc(c[k] ?? "");
  return `<form class="ccard panel pad stack cform" data-id="${c.id || ""}">
    <div class="row"><label class="field grow">Competition<input class="input" name="name" value="${val("name")}" required maxlength="120"></label>
      <label class="field grow">Host<input class="input" name="host" value="${val("host")}" placeholder="e.g. Bath University DanceSport"></label></div>
    <div class="row"><label class="field">Starts<input class="input auto" type="date" name="start_date" value="${val("start_date")}"></label>
      <label class="field">Ends<input class="input auto" type="date" name="end_date" value="${val("end_date")}"></label>
      <label class="field">Entries close<input class="input auto" type="date" name="entry_deadline" value="${val("entry_deadline")}"></label></div>
    <label class="field">Venue<input class="input" name="venue" value="${val("venue")}"></label>
    <fieldset class="choice"><legend>Getting there</legend>${Object.entries(TRAVEL).map(([k, [l]]) => `<label><input type="radio" name="travel" value="${k}" ${(c.travel || "tbc") === k ? "checked" : ""}> ${l}</label>`).join("")}</fieldset>
    <label class="check"><input type="checkbox" name="team_entry" ${c.team_entry ? "checked" : ""}> Entering as a team</label>
    <label class="field">Entry form link<input class="input" type="url" name="entry_url" value="${val("entry_url")}" placeholder="https://…"></label>
    <label class="field">Notes<textarea class="input" name="notes" placeholder="Coach times, kit, who's organising">${val("notes")}</textarea></label>
    ${c.id && !c.confirmed ? `<p class="small muted">Saving marks this competition as checked.${c.source ? ` Found from: ${esc(c.source)}` : ""}</p>` : ""}
    <div class="row"><button class="btn solid" type="submit">Save</button><button class="btn" type="button" data-cancel>Cancel</button>
      ${c.id ? `<span class="grow"></span><button class="btn ghost danger sm" type="button" data-del="${c.id}">Delete</button>` : ""}</div>
  </form>`;
}

export function render(el) {
  const t = today();
  const upcoming = S.competitions.filter((c) => !c.start_date || (c.end_date || c.start_date) >= t);
  const past = S.competitions.filter((c) => c.start_date && (c.end_date || c.start_date) < t).reverse();
  el.innerHTML = `
  <div class="pagehead"><div><div class="eyebrow">UK university circuit</div><h1 class="display">Competitions</h1></div>
    ${isCommittee() && v.editing !== "new" ? `<button class="btn solid" data-new>Add a competition</button>` : ""}</div>
  ${v.editing === "new" ? form() : ""}
  <div class="clist">${upcoming.map(card).join("") || `<div class="panel pad empty">No upcoming competitions listed yet.</div>`}</div>
  ${past.length ? `<details class="past"><summary class="sec-title"><span>Past competitions (${past.length})</span></summary><div class="clist">${past.map(card).join("")}</div></details>` : ""}`;
  el.onclick = async (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.new !== undefined) { v.editing = "new"; render(el); }
    else if (b.dataset.edit) { v.editing = b.dataset.edit; render(el); }
    else if (b.dataset.cancel !== undefined) { v.editing = null; render(el); }
    else if (b.dataset.del) {
      if (!confirmTap(b, "Delete for everyone?")) return;
      if (await attempt(() => api("DELETE", `/api/competitions/${b.dataset.del}`), "Competition deleted")) { v.editing = null; await refresh(); hooks.render(); }
    }
  };
  el.onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target, id = f.dataset.id;
    const body = { name: f.name.value, host: f.host.value, start_date: f.start_date.value || null, end_date: f.end_date.value || null,
      entry_deadline: f.entry_deadline.value || null, venue: f.venue.value, travel: f.travel.value, team_entry: f.team_entry.checked,
      entry_url: f.entry_url.value, notes: f.notes.value, confirmed: true };
    const ok = await attempt(() => (id ? api("PUT", `/api/competitions/${id}`, body) : api("POST", "/api/competitions", body)), "Saved");
    if (ok) { v.editing = null; await refresh(); hooks.render(); }
  };
  el.onchange = el.oninput = null;
}

export const isBusy = () => !!v.editing;
