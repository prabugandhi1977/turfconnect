// Coaches: browse, open a profile (rating, likes, comments), pick a free slot and book a one-to-one session.
import {
  $, $$, api, busy, dayLabel, empty, errorView, fmtDate, fmtLongDate, fmtTime, go, html, icon, money, mount, on, plural, raw, session, skeleton, state, titleCase, toast, todayIn, addDays, uid, stars,
} from '../lib.js';

const SPORT_EMOJI = { football: '⚽', cricket: '🏏', badminton: '🏸', tennis: '🎾', pickleball: '🏓', basketball: '🏀', volleyball: '🏐', futsal: '⚽', swimming: '🏊', yoga: '🧘', meditation: '🪷', zumba: '💃', fitness: '🏋️', aqua: '🏊', pilates: '🤸', breathwork: '🌬️' };
const HUES = [152, 205, 262, 330, 28, 175, 48, 295];
const hue = s => HUES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % HUES.length];
const initials = n => n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
export const avatar = (c, big = false) => html`<span class="avatar ${big ? 'big' : ''}" style="--h:${hue(c.name)}" aria-hidden="true">${initials(c.name)}<i>${SPORT_EMOJI[c.specialty] || ''}</i></span>`;
const needLogin = next => { toast('Sign in to continue'); go(`#/login?next=${encodeURIComponent(next)}`); };

async function toggleLike(c, btn) {
  if (!state.token) return needLogin(`#/coach/${c.id}`);
  try {
    const r = await api(`/coaches/${c.id}/like`, { method: 'POST' });
    c.liked = r.liked; c.likes = r.likes;
    btn.setAttribute('aria-pressed', r.liked);
    $('.n', btn).textContent = r.likes;
    toast(r.liked ? 'Added to your liked coaches' : 'Removed like');
  } catch (e) { toast(e.message, 'bad'); }
}
const likeBtn = c => html`<button class="like-btn" data-like="${c.id}" aria-pressed="${c.liked}" aria-label="Like ${c.name}">${icon('heart')}<span class="n">${c.likes}</span></button>`;

function coachCard(c, today) {
  return html`<div class="venue-wrap"><a class="card coach-card" href="#/coach/${c.id}">
    <div class="row nowrap">${avatar(c)}<div class="grow"><h3 style="margin:0">${c.name}</h3><div class="muted" style="font-size:14px">${titleCase(c.specialty)} · ${c.experienceYears} yrs</div>
      <div class="faint">${c.venue.name}, ${c.venue.city}</div></div></div>
    <div class="row between" style="margin-top:12px">${c.rating ? html`<span class="rating">${stars(c.rating)}<span class="faint">(${c.reviews})</span></span>` : html`<span class="tag">New</span>`}<b>${money(c.price)}<span class="faint"> / ${c.sessionMinutes} min</span></b></div>
    <div class="row" style="margin-top:10px">${c.nextSlot ? html`<span class="tag good">${icon('clock')}Next: ${dayLabel(c.nextSlot.date, today)} ${fmtTime(c.nextSlot.start)}</span>` : html`<span class="tag warn">No free slots soon</span>`}</div></a>
    ${likeBtn(c)}</div>`;
}

