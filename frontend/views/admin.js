// Admin: join links (shared, or personal for someone added ahead of time), members and roles, adding people, groups, the Claude draft-request queue, Claude spend, video storage.
import { $, BASE, S, api, attempt, confirmTap, esc, fmtDate, hooks, refresh, toast } from "../core.js";

const ROLE_LABEL = { member: "Member", committee: "Committee", admin: "Site admin" };
const mb = (b) => (b / 1024 / 1024 >= 1024 ? (b / 1024 ** 3).toFixed(1) + " GB" : Math.round(b / 1024 / 1024) + " MB");
const joinUrl = (t) => `${location.origin}${BASE}/join/${t}`;
const DANCES = { both: "Both", lead: "Lead", follow: "Follow" };

async function copyLink(token, msg) {
  try { await navigator.clipboard.writeText(joinUrl(token)); toast(`${msg} and copied`); } catch { toast(msg); }
}

export async function render(el) {
  el.innerHTML = `<p class="muted">Loading…</p>`;
  const o = await attempt(() => api("GET", "/api/admin/overview"));
  if (!o) return;
  const open = o.requests.filter((r) => r.status === "open");
  const waiting = o.users.filter((u) => !u.joined);
  const personal = Object.fromEntries(o.invites.filter((i) => i.user_id).map((i) => [i.user_id, i]));
  const spend = o.usage.reduce((a, u) => a + (u.cost_usd || 0), 0);
  el.innerHTML = `
  <h1 class="display">Admin</h1>
  <div class="admingrid">
  <section class="panel pad stack">
    <div class="sec-title flush"><span>Join links</span></div>
    <p class="small muted">Share a link in the society group chat. Anyone with it can make an account until you revoke it. For one person, add them under Members and send them their personal link instead.</p>
    <form id="newInvite" class="row">
      <input class="input grow" name="label" placeholder="Label, e.g. Freshers 2026" maxlength="80">
      <select class="input auto" name="role"><option value="member">Members</option><option value="committee">Committee</option></select>
      <input class="input w90" name="max_uses" type="number" min="1" placeholder="Uses">
      <input class="input w90" name="days" type="number" min="1" max="365" placeholder="Days">
      <button class="btn solid" type="submit">Make link</button>
    </form>
    <ul class="invites">${o.invites.map((i) => `<li>
      <span class="grow"><b>${esc(i.label || "Join link")}</b> <span class="chip">${i.user_id ? "Personal" : ROLE_LABEL[i.role]}</span><br>
      <span class="small muted">${i.user_id ? `Only for ${esc(o.users.find((u) => u.id === i.user_id)?.name || "them")}: sets up the place saved for them` : `${i.uses} used${i.max_uses ? ` of ${i.max_uses}` : ""}`}${i.expires_at ? ` · expires ${fmtDate(i.expires_at)}` : " · no expiry"}</span>
      <input class="input mono small copyable" readonly value="${esc(joinUrl(i.token))}" aria-label="Join link"></span>
      <span class="row"><button class="btn sm" data-copy="${esc(joinUrl(i.token))}">Copy</button><button class="btn sm ghost danger" data-revoke="${esc(i.token)}">Revoke</button></span></li>`).join("") || `<li class="muted small">No active links.</li>`}</ul>
  </section>

  <section class="panel pad stack">
    <div class="sec-title flush"><span>Draft requests</span><span class="chip">${open.length} open</span></div>
    ${o.requests.length ? `<ul class="reqs">${o.requests.slice(0, 30).map((r) => `<li class="${r.status}">
      <span class="grow"><b>${r.kind === "chart" ? `Chart: ${esc(S.figs.get(r.target)?.name || r.target)}` : "Routine draft"}</b>
      <span class="small muted">· ${esc(r.by_name || "Someone")} · ${fmtDate(r.created_at)}</span>
      ${r.note ? `<br><span class="small">${esc(r.note)}</span>` : ""}
      ${r.kind === "chart" ? `<br><a class="small" href="${BASE}/syllabus/${esc(r.target.replace(".", "/"))}" data-link>Open the figure</a>` : `<br><a class="small" href="${BASE}/routines/${esc(r.target)}" data-link>Open the routine</a>`}</span>
      ${r.status === "open" ? `<span class="row"><button class="btn sm solid" data-run="${r.id}">Run with Claude</button><button class="btn sm ghost" data-dismiss="${r.id}">Dismiss</button></span>` : `<span class="chip">${esc(r.status)}</span>`}</li>`).join("")}</ul>` : `<p class="small muted">No requests yet. Members see “Request a draft” on figures without charts and on their routines.</p>`}
  </section>

  <section class="panel pad stack wide">
    <div class="sec-title flush"><span>Members</span><span class="chip">${o.users.length - waiting.length} joined${waiting.length ? ` · ${waiting.length} waiting` : ""}</span></div>
    <p class="small muted">Add someone before they join so you can pair them in routines and put them in groups now. Their personal link lets only them set up that account with a passkey or password, keeping everything already linked to them.</p>
    <form id="newPerson" class="row">
      <input class="input grow" name="name" placeholder="Name, as people know them" maxlength="40" required>
      <select class="input auto" name="dance_role" aria-label="Dances">${Object.entries(DANCES).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <select class="input auto" name="role" aria-label="Role"><option value="member">Member</option><option value="committee">Committee</option></select>
      ${o.groups.length ? `<select class="input auto" name="group" aria-label="Group"><option value="">No group</option>${o.groups.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join("")}</select>` : ""}
      <button class="btn solid" type="submit">Add person and make their link</button>
    </form>
    <div class="tablewrap"><table class="plain"><thead><tr><th>Name</th><th>Dances</th><th>Groups</th><th>Sign-in</th><th>Added</th><th>Role</th><th></th></tr></thead><tbody>
    ${o.users.map((u) => `<tr><td>${u.joined ? esc(u.name) : `<input class="input sm" data-pname="${u.id}" value="${esc(u.name)}" maxlength="40" aria-label="Name">`}</td>
      <td>${u.joined ? esc(u.dance_role) : `<select class="input auto sm" data-pdance="${u.id}" aria-label="Dances">${Object.entries(DANCES).map(([k, l]) => `<option value="${k}" ${k === u.dance_role ? "selected" : ""}>${l}</option>`).join("")}</select>`}</td>
      <td class="small">${u.groups.map((g) => esc(o.groups.find((x) => x.id === g)?.name || "")).join(", ") || "—"}</td>
      <td class="small">${u.joined ? `${u.passkeys ? `${u.passkeys} passkey${u.passkeys > 1 ? "s" : ""}` : ""}${u.passkeys && u.has_password ? " + " : ""}${u.has_password ? "password" : ""}`
        : `<span class="warn">Not joined yet</span><br>${personal[u.id] ? `<button class="btn sm" data-copy="${esc(joinUrl(personal[u.id].token))}">Copy their link</button> <button class="linkish small" data-plink="${u.id}">New link</button>` : `<button class="btn sm" data-plink="${u.id}">Make their link</button>`}`}</td>
      <td class="small">${fmtDate(u.created_at)}</td>
      <td><select class="input auto sm" data-role="${u.id}" ${u.id === S.me.id ? "disabled" : ""}>${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${k === u.role ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td>${u.id === S.me.id ? "" : `<button class="btn sm ghost danger" data-remove="${u.id}">Remove</button>`}</td></tr>`).join("")}
    </tbody></table></div>
  </section>

  <section class="panel pad stack">
    <div class="sec-title flush"><span>Groups</span></div>
    <ul class="groupsedit">${o.groups.map((g) => `<li><input class="input" data-group="${g.id}" data-sort="${g.sort}" value="${esc(g.name)}" aria-label="Group name"><button class="btn sm ghost danger" data-delgroup="${g.id}">Delete</button></li>`).join("")}</ul>
    <form id="newGroup" class="row"><input class="input grow" name="name" placeholder="New group, e.g. Latin Team" maxlength="40" required><button class="btn" type="submit">Add group</button></form>
  </section>

  <section class="panel pad stack">
    <div class="sec-title flush"><span>Claude</span><span class="chip">$${spend.toFixed(2)} so far</span></div>
    <p class="small muted">Open to ${o.ai.access === "all" ? `all members, ${o.ai.daily_limit} calls each per day` : "you only"}. Estimated at Opus 5.5 list prices, in US dollars.</p>
    ${o.usage.length ? `<table class="plain small"><thead><tr><th>Month</th><th>Who</th><th>Calls</th><th>Tokens in / out</th><th>Cost</th></tr></thead><tbody>
      ${o.usage.map((u) => `<tr><td>${esc(u.month)}</td><td>${esc(u.name || "—")}</td><td>${u.calls}</td><td class="mono">${u.input_tokens.toLocaleString()} / ${u.output_tokens.toLocaleString()}</td><td class="mono">$${(u.cost_usd || 0).toFixed(2)}</td></tr>`).join("")}</tbody></table>` : `<p class="small muted">No Claude calls yet.</p>`}
    <div class="sec-title flush"><span>Video storage</span></div>
    <p class="small">${mb(o.storage.videos)} of uploaded videos · <b>${mb(o.storage.free)} free</b> on the server${o.storage.free < 3 * 1024 ** 3 ? ` <span class="warn">· running low: add the 80 GB storage option in OVH</span>` : ""}</p>
  </section>
  </div>`;

  el.onclick = async (ev) => {
    const t = ev.target.closest("button"); if (!t) return;
    if (t.dataset.copy) {
      try { await navigator.clipboard.writeText(t.dataset.copy); toast("Link copied"); }
      catch { const box = t.closest("li")?.querySelector(".copyable"); if (box) { box.select(); toast("Press Ctrl+C to copy"); } else prompt("Copy this link", t.dataset.copy); }
    } else if (t.dataset.plink) {
      const r = await attempt(() => api("POST", "/api/admin/invites", { user_id: +t.dataset.plink }));
      if (r) { await copyLink(r.token, "Personal link made"); render(el); }
    } else if (t.dataset.revoke) {
      if (!confirmTap(t, "Revoke?")) return;
      if (await attempt(() => api("DELETE", `/api/admin/invites/${encodeURIComponent(t.dataset.revoke)}`), "Link revoked")) render(el);
    } else if (t.dataset.run) {
      t.disabled = true; t.textContent = "Claude is working…";
      if (await attempt(() => api("POST", `/api/admin/requests/${t.dataset.run}/run`), "Done. The draft is saved where they asked")) { await refresh(); render(el); }
      else { t.disabled = false; t.textContent = "Run with Claude"; }
    } else if (t.dataset.dismiss) {
      if (await attempt(() => api("POST", `/api/admin/requests/${t.dataset.dismiss}/dismiss`))) render(el);
    } else if (t.dataset.remove) {
      if (!confirmTap(t, "Remove member?")) return;
      if (await attempt(() => api("DELETE", `/api/admin/users/${t.dataset.remove}`), "Member removed")) { await refresh(); render(el); }
    } else if (t.dataset.delgroup) {
      if (!confirmTap(t, "Delete group?")) return;
      if (await attempt(() => api("DELETE", `/api/admin/groups/${t.dataset.delgroup}`), "Group deleted")) { await refresh(); render(el); }
    }
  };
  el.onchange = async (ev) => {
    const t = ev.target;
    if (t.dataset.role) { if (await attempt(() => api("PATCH", `/api/admin/users/${t.dataset.role}`, { role: t.value }), "Role changed")) await refresh(); }
    else if (t.dataset.pname) { if (await attempt(() => api("PATCH", `/api/admin/users/${t.dataset.pname}`, { name: t.value }), "Name saved")) { await refresh(); render(el); } }
    else if (t.dataset.pdance) { if (await attempt(() => api("PATCH", `/api/admin/users/${t.dataset.pdance}`, { dance_role: t.value }), "Saved")) await refresh(); }
    else if (t.dataset.group) { if (await attempt(() => api("PATCH", `/api/admin/groups/${t.dataset.group}`, { name: t.value, sort: +t.dataset.sort }), "Group renamed")) await refresh(); }
  };
  el.onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    if (f.id === "newInvite") {
      const body = { label: f.label.value, role: f.role.value, max_uses: f.max_uses.value ? +f.max_uses.value : null, days: f.days.value ? +f.days.value : null };
      const r = await attempt(() => api("POST", "/api/admin/invites", body));
      if (r) { await copyLink(r.token, "Link made"); render(el); }
    } else if (f.id === "newPerson") {
      const body = { name: f.name.value, dance_role: f.dance_role.value, role: f.role.value, groups: f.group?.value ? [+f.group.value] : [] };
      const p = await attempt(() => api("POST", "/api/admin/people", body));
      if (!p) return;
      const r = await attempt(() => api("POST", "/api/admin/invites", { user_id: p.id }));
      if (r) await copyLink(r.token, `${body.name.trim()} added. Their personal link is made`);
      await refresh(); render(el);
    } else if (f.id === "newGroup") {
      if (await attempt(() => api("POST", "/api/admin/groups", { name: f.name.value, sort: S.groups.length }), "Group added")) { await refresh(); render(el); }
    }
  };
}
