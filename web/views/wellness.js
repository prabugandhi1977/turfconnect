// Wellness classes: browse upcoming sessions (in person or online), open one, and book a seat. Checkout, payment, tickets
// and cancellation reuse the normal booking flow.
import {
  $, $$, api, busy, dayLabel, empty, errorView, fmtDate, fmtLongDate, fmtRange, go, html, icon, mapsUrl, money, mount, on, plural, session, skeleton, state, titleCase, toast, todayIn, addDays, uid,
} from '../lib.js';

export const KIND_ICON = { yoga: '🧘', meditation: '🪷', zumba: '💃', fitness: '🏋️', aqua: '🏊', pilates: '🤸', breathwork: '🌬️' };
const MODE_LABEL = { in_person: 'In person', online: 'Online · Live' };
const KINDS = Object.keys(KIND_ICON);

const seatNote = s => s.seatsLeft === 0 ? html`<span class="tag bad">Full</span>` : s.seatsLeft <= 3 ? html`<span class="tag warn">Only ${plural(s.seatsLeft, 'seat')} left</span>` : html`<span class="faint">${s.seatsLeft} seats left</span>`;
const where = s => s.mode === 'online' ? 'Join from anywhere' : s.venue.name;

function sessionCard(s, today) {
  return html`<a class="card session-card" href="#/session/${s.id}">
    <div class="session-top ${s.mode}"><span class="session-emoji" aria-hidden="true">${KIND_ICON[s.kind] || '✨'}</span>
      <span class="pill">${MODE_LABEL[s.mode]}</span></div>
    <div class="body">
      <h3>${s.title}</h3>
      <div class="meta"><span>${icon('calendar')}${dayLabel(s.date, today)}</span><span>${icon('clock')}${fmtRange(s.startTime, s.endTime)}</span></div>
      <div class="meta"><span>${icon(s.mode === 'online' ? 'ext' : 'pin')}${where(s)}</span>${s.trainer ? html`<span>${icon('user')}${s.trainer}</span>` : ''}</div>
      <div class="row between" style="margin-top:10px"><span class="price-tag">${s.price ? money(s.price) : 'Free'}</span>${seatNote(s)}</div>
    </div></a>`;
}

export async function wellnessView(main) {
  const today = todayIn();
  const f = { mode: '', kind: '', date: '', ...session.get('tc.wellness', {}) };
  if (f.date && f.date < today) f.date = '';
  mount(main, html`
    <section class="hero"><p class="eyebrow">Wellness</p><h1>Move, stretch, <em>recharge.</em></h1><p class="muted">Yoga, meditation, fitness and aqua classes, at a venue near you or live online.</p></section>
    <div class="hero-search">
      <div class="seg wide" role="group" aria-label="Format">
        ${[['', 'All'], ['in_person', 'In person'], ['online', 'Online live']].map(([v, l]) => html`<button type="button" data-mode="${v}" aria-pressed="${f.mode === v}">${l}</button>`)}
      </div>
      <div class="chips" role="group" aria-label="Type">
        <button class="chip" data-kind="" aria-pressed="${!f.kind}">All types</button>
        ${KINDS.map(k => html`<button class="chip" data-kind="${k}" aria-pressed="${f.kind === k}">${KIND_ICON[k]} ${titleCase(k)}</button>`)}
      </div>
      <div class="date-strip" role="group" aria-label="Date">
        <button class="date-pill" data-date="" aria-pressed="${!f.date}"><span>Any</span><b>∞</b><span>date</span></button>
        ${Array.from({ length: 10 }, (_, i) => addDays(today, i)).map(d => html`
          <button class="date-pill" data-date="${d}" aria-pressed="${d === f.date}"><span>${d === today ? 'Today' : fmtDate(d).split(',')[0]}</span><b>${Number(d.slice(8))}</b><span>${fmtDate(d).split(' ')[2] || ''}</span></button>`)}
      </div>
    </div>
    <h2 id="count" style="font-size:1rem;margin:12px 0" aria-live="polite"></h2>
    <div id="results"></div>`);

  let seq = 0;
  async function load() {
    session.set('tc.wellness', f);
    const box = $('#results', main); mount(box, html`<div class="venue-grid">${skeleton('card', 3)}</div>`); $('#count', main).textContent = 'Finding classes…';
    const qs = new URLSearchParams(); for (const k of ['mode', 'kind', 'date']) if (f[k]) qs.set(k, f[k]);
    const mine = ++seq;
    try {
      const list = await api('/wellness/sessions?' + qs);
      if (mine !== seq) return;
      $('#count', main).textContent = plural(list.length, 'class', 'classes') + (f.date ? ` on ${dayLabel(f.date, today)}` : ' coming up');
      mount(box, list.length ? html`<div class="venue-grid">${list.map(s => sessionCard(s, today))}</div>`
        : empty('calendar', 'No classes match', 'Try another day or type, or switch between in-person and online.', html`<button class="btn" id="clear">Clear filters</button>`));
      $('#clear', main)?.addEventListener('click', () => { Object.assign(f, { mode: '', kind: '', date: '' }); wellnessView(main); });
    } catch (e) { if (mine === seq) { mount(box, errorView(e)); $('[data-retry]', box).onclick = load; $('#count', main).textContent = ''; } }
  }
  const press = (sel, key) => on(main, 'click', sel, (_e, b) => { f[key] = b.dataset[key]; $$(sel, main).forEach(x => x.setAttribute('aria-pressed', x === b)); load(); });
  press('[data-mode]', 'mode'); press('[data-kind]', 'kind'); press('[data-date]', 'date');
  load();
}