export async function coachesView(main) {
  const today = todayIn(), f = { sport: '', sort: 'rating', q: '', ...session.get('tc.coaches', {}) };
  const meta = state.meta || (state.meta = await api('/meta').catch(() => ({})));
  mount(main, html`<section class="hero"><p class="eyebrow">Coaches</p><h1>Train with <em>someone great.</em></h1><p class="muted">Book one-to-one sessions with certified coaches. Real ratings and comments from players.</p></section>
    <div class="hero-search"><div class="row nowrap"><div class="search-box" style="flex:1">${icon('search')}<input type="search" id="q" placeholder="Search coaches" aria-label="Search coaches" value="${f.q}"></div>
      <select id="sort" aria-label="Sort by" style="width:auto"><option value="rating">Top rated</option><option value="likes">Most liked</option><option value="price">Lowest price</option></select></div>
      <div class="chips" role="group" aria-label="Sport"><button class="chip" data-sport="" aria-pressed="${!f.sport}">All</button>
        ${(meta.coachSpecialties || Object.keys(SPORT_EMOJI)).map(sp => html`<button class="chip" data-sport="${sp}" aria-pressed="${f.sport === sp}">${SPORT_EMOJI[sp] || ''} ${titleCase(sp)}</button>`)}</div></div>
    <h2 id="count" style="font-size:1rem;margin:12px 0" aria-live="polite"></h2><div id="list">${skeleton('card', 3)}</div>`);
  $('#sort', main).value = f.sort;
  let seq = 0, timer, list = [];
  async function load() {
    session.set('tc.coaches', f);
    const mine = ++seq, qs = new URLSearchParams({ sort: f.sort }); if (f.sport) qs.set('sport', f.sport); if (f.q) qs.set('q', f.q);
    try {
      list = await api('/coaches?' + qs);
      if (mine !== seq) return;
      $('#count', main).textContent = plural(list.length, 'coach', 'coaches');
      mount($('#list', main), list.length ? html`<div class="venue-grid">${list.map(c => coachCard(c, today))}</div>` : empty('users', 'No coaches found', 'Try another sport or clear the search.'));
    } catch (e) { mount($('#list', main), errorView(e)); $('[data-retry]', main).onclick = load; }
  }
  on(main, 'click', '[data-sport]', (_e, b) => { f.sport = b.dataset.sport; $$('[data-sport]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); load(); });
  on(main, 'click', '[data-like]', (_e, b) => toggleLike(list.find(c => c.id === b.dataset.like), b));
  $('#sort', main).onchange = e => { f.sort = e.target.value; load(); };
  $('#q', main).oninput = e => { clearTimeout(timer); timer = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 250); };
  load();
}

export async function coachProfileView(main, { id }) {
  mount(main, html`<div class="skeleton sk-block"></div>${skeleton('line', 5)}`);
  const c = await api(`/coaches/${encodeURIComponent(id)}`);
  document.title = `${c.name} · Thidal`;
  const today = todayIn(), pick = { date: c.nextSlot?.date || today, start: '' };
  const total = c.reviews || 0;
  mount(main, html`<a href="#/coaches" class="btn ghost small" style="margin-left:-8px">${icon('back')}All coaches</a>
    <div class="coach-head">${avatar(c, true)}<div class="grow"><h1 style="margin:0">${c.name}</h1>
      <div class="facts"><span class="tag good">${titleCase(c.specialty)}</span><span class="tag">${c.experienceYears} years</span><span class="tag">${c.languages.join(', ')}</span></div>
      <a href="#/venue/${c.venue.slug}" class="muted">${icon('pin')} ${c.venue.name}, ${c.venue.city}</a></div></div>
    <div class="stat-row"><div class="stat"><b>${c.rating ? '★ ' + c.rating : 'New'}</b><span>${plural(total, 'rating')}</span></div><div class="stat">${likeBtn(c)}<span>likes</span></div>
      <div class="stat"><b>${money(c.price)}</b><span>per ${c.sessionMinutes} min</span></div></div>
    <div class="layout-venue" style="margin-top:16px"><div class="v-top">
      <section class="section" style="margin-top:0"><h2>About ${c.name.split(' ')[0]}</h2><p class="muted">${c.bio || 'No bio yet.'}</p></section>
      <section class="section" id="reviews"><h2>Ratings &amp; comments</h2>
        ${total ? html`<div class="row" style="align-items:flex-start;gap:20px;margin-bottom:8px"><div><div style="font-size:2.2rem;font-weight:800;line-height:1">${c.rating}</div><div class="faint">${plural(total, 'review')}</div></div>
          <div class="histogram" style="flex:1;min-width:180px" aria-label="Rating breakdown">${c.histogram.map(h => html`<div><span>${h.stars}★</span><span class="bar"><i style="width:${Math.round(h.count / total * 100)}%"></i></span><span class="faint">${h.count}</span></div>`)}</div></div>
          ${c.reviewList.map((r, i) => html`<div class="review" ${i >= 5 ? raw('data-more hidden') : ''}><div class="row between"><b>${r.name}</b><span>${stars(r.rating)}</span></div>${r.comment ? html`<p style="margin:4px 0 0">${r.comment}</p>` : ''}
            <div class="faint">${fmtDate(r.createdAt.slice(0, 10))}</div>${r.reply ? html`<div class="owner-reply"><b>Reply from the venue</b><br>${r.reply}</div>` : ''}</div>`)}
          ${c.reviewList.length > 5 ? html`<button class="btn small" id="more">Show ${c.reviewList.length - 5} more comments</button>` : ''}` : html`<p class="muted">No ratings yet. Book a session and be the first to review.</p>`}</section></div>
      <aside class="booking-panel card" aria-labelledby="bk-h"><h2 id="bk-h">Book a session</h2>
        <div class="date-strip" role="group" aria-label="Date">${Array.from({ length: 10 }, (_, i) => addDays(today, i)).map(d => html`
          <button class="date-pill" data-date="${d}" aria-pressed="${d === pick.date}"><span>${d === today ? 'Today' : fmtDate(d).split(',')[0]}</span><b>${Number(d.slice(8))}</b><span>${fmtDate(d).split(' ')[2] || ''}</span></button>`)}</div>
        <div id="slots" aria-live="polite" style="margin-top:10px"></div>
        <div class="sticky-cta" id="cta" hidden></div></aside></div>`);
  $('#more', main)?.addEventListener('click', e => { $$('[data-more]', main).forEach(x => { x.hidden = false; }); e.currentTarget.remove(); });
  on(main, 'click', '[data-like]', (_e, b) => toggleLike(c, b));

  async function loadSlots() {
    const box = $('#slots', main); mount(box, html`<div class="slot-grid">${skeleton('line', 6)}</div>`); pick.start = ''; drawCta();
    try {
      const r = await api(`/coaches/${c.id}/slots?date=${pick.date}`);
      mount(box, r.slots.length ? html`<p class="faint" style="margin:0 0 8px">${fmtLongDate(pick.date)} · ${r.sessionMinutes}-minute sessions</p><div class="slot-grid">${r.slots.map(s => html`
          <button class="slot ${s.state === 'available' ? '' : 'booked'}" data-start="${s.start}" ${s.state === 'available' ? '' : 'aria-disabled="true"'} aria-pressed="false">${fmtTime(s.start)}<small>${s.state === 'available' ? money(r.price) : 'Booked'}</small></button>`)}</div>`
        : html`<p class="muted">${c.name.split(' ')[0]} is not available on this day. Try another date.</p>`);
    } catch (e) { mount(box, errorView(e)); $('[data-retry]', box).onclick = loadSlots; }
  }
  function drawCta() {
    const cta = $('#cta', main);
    if (!pick.start) { cta.hidden = true; return; }
    cta.hidden = false;
    mount(cta, html`<div><div style="font-weight:800">${money(c.price)}</div><div class="faint">${dayLabel(pick.date, today)} · ${fmtTime(pick.start)}</div></div><button class="btn primary" id="book">Book session</button>`);
  }
  on(main, 'click', '[data-date]', (_e, b) => { pick.date = b.dataset.date; $$('[data-date]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); loadSlots(); });
  on(main, 'click', '.slot', (_e, b) => { if (b.getAttribute('aria-disabled') === 'true') return; pick.start = b.dataset.start; $$('.slot', main).forEach(x => x.setAttribute('aria-pressed', x === b)); drawCta(); });
  on(main, 'click', '#book', (_e, b) => {
    if (!state.token) return needLogin(`#/coach/${c.id}`);
    return busy(b, async () => {
      try { const booking = await api(`/coaches/${c.id}/book`, { method: 'POST', idempotencyKey: uid(), body: { date: pick.date, start: pick.start } }); go(`#/checkout/${booking.id}`); }
      catch (e) { if (e.status === 409) await loadSlots(); throw e; }
    });
  });
  loadSlots();
}
