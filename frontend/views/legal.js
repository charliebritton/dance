// Terms of use and privacy notice: short, plain English, and true to what the code actually stores and sends.
import { BASE } from "../core.js";

const UPDATED = "25 October 2026";

const TERMS = `
<h1 class="display">Terms of use</h1>
<p class="muted">Last updated ${UPDATED}</p>
<h2>What this is</h2>
<p>Rise &amp; Fall is a free, independent study aid for ballroom and Latin dancers, run by Charlie Britton. It is not
affiliated with or endorsed by SUBLDS, the ISTD, the BDC or any society, school or competition.</p>
<h2>Step charts and drafts</h2>
<p>The starter charts were written from memory and are marked “Not checked yet” until the committee or admin checks
them against the technique books. Animations, floor plans and anything drafted with Claude can be wrong. Treat the site
as a study aid alongside your lessons, not a replacement for them, and dance within your ability. We aren't responsible for injury or for results at competitions.</p>
<h2>Accounts</h2>
<p>Membership is by invitation. Keep your passkey or password to yourself, and tell the admin if you think someone
else has used your account. The admin can change roles, remove content or close accounts, for example for misuse.</p>
<h2>What you add</h2>
<p>You're responsible for the routines, comments, notes, videos and recordings you add. Only upload things you have the
right to share. Don't record or upload other people without their agreement: lesson recordings capture your teacher
and classmates, so ask them first. Don't post anything unlawful, abusive or anyone's private information. By adding
content you let the site store it and show it to the people it is shared with, as the privacy notice describes.</p>
<h2>Availability</h2>
<p>The site is provided as is, with no guarantees that it will be available, error-free or keep your data forever:
keep your own copies of anything important. Features may change or be removed.</p>
<h2>Changes and law</h2>
<p>These terms may be updated; the date above shows when. They are governed by the law of England and Wales.</p>
<p>See also the <a href="${BASE}/privacy" data-link>privacy notice</a>.</p>`;

const PRIVACY = `
<h1 class="display">Privacy notice</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p>Charlie Britton runs Rise &amp; Fall and is responsible for the personal data it holds (the “controller” under UK
GDPR). Contact Charlie, the site admin, with any question or request.</p>
<h2>Visitors</h2>
<p>You can read the syllabus and step charts without an account. We set no cookies for visitors and use no analytics,
advertising or tracking. Your browser keeps a few display settings (for example which dance and speed you last picked)
in its own local storage; they never leave your device.</p>
<h2>What we keep about members</h2>
<ul>
<li><b>Account</b>: your name, lead/follow preference, role, groups, and either a passkey (only its public key; your
fingerprint or face never leaves your device) or a scrambled (hashed) password.</li>
<li><b>Sign-in cookie</b>: one cookie that keeps you signed in. It is needed for the site to work, so it doesn't need
consent.</li>
<li><b>What you add</b>: routines and their versions, partner sign-offs, comments, private notes, demo videos, lesson
recordings, their transcripts and notes, and competition plans.</li>
<li><b>Lesson recordings</b>: transcribed on our own server (nothing is sent elsewhere). The audio is deleted once it's
transcribed unless you choose to keep it. Only you and the committee or admin can see a recording and its transcript.</li>
<li><b>Claude</b>: when the admin uses Claude (Anthropic's AI) to draft a routine, chart or lesson notes, the text
needed for that draft (for example a routine brief or a transcript) is sent to Anthropic to process. We log how many
tokens each draft used, so we can see the cost.</li>
<li><b>Server logs</b>: the web server records requests (including IP addresses) to keep the site secure; the logs
rotate automatically and are deleted after a few months.</li>
</ul>
<h2>Who sees it</h2>
<p>Names are visible to other members. Routines are visible to their owner and dancers; private notes only to you.
Lesson content is visible to members, and the committee or admin manages it. We don't sell or share data with anyone else, apart from
Anthropic as described above and the hosting provider that runs the server.</p>
<h2>Why we can use it</h2>
<p>To run the service you joined (contract and legitimate interests), and with your choice when you upload a
recording or video. You can withdraw that by deleting it.</p>
<h2>How long</h2>
<p>For as long as you have an account. When an account is removed, its recordings go with it, and the admin removes
anything else of yours on request. The last few database backups are kept for recovery and replaced as new ones are
made.</p>
<h2>Your rights</h2>
<p>You can ask for a copy of your data, or for it to be corrected or deleted, by contacting the admin. If you're
unhappy with how your data is handled, you can complain to the Information Commissioner's Office (ico.org.uk).</p>
<p>See also the <a href="${BASE}/terms" data-link>terms of use</a>.</p>`;

export function render(el, params) {
  el.innerHTML = `<article class="panel pad legal">${params.doc === "privacy" ? PRIVACY : TERMS}</article>`;
}