export async function sessionDetailView(main, { id }) {
  mount(main, html`<div class="skeleton sk-block"></div>${skeleton('line', 4)}`);
  const s = await api(`/wellness/sessions/${encodeURIComponent(id)}`);
  document.title = `${s.title} · TurfConnect`;
  const today = todayIn(), full = s.seatsLeft === 0, started = s.startAt <= Date.now();
  mount(main, html`
    <a href="#/wellness" class="btn ghost small no-print" style="margin-left:-8px">${icon('back')}All classes</a>
    <div class="session-hero ${s.mode}"><span class="session-emoji big" aria-hidden="true">${KIND_ICON[s.kind] || '✨'}</span>
      <div><span class="pill">${MODE_LABEL[s.mode]}</span><h1>${s.title}</h1>${s.trainer ? html`<p>with ${s.trainer}</p>` : ''}</div></div>
    <div class="layout-venue" style="margin-top:16px">
      <div class="v-top">
        <div class="facts"><span class="tag good">${titleCase(s.kind)}</span><span class="tag">${icon('calendar')}${fmtLongDate(s.date)}</span><span class="tag">${icon('clock')}${fmtRange(s.startTime, s.endTime)}</span>
          <span class="tag">${icon(s.mode === 'online' ? 'ext' : 'pin')}${s.mode === 'online' ? 'Online, join link after booking' : s.venue.name}</span></div>
        <section class="section"><h2>About this class</h2><p class="muted">${s.description || 'No description yet.'}</p></section>
        ${s.mode === 'in_person' ? html`<section class="section"><h2>Where</h2><p class="muted">${s.venue.name}, ${s.venue.address}, ${s.venue.city}</p>
          <a class="btn small" href="${mapsUrl(s.venue)}" target="_blank" rel="noopener">${icon('map')}Directions</a>
          <a class="btn small" href="#/venue/${s.venue.slug}">${icon('ext')}Venue page</a></section>`
          : html`<section class="section"><h2>How it works</h2><p class="muted">After you pay, the join link appears on your booking. It opens 15 minutes before the class starts. Good internet, a quiet corner and a mat or towel are all you need.</p></section>`}
      </div>
      <aside class="booking-panel card">
        <div class="price-big">${s.price ? money(s.price) : 'Free'}<small> per seat</small></div>
        <p>${seatNote(s)}</p>
        <button class="btn primary block" id="book" ${full || started ? 'disabled' : ''}>${full ? 'Class is full' : started ? 'Already started' : state.token ? 'Book a seat' : 'Sign in to book'}</button>
        <p class="faint" style="margin-top:10px">${full ? '' : 'Your seat is held while you pay. Free cancellation per the venue policy.'}</p>
      </aside>
    </div>`);
  $('#book', main)?.addEventListener('click', e => {
    if (!state.token) { toast('Sign in to book your seat'); return go(`#/login?next=${encodeURIComponent('#/session/' + s.id)}`); }
    return busy(e.currentTarget, async () => {
      const booking = await api(`/wellness/sessions/${s.id}/book`, { method: 'POST', idempotencyKey: uid(), body: {} });
      go(`#/checkout/${booking.id}`);
    });
  });
}
