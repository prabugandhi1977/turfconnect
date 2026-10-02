// Customer journey: discover -> venue & slots -> checkout -> pay -> confirmation, plus bookings, tickets and invoices.
import {
  $, $$, api, busy, confirmDialog, dayLabel, onDay, downloadFile, empty, errorView, fmtDate, fmtDateTime, fmtLongDate, fmtRange, fmtTime, go, html, icon, liveStream, mapsUrl,
  money, mount, on, onLeave, plural, policyText, raw, session, sheet, skeleton, sportLabel, SPORT_ICON, state, stars, store, titleCase, toast, todayIn, addDays, uid,
} from '../lib.js';
import { qrSvg } from '../qr.js';

const DEFAULT_PLACE = { place: 'Bengaluru', lat: 12.9716, lng: 77.5946 };
const AMENITY_LABEL = a => ({ drinking_water: 'Drinking water', first_aid: 'First aid', changing_room: 'Changing room', equipment_rental: 'Equipment rental', cctv: 'CCTV', wifi: 'Wi-Fi' })[a] || titleCase(a);
const photo = (v, cls = 'thumb') => html`<img class="${cls}" src="${v.photos?.[0] || '/img/venue-1.svg'}" alt="" loading="lazy" width="160" height="120">`;
const TIMES = Array.from({ length: 17 }, (_, i) => `${String(i + 6).padStart(2, '0')}:00`);

async function getMeta() { return state.meta || (state.meta = await api('/meta')); }

// ---- Discover ------------------------------------------------------------------------------------------------
export async function discoverView(main) {
  const meta = await getMeta().catch(() => ({ sports: Object.keys(SPORT_ICON), surfaces: [], amenities: [], cities: [] }));
  const today = todayIn();
  const s = { ...DEFAULT_PLACE, sport: '', date: today, time: '', q: '', amenities: [], sort: '', ...session.get('tc.search', {}) };
  if (s.date < today) s.date = today;
  const filterCount = () => ['maxKm', 'maxPrice', 'surface', 'indoor', 'lighting', 'minRating'].filter(k => s[k]).length + s.amenities.length;

  mount(main, html`
    <h1>Book a turf near you</h1>
    <div class="hero-search">
      <div class="row nowrap">
        <div class="search-box" style="flex:1">${icon('search')}<input type="search" id="q" placeholder="Venue or area" aria-label="Search venues or areas" value="${s.q}"></div>
        <button class="btn" id="filters" aria-haspopup="dialog">${icon('filter')}<span>Filters</span><span id="fcount"></span></button>
      </div>
      <div class="row"><button class="chip" id="place">${icon('pin')}<span id="place-l">${s.place}</span></button>
        <label class="sr-only" for="time">Preferred time</label>
        <select id="time" style="width:auto;min-height:36px;border-radius:99px;padding:4px 12px">${[''].concat(TIMES).map(t => html`<option value="${t}" ${t === s.time ? 'selected' : ''}>${t ? `From ${fmtTime(t)}` : 'Any time'}</option>`)}</select>
      </div>
      <div class="chips" role="group" aria-label="Sport">
        <button class="chip" data-sport="" aria-pressed="${!s.sport}">All sports</button>
        ${meta.sports.map(sp => html`<button class="chip" data-sport="${sp}" aria-pressed="${s.sport === sp}">${sportLabel(sp)}</button>`)}
      </div>
      <div class="date-strip" role="group" aria-label="Date">${Array.from({ length: 10 }, (_, i) => addDays(today, i)).map(d => html`
        <button class="date-pill" data-date="${d}" aria-pressed="${d === s.date}"><span>${i0(d, today)}</span><b>${Number(d.slice(8))}</b><span>${fmtDate(d).split(' ')[2] || ''}</span></button>`)}</div>
    </div>
    <div class="row between" style="margin:8px 0"><h2 id="count" style="margin:0;font-size:1rem" aria-live="polite"></h2>
      <select id="sort" aria-label="Sort by" style="width:auto;min-height:36px;padding:4px 10px">
        ${[['', 'Best match'], ['distance', 'Nearest'], ['price', 'Lowest price'], ['rating', 'Top rated']].map(([v, l]) => html`<option value="${v}" ${s.sort === v ? 'selected' : ''}>${l}</option>`)}</select></div>
    <div id="results" class="stack"></div>`);

  let timer, seq = 0;
  const save = () => session.set('tc.search', s);
  async function load() {
    save();
    $('#fcount', main).textContent = filterCount() ? ` · ${filterCount()}` : '';
    const box = $('#results', main); mount(box, skeleton('card', 4)); $('#count', main).textContent = 'Finding turfs…';
    const qs = new URLSearchParams({ lat: s.lat, lng: s.lng, date: s.date });
    for (const k of ['sport', 'time', 'q', 'maxKm', 'surface', 'indoor', 'minRating', 'sort']) if (s[k]) qs.set(k, s[k]);
    if (s.maxPrice) qs.set('maxPrice', s.maxPrice * 100);
    if (s.lighting) qs.set('lighting', 'true');
    if (s.amenities.length) qs.set('amenities', s.amenities.join(','));
    const mine = ++seq;
    try {
      const venues = await api('/venues?' + qs);
      if (mine !== seq) return;
      store.set('tc.lastResults', venues);
      render(venues);
    } catch (e) {
      if (mine !== seq) return;
      const cached = store.get('tc.lastResults');
      if (e.code === 'network' && cached) { render(cached); toast('Offline: showing your last search'); return; }
      mount(box, errorView(e)); $('[data-retry]', box).onclick = load; $('#count', main).textContent = '';
    }
  }
  function render(venues) {
    const open = venues.filter(v => v.availableSlots > 0).length;
    $('#count', main).textContent = `${plural(open, 'turf')} with free slots ${s.time ? `from ${fmtTime(s.time)} ` : ''}${s.date === today ? 'today' : 'on ' + dayLabel(s.date, today)}`;
    const qs = new URLSearchParams({ date: s.date }); if (s.sport) qs.set('sport', s.sport);
    mount($('#results', main), venues.length ? venues.map(v => html`
      <a class="card venue-card" href="#/venue/${v.slug}?${qs}">
        ${photo(v)}
        <div style="min-width:0">
          <h3>${v.name}</h3>
          <div class="meta">${v.rating ? html`<span>${stars(v.rating)}<span class="faint">(${v.reviews})</span></span>` : html`<span class="tag">New</span>`}
            ${v.distanceKm != null ? html`<span>${icon('pin')}${v.distanceKm} km</span>` : ''}<span>${v.address.split(',').pop().trim()}</span></div>
          <div class="meta" style="margin-top:4px"><span>${v.sports.map(sp => SPORT_ICON[sp]).join(' ')}</span><span>${v.indoor ? 'Indoor' : 'Outdoor'}</span>${v.lighting ? html`<span>Floodlit</span>` : ''}</div>
          <div style="margin-top:4px">${v.fromPrice != null ? html`<span class="price">${money(v.fromPrice)}</span><span class="faint"> /slot</span>` : html`<span class="faint">Fully booked this day</span>`}</div>
          ${v.nextSlots?.length ? html`<div class="slots" aria-label="Next free times">${v.nextSlots.map(t => html`<span>${fmtTime(t)}</span>`)}</div>` : ''}
        </div>
      </a>`) : empty('search', 'No turfs match', 'Try another date or time, or clear some filters.', html`<button class="btn" id="clear">Clear filters</button>`));
    $('#clear', main)?.addEventListener('click', () => { Object.assign(s, { time: '', q: '', maxKm: '', maxPrice: '', surface: '', indoor: '', lighting: false, minRating: '', amenities: [] }); discoverView(main); });
  }

  on(main, 'click', '[data-sport]', (_e, b) => { s.sport = b.dataset.sport; $$('[data-sport]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); load(); });
  on(main, 'click', '[data-date]', (_e, b) => { s.date = b.dataset.date; $$('[data-date]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); load(); });
  $('#time', main).onchange = e => { s.time = e.target.value; load(); };
  $('#sort', main).onchange = e => { s.sort = e.target.value; load(); };
  $('#q', main).oninput = e => { clearTimeout(timer); timer = setTimeout(() => { s.q = e.target.value.trim(); load(); }, 300); };
  $('#place', main).onclick = () => sheet({
    title: 'Where do you want to play?',
    body: html`<button class="btn primary block" id="geo">${icon('pin')}Use my current location</button><p class="form-error" id="geo-err" role="alert"></p>
      <h3 style="margin-top:16px">Cities</h3><div class="list">${(meta.cities.length ? meta.cities : [{ city: 'Bengaluru', lat: 12.9716, lng: 77.5946, venues: 0 }]).map(c => html`
        <button class="list-item" style="cursor:pointer;text-align:left" data-city="${c.city}" data-lat="${c.lat}" data-lng="${c.lng}"><div class="grow"><div class="title">${c.city}</div><div class="faint">${plural(c.venues, 'venue')}</div></div></button>`)}</div>`,
    onMount: (el, close) => {
      const set = (place, lat, lng) => { Object.assign(s, { place, lat, lng }); $('#place-l', main).textContent = place; close(); load(); };
      $('#geo', el).onclick = e => busy(e.currentTarget, () => new Promise(res => {
        if (!navigator.geolocation) { $('#geo-err', el).textContent = 'Location is not available in this browser.'; return res(); }
        navigator.geolocation.getCurrentPosition(p => { set('Near you', +p.coords.latitude.toFixed(4), +p.coords.longitude.toFixed(4)); res(); },
          () => { $('#geo-err', el).textContent = 'Location permission was denied. Pick a city instead.'; res(); }, { timeout: 10000, maximumAge: 600000 });
      }));
      on(el, 'click', '[data-city]', (_e, b) => set(b.dataset.city, +b.dataset.lat, +b.dataset.lng));
    },
  });
  $('#filters', main).onclick = () => sheet({
    title: 'Filters',
    body: html`<form id="ff">
      <div class="grid-2"><div class="field"><label for="f-km">Distance</label><select id="f-km">${[['', 'Any distance'], ['3', 'Within 3 km'], ['5', 'Within 5 km'], ['10', 'Within 10 km'], ['25', 'Within 25 km']].map(([v, l]) => html`<option value="${v}" ${String(s.maxKm || '') === v ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="field"><label for="f-price">Max price per slot (₹)</label><input id="f-price" type="number" min="0" step="50" inputmode="numeric" value="${s.maxPrice || ''}" placeholder="Any"></div>
      <div class="field"><label for="f-surface">Surface</label><select id="f-surface"><option value="">Any surface</option>${meta.surfaces.map(x => html`<option value="${x}" ${s.surface === x ? 'selected' : ''}>${titleCase(x)}</option>`)}</select></div>
      <div class="field"><label for="f-indoor">Indoor / outdoor</label><select id="f-indoor">${[['', 'Either'], ['indoor', 'Indoor'], ['outdoor', 'Outdoor']].map(([v, l]) => html`<option value="${v}" ${s.indoor === v ? 'selected' : ''}>${l}</option>`)}</select></div>
      <div class="field"><label for="f-rating">Rating</label><select id="f-rating">${[['', 'Any rating'], ['3.5', '3.5+'], ['4', '4.0+'], ['4.5', '4.5+']].map(([v, l]) => html`<option value="${v}" ${String(s.minRating || '') === v ? 'selected' : ''}>${l}</option>`)}</select></div></div>
      <label class="check"><input type="checkbox" id="f-light" ${s.lighting ? 'checked' : ''}>Floodlights for night games</label>
      <fieldset style="border:0;padding:0;margin:12px 0 0"><legend class="label">Amenities</legend><div class="grid-2" style="gap:0 12px">
        ${meta.amenities.map(a => html`<label class="check"><input type="checkbox" name="amenity" value="${a}" ${s.amenities.includes(a) ? 'checked' : ''}>${AMENITY_LABEL(a)}</label>`)}</div></fieldset></form>`,
    foot: html`<button class="btn ghost" id="f-reset">Reset</button><button class="btn primary" id="f-apply">Show turfs</button>`,
    onMount: (el, close) => {
      $('#f-apply', el).onclick = () => {
        Object.assign(s, { maxKm: $('#f-km', el).value, maxPrice: $('#f-price', el).value, surface: $('#f-surface', el).value, indoor: $('#f-indoor', el).value,
          minRating: $('#f-rating', el).value, lighting: $('#f-light', el).checked, amenities: $$('[name=amenity]:checked', el).map(x => x.value) });
        close(); load();
      };
      $('#f-reset', el).onclick = () => { Object.assign(s, { maxKm: '', maxPrice: '', surface: '', indoor: '', minRating: '', lighting: false, amenities: [] }); close(); load(); };
    },
  });
  load();
}
const i0 = (d, today) => d === today ? 'Today' : fmtDate(d).split(',')[0];

// ---- Venue + slot picker ------------------------------------------------------------------------------------------
const STATE_LABEL = { available: 'Available', almost_full: 'Almost full', held: 'Being booked', booked: 'Booked', closed: 'Closed' };
export async function venueView(main, { slug }, query) {
  mount(main, html`<div class="skeleton sk-block"></div>${skeleton('line', 4)}`);
  const v = await api(`/venues/${encodeURIComponent(slug)}`);
  document.title = `${v.name} · TurfConnect`;
  const saved = session.get(`tc.pick.${v.id}`, {});
  const pick = {
    date: query.get('date') || saved.date || v.today, sport: query.get('sport') || saved.sport || v.sports[0],
    courtId: saved.courtId || null, starts: saved.starts || [], time: query.get('time') || '',
  };
  if (pick.date < v.today) pick.date = v.today;
  if (!v.sports.includes(pick.sport)) pick.sport = v.sports[0];
  let avail = null;
  const persist = () => session.set(`tc.pick.${v.id}`, { date: pick.date, sport: pick.sport, courtId: pick.courtId, starts: pick.starts });

  mount(main, html`
    <a href="#/" class="btn ghost small no-print" style="margin-left:-8px">${icon('back')}All turfs</a>
    <div class="layout-venue">
      <div class="v-top">
        <div class="gallery" aria-label="Photos">${(v.photos.length ? v.photos : ['/img/venue-1.svg']).map((p, i) => html`<img src="${p}" alt="${v.name} photo ${i + 1}" ${i ? raw('loading="lazy"') : ''} width="640" height="360">`)}</div>
        <div class="venue-head">
          <h1>${v.name}</h1>
          <div class="row" style="gap:6px 14px">${v.rating ? html`<a href="#reviews" style="color:inherit;text-decoration:none">${stars(v.rating)} <span class="faint">${plural(v.reviews, 'review')}</span></a>` : html`<span class="tag">New venue</span>`}
            <span class="muted">${v.address}, ${v.city}</span></div>
          <div class="facts">${v.sports.map(sp => html`<span class="tag good">${sportLabel(sp)}</span>`)}<span class="tag">${v.indoor ? 'Indoor' : 'Outdoor'}</span><span class="tag">${titleCase(v.surface)}</span>
            ${v.lighting ? html`<span class="tag">Floodlit</span>` : ''}<span class="tag">${icon('clock')}${fmtTime(v.openTime)}–${fmtTime(v.closeTime)}</span></div>
          <div class="row"><a class="btn small" href="${mapsUrl(v)}" target="_blank" rel="noopener">${icon('map')}Directions</a>
            ${v.phone ? html`<a class="btn small" href="tel:${v.phone.replace(/\s/g, '')}">${icon('phone')}Call</a>` : ''}
            ${v.videoUrl ? html`<a class="btn small" href="${v.videoUrl}" target="_blank" rel="noopener">${icon('ext')}Venue video</a>` : ''}</div>
        </div>
      </div>
      <div class="v-details">
        <section class="section"><h2>About</h2><p class="muted">${v.description}</p></section>
        <section class="section"><h2>Amenities</h2><div class="amenities">${v.amenities.map(a => html`<span>${icon('check')}${AMENITY_LABEL(a)}</span>`)}</div></section>
        ${v.rules ? html`<section class="section"><h2>Venue rules</h2><ul class="muted" style="padding-left:20px;margin:0">${v.rules.split('\n').filter(Boolean).map(r => html`<li>${r}</li>`)}</ul></section>` : ''}
        <section class="section"><h2>Cancellation policy</h2><p class="muted">${policyText(v.policy)}</p></section>
        <section class="section" id="reviews"><h2>Reviews</h2>
          ${v.reviews ? html`<div class="row" style="align-items:flex-start;gap:20px;margin-bottom:8px"><div><div style="font-size:2.2rem;font-weight:800;line-height:1">${v.rating}</div><div class="faint">${plural(v.reviews, 'review')}</div></div>
            <div class="histogram" style="flex:1;min-width:180px" aria-label="Rating breakdown">${v.histogram.map(h => html`<div><span>${h.stars}★</span><span class="bar"><i style="width:${Math.round(h.count / v.reviews * 100)}%"></i></span><span class="faint">${h.count}</span></div>`)}</div></div>
            ${v.reviewList.map((r, i) => html`<div class="review" ${i >= 4 ? raw('data-more hidden') : ''}><div class="row between"><b>${r.name}</b><span>${stars(r.rating)}</span></div>
              ${r.comment ? html`<p style="margin:4px 0 0">${r.comment}</p>` : ''}<div class="faint">${fmtDate(r.created_at.slice(0, 10))}</div>
              ${r.owner_reply ? html`<div class="owner-reply"><b>Reply from the venue</b><br>${r.owner_reply}</div>` : ''}</div>`)}
            ${v.reviewList.length > 4 ? html`<button class="btn small" id="more-reviews">Show ${v.reviewList.length - 4} more reviews</button>` : ''}`
          : html`<p class="muted">No reviews yet. Be the first to play here.</p>`}
        </section>
      </div>
      <aside class="booking-panel card" aria-labelledby="pick-h">
        <h2 id="pick-h">Pick a slot</h2>
        <div class="date-strip" role="group" aria-label="Date">${Array.from({ length: Math.min(14, v.bookingWindowDays + 1) }, (_, i) => addDays(v.today, i)).map(d => html`
          <button class="date-pill" data-date="${d}" aria-pressed="${d === pick.date}"><span>${i0(d, v.today)}</span><b>${Number(d.slice(8))}</b><span>${fmtDate(d).split(' ')[2] || ''}</span></button>`)}</div>
        ${v.sports.length > 1 ? html`<div class="chips wrap" role="group" aria-label="Sport" style="margin:8px 0">${v.sports.map(sp => html`<button class="chip" data-sport="${sp}" aria-pressed="${sp === pick.sport}">${sportLabel(sp)}</button>`)}</div>` : ''}
        <div id="slots" aria-live="polite"></div>
        <div class="legend" aria-label="Legend">${['available', 'almost_full', 'held', 'booked', 'closed'].map(k => html`<span><i class="${k}"></i>${STATE_LABEL[k]}</span>`)}<span><i class="selected"></i>Your pick</span></div>
        <p class="faint">${v.holdMinutes}-minute hold while you pay. ${policyText(v.policy).split('.')[0]}.</p>
        <div class="sticky-cta" id="cta" hidden></div>
      </aside>
    </div>`);

  $('#more-reviews', main)?.addEventListener('click', e => { $$('[data-more]', main).forEach(r => { r.hidden = false; }); e.currentTarget.remove(); });

  async function loadSlots({ quiet = false } = {}) {
    const box = $('#slots', main);
    if (!quiet) mount(box, html`<div class="slot-grid">${skeleton('line', 8)}</div>`);
    try { avail = await api(`/venues/${v.id}/availability?date=${pick.date}&sport=${pick.sport}`); }
    catch (e) { mount(box, errorView(e)); $('[data-retry]', box).onclick = () => loadSlots(); return; }
    if (!avail.courts.some(c => c.id === pick.courtId)) { pick.courtId = (avail.courts.find(c => c.slots.some(s => isFree(s))) || avail.courts[0])?.id; pick.starts = []; }
    const court = avail.courts.find(c => c.id === pick.courtId);
    const lost = pick.starts.filter(st => !isFree(court?.slots.find(s => s.start === st)));
    if (lost.length) { pick.starts = []; if (quiet) toast('Someone just booked one of your selected times. Please pick again.', 'bad'); }
    drawSlots();
  }
  const isFree = s => s && (s.state === 'available' || s.state === 'almost_full');
  function drawSlots() {
    const box = $('#slots', main);
    if (!avail.courts.length) { mount(box, empty('calendar', 'No courts for this sport', 'Try another sport.')); return drawCta(); }
    const court = avail.courts.find(c => c.id === pick.courtId);
    const free = court.slots.filter(isFree).length;
    mount(box, html`
      ${avail.courts.length > 1 ? html`<div class="court-tabs" role="tablist" aria-label="Court">${avail.courts.map(c => html`
        <button class="chip" role="tab" data-court="${c.id}" aria-selected="${c.id === court.id}" aria-pressed="${c.id === court.id}">${c.name}<span class="faint" style="color:inherit;opacity:.8">· ${c.slots.filter(isFree).length}</span></button>`)}</div>` : ''}
      <p class="faint" style="margin:0 0 8px">${court.indoor ? 'Indoor' : 'Outdoor'} · ${titleCase(court.surface)} · ${plural(free, 'slot')} free ${onDay(pick.date, v.today)}</p>
      ${free ? '' : html`<div class="notice warn" style="margin-bottom:8px">${icon('info')}<div>This court is full ${onDay(pick.date, v.today)}. Try another court or date.</div></div>`}
      <div class="slot-grid">${court.slots.filter(s => s.reason !== 'Past').map(s => html`
        <button class="slot ${s.state}" data-start="${s.start}" ${isFree(s) ? '' : raw('aria-disabled="true"')} aria-pressed="${pick.starts.includes(s.start)}"
          aria-label="${fmtRange(s.start, s.end)}, ${money(s.price)}, ${pick.starts.includes(s.start) ? 'selected' : STATE_LABEL[s.state]}" ${s.start === pick.time && isFree(s) ? raw('data-suggested') : ''}>
          ${fmtTime(s.start)}<small>${isFree(s) ? money(s.price) : STATE_LABEL[s.state]}</small></button>`)}</div>
      ${court.slots.every(s => s.reason === 'Past') ? html`<p class="muted">All slots for today have passed.</p>` : ''}`);
    drawCta();
    const suggested = $('[data-suggested]', box); if (suggested && !pick.starts.length) { suggested.scrollIntoView({ block: 'nearest' }); pick.time = ''; }
  }
  function drawCta() {
    const cta = $('#cta', main);
    if (!pick.starts.length) { cta.hidden = true; return; }
    const court = avail.courts.find(c => c.id === pick.courtId);
    const chosen = court.slots.filter(s => pick.starts.includes(s.start));
    const total = chosen.reduce((a, s) => a + s.price, 0);
    cta.hidden = false;
    mount(cta, html`<div><div style="font-weight:800">${money(total)}</div><div class="faint">${plural(chosen.length, 'hour', 'hours')} · ${fmtRange(chosen[0].start, chosen.at(-1).end)}</div></div>
      <button class="btn primary" id="continue">Continue${icon('back')}</button>`);
    $('#continue svg', cta).style.transform = 'rotate(180deg)';
  }
  function toggle(start) {
    const court = avail.courts.find(c => c.id === pick.courtId);
    const order = court.slots.map(s => s.start);
    const idx = order.indexOf(start), sel = pick.starts.map(s => order.indexOf(s)).sort((a, b) => a - b);
    if (!sel.length) pick.starts = [start];
    else if (pick.starts.includes(start)) pick.starts = idx === sel[0] || idx === sel.at(-1) ? pick.starts.filter(s => s !== start) : [start];
    else if ((idx === sel.at(-1) + 1 || idx === sel[0] - 1) && sel.length < 6) pick.starts = [...pick.starts, start].sort();
    else pick.starts = [start];
    persist(); drawSlots();
  }

  on(main, 'click', '[data-date]', (_e, b) => { pick.date = b.dataset.date; pick.starts = []; $$('[data-date]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); persist(); loadSlots(); });
  on(main, 'click', '[data-sport]', (_e, b) => { pick.sport = b.dataset.sport; pick.starts = []; $$('[data-sport]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); persist(); loadSlots(); });
  on(main, 'click', '[data-court]', (_e, b) => { pick.courtId = b.dataset.court; pick.starts = []; persist(); drawSlots(); });
  on(main, 'click', '.slot', (_e, b) => { if (b.getAttribute('aria-disabled') === 'true') return; toggle(b.dataset.start); });
  on(main, 'click', '#continue', async (_e, b) => {
    if (!state.token) { persist(); toast('Sign in to book — your slot choice is saved'); return go(`#/login?next=${encodeURIComponent(`#/venue/${v.slug}?date=${pick.date}&sport=${pick.sport}`)}`); }
    await busy(b, async () => {
      try {
        const booking = await api('/bookings', { method: 'POST', idempotencyKey: uid(), body: { venueId: v.id, courtId: pick.courtId, date: pick.date, starts: pick.starts, sport: pick.sport } });
        session.del(`tc.pick.${v.id}`);
        go(`#/checkout/${booking.id}`);
      } catch (e) {
        if (e.status === 409) { pick.starts = []; persist(); await loadSlots({ quiet: true }); }
        throw e;
      }
    });
  });

  await loadSlots();
  // Live availability: any hold, payment or owner change at this venue refreshes the grid in place.
  const stop = await liveStream({ venueId: v.id, handlers: { availability: e => { if (!e.date || e.date === pick.date) loadSlots({ quiet: true }); } } });
  const poll = setInterval(() => !document.hidden && loadSlots({ quiet: true }), 45000);
  onLeave(() => { stop(); clearInterval(poll); });
}

// ---- Checkout ---------------------------------------------------------------------------------------------------
function countdown(el, until, onEnd) {
  const tick = () => {
    const left = Math.max(0, until - Date.now());
    el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
    if (!left) { clearInterval(t); onEnd?.(); }
  };
  const t = setInterval(tick, 1000); tick(); onLeave(() => clearInterval(t));
}
const steps = current => html`<ol class="steps" aria-label="Booking steps">${['Pick slot', 'Review', 'Pay', 'Play'].map((l, i) => html`<li class="${i < current ? 'done' : i === current ? 'current' : ''}" ${i === current ? raw('aria-current="step"') : ''}>${l}</li>`)}</ol>`;
const summary = b => html`<div class="row nowrap" style="align-items:flex-start">
    <img src="${b.venue.photos[0] || '/img/venue-1.svg'}" alt="" width="72" height="72" style="width:72px;height:72px;border-radius:10px;object-fit:cover">
    <div><h3 style="margin:0">${b.venue.name}</h3><div class="muted">${b.court.name} · ${sportLabel(b.sport)}</div>
    <div style="font-weight:700">${fmtLongDate(b.date)}</div><div>${fmtRange(b.startTime, b.endTime)}</div></div></div>`;
const priceLines = b => html`<div class="price-lines">${b.slots.map(s => html`<div class="line"><span>${fmtRange(s.start, s.end)}</span><span>${money(s.price)}</span></div>`)}
  ${b.discount ? html`<div class="line" style="color:var(--brand)"><span>Promo ${b.coupon || ''}</span><span>−${money(b.discount)}</span></div>` : ''}
  <div class="line total"><span>Total</span><span>${money(b.amount)}</span></div><div class="faint">This is the final price. No booking fees, nothing extra at the venue.</div></div>`;

export async function checkoutView(main, { id }) {
  mount(main, skeleton('card', 2));
  let b = await api(`/bookings/${id}`);
  if (b.status !== 'held') return go(`#/booking/${id}`, { replace: true });
  const coupons = await api('/me/coupons').catch(() => []);
  const draw = () => mount(main, html`
    ${steps(1)}
    <div class="row between"><h1 style="margin:0">Review and pay</h1><div class="tag warn" role="timer" aria-live="off">${icon('clock')}Held for <span class="countdown" id="cd"></span></div></div>
    <div class="grid-2" style="margin-top:12px;align-items:start">
      <div class="stack">
        <div class="card">${summary(b)}</div>
        <div class="card"><h2>Cancellation policy</h2><p class="muted" style="margin:0">${policyText(b.policy)}</p></div>
        ${state.me?.name ? '' : html`<div class="card"><label for="cname">Name for the booking</label><input id="cname" autocomplete="name" required></div>`}
      </div>
      <div class="stack">
        <div class="card"><h2>Price</h2>${priceLines(b)}</div>
        <div class="card"><form id="promo" class="field" style="margin:0"><label for="code">Promo code</label>
          <div class="row nowrap"><input id="code" value="${b.coupon || ''}" autocomplete="off" style="text-transform:uppercase" placeholder="e.g. WELCOME20">
          ${b.coupon ? html`<button class="btn" type="button" id="remove">Remove</button>` : html`<button class="btn">Apply</button>`}</div>
          <p class="form-error" id="perr" role="alert"></p>
          ${!b.coupon && coupons.length ? html`<div class="chips wrap">${coupons.slice(0, 4).map(c => html`<button type="button" class="chip" data-code="${c.code}">${icon('tag')}${c.code}</button>`)}</div>` : ''}</form></div>
        <button class="btn primary block" id="pay" style="min-height:52px;font-size:16px">${b.amount ? `Pay ${money(b.amount)} securely` : 'Confirm free booking'}</button>
        <p class="faint" style="text-align:center">${icon('shield')} Payments are processed by our payment partner. TurfConnect never sees or stores your card details.</p>
        <button class="btn ghost block" id="release">Cancel and release this slot</button>
      </div>
    </div>`);
  const expire = () => mount(main, html`${steps(1)}${empty('clock', 'Your hold expired', 'The slot was released so others could book it. It may still be free.', html`<a class="btn primary" href="#/venue/${b.venue.slug}?date=${b.date}&sport=${b.sport}">Pick again</a>`)}`);
  const applyCode = async (code, btn) => busy(btn, async () => {
    try { b = await api(`/bookings/${id}/coupon`, { method: 'POST', body: { code } }); draw(); wire(); if (code) toast(`Saved ${money(b.discount)}`); }
    catch (e) { if (e.code === 'hold_expired') return expire(); $('#perr', main).textContent = e.message; }
  });
  const wire = () => {
    countdown($('#cd', main), b.holdExpiresAt, expire);
    $('#promo', main).onsubmit = e => { e.preventDefault(); const c = $('#code', main).value.trim(); if (c) applyCode(c, e.submitter); };
    $('#remove', main)?.addEventListener('click', e => applyCode('', e.currentTarget));
    $$('[data-code]', main).forEach(x => { x.onclick = () => applyCode(x.dataset.code, x); });
    $('#release', main).onclick = async () => { if (await confirmDialog('The slot will be released for others to book.', { confirmLabel: 'Release slot' })) { await api(`/bookings/${id}/cancel`, { method: 'POST', body: {} }); toast('Slot released'); go(`#/venue/${b.venue.slug}?date=${b.date}`); } };
    $('#pay', main).onclick = e => busy(e.currentTarget, async () => {
      const name = $('#cname', main);
      if (name) { if (name.value.trim().length < 2) { name.setAttribute('aria-invalid', 'true'); name.focus(); throw new Error('Enter your name for the booking'); } state.me = await api('/me', { method: 'PATCH', body: { name: name.value.trim() } }); }
      try {
        const r = await api(`/bookings/${id}/pay`, { method: 'POST' });
        if (r.free) return go(`#/booking/${id}`);
        go(r.checkoutUrl);
      } catch (err) { if (err.code === 'hold_expired') return expire(); throw err; }
    });
  };
  draw(); wire();
}

// ---- Sandbox payment page (stands in for the gateway's hosted checkout) ---------------------------------------------
export async function payView(main, { intent }) {
  mount(main, skeleton('block', 1));
  const p = await api(`/payments/sandbox/${intent}`);
  if (p.status !== 'requires_payment') return go(`#/booking/${p.bookingId}`, { replace: true });
  mount(main, html`${steps(2)}<div class="gateway">
    <div class="gw-head">${icon('shield')}<div><b>TurfPay</b> <span style="opacity:.8">· Secure checkout</span></div><span class="spacer" style="flex:1"></span><span class="tag warn">Test mode</span></div>
    <div class="gw-body">
      <div class="row between"><span class="muted">Paying TurfConnect · ${p.venue}</span><span class="faint">Ref ${p.ref}</span></div>
      <h1 style="font-size:2rem;margin:8px 0">${money(p.amount)}</h1>
      <div class="notice warn">${icon('info')}<div><b>Sandbox payment.</b> No real money moves. In production this page is the payment partner's hosted checkout (UPI, cards, net banking, wallets). Choose an outcome to simulate it.</div></div>
      <div class="chips wrap" style="margin:14px 0" aria-hidden="true"><span class="chip on">UPI</span><span class="chip">Card</span><span class="chip">Net banking</span><span class="chip">Wallet</span></div>
      <button class="btn primary block" data-outcome="success" style="min-height:52px">Simulate successful payment</button>
      <button class="btn danger block" data-outcome="failure" style="margin-top:10px">Simulate failed payment</button>
      <p class="faint" style="text-align:center;margin-top:12px">Slot held for <span class="countdown" id="cd"></span></p>
    </div></div>`);
  countdown($('#cd', main), p.holdExpiresAt);
  on(main, 'click', '[data-outcome]', (_e, b) => busy(b, async () => {
    await api(`/payments/sandbox/${intent}/complete`, { method: 'POST', body: { outcome: b.dataset.outcome } });
    go(`#/booking/${p.bookingId}?paying=1`);
  }));
}

// ---- Booking / ticket ----------------------------------------------------------------------------------------------
function ics(b) {
  const f = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TurfConnect//EN', 'BEGIN:VEVENT', `UID:${b.ref}@turfconnect`, `DTSTAMP:${f(Date.now())}`, `DTSTART:${f(b.startAt)}`, `DTEND:${f(b.endAt)}`,
    `SUMMARY:${sportLabel(b.sport).replace(/^\S+ /, '')} at ${b.venue.name}`, `LOCATION:${b.venue.address}\\, ${b.venue.city}`, `DESCRIPTION:${b.court.name}. Booking ref ${b.ref}.`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:Game in 2 hours', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
const STATUS_TAG = { held: ['warn', 'Awaiting payment'], confirmed: ['good', 'Confirmed'], completed: ['info', 'Played'], cancelled: ['bad', 'Cancelled'], failed: ['bad', 'Payment failed'], expired: ['', 'Expired'] };
const statusTag = s => html`<span class="tag ${STATUS_TAG[s][0]}">${STATUS_TAG[s][1]}</span>`;

export async function bookingView(main, { id }, query) {
  mount(main, skeleton('block', 1));
  let b, offline = false;
  try { b = await api(`/bookings/${id}`); store.set(`tc.ticket.${id}`, b); }
  catch (e) { b = store.get(`tc.ticket.${id}`); if (!b || e.code !== 'network') throw e; offline = true; }
  const waiting = () => b.status === 'held' && (query.get('paying') || b.payment?.status === 'requires_payment');
  const refresh = async () => { try { b = await api(`/bookings/${id}`); store.set(`tc.ticket.${id}`, b); draw(); } catch {} };

  function draw() {
    const qr = b.status === 'confirmed' || b.status === 'completed';
    mount(main, html`
      ${offline ? html`<div class="notice warn" style="margin-bottom:12px">${icon('info')}<div>You're offline. This is your saved ticket — it still works at the desk.</div></div>` : ''}
      ${b.status === 'held' && waiting() ? html`${steps(2)}<div class="status-hero wait"><div class="icon"><div class="spinner"></div></div><h1>Confirming your payment…</h1>
          <p class="muted">This usually takes a few seconds. Don't close this page.</p></div>`
      : b.status === 'held' ? html`${steps(1)}<div class="status-hero wait"><div class="icon">${icon('clock')}</div><h1>Finish your booking</h1><p class="muted">Your slot is held while you pay.</p>
          <a class="btn primary" href="#/checkout/${b.id}">Continue to payment</a></div>`
      : b.status === 'confirmed' ? html`${query.get('paying') ? steps(3) : ''}<div class="status-hero"><div class="icon">${icon('check')}</div><h1>${query.get('paying') ? "You're booked!" : 'Your booking'}</h1>
          <p class="muted">Show this QR code at the front desk when you arrive.</p></div>`
      : b.status === 'completed' ? html`<div class="status-hero"><div class="icon">${icon('star')}</div><h1>Hope you had a great game</h1></div>`
      : b.status === 'cancelled' ? html`<div class="status-hero bad"><div class="icon">${icon('x')}</div><h1>Booking cancelled</h1>${b.cancelReason ? html`<p class="muted">${b.cancelReason}</p>` : ''}</div>`
      : html`<div class="status-hero bad"><div class="icon">${icon('x')}</div><h1>${b.status === 'failed' ? 'Payment did not go through' : 'Checkout expired'}</h1>
          <p class="muted">${b.status === 'failed' ? `You weren't charged${b.payment?.status === 'refunded' ? ' — any amount taken has been refunded' : ''}. The slot was released.` : 'The slot was released because payment was not completed in time.'}</p>
          <a class="btn primary" href="#/venue/${b.venue.slug}?date=${b.date}&sport=${b.sport}">Pick another slot</a></div>`}
      <div class="grid-2" style="align-items:start">
        ${qr ? html`<div class="ticket">${raw(qrSvg(b.ref, 200))}<div class="ref">${b.ref}</div><div class="faint">Booking reference</div>${statusTag(b.status)}
          ${b.checkedInAt ? html`<span class="tag good">${icon('check')}Checked in ${fmtDateTime(b.checkedInAt)}</span>` : ''}</div>` : ''}
        <div class="stack">
          <div class="card">${summary(b)}<hr><dl class="kv"><dt>Status</dt><dd>${statusTag(b.status)}</dd><dt>Amount</dt><dd>${money(b.amount)}</dd>
            ${b.payment ? html`<dt>Payment</dt><dd>${titleCase(b.payment.status)}</dd>` : ''}${b.source === 'manual' ? html`<dt>Paid at</dt><dd>Venue (${titleCase(b.offlineMethod)})</dd>` : ''}
            ${b.refunds.map(r => html`<dt>Refund</dt><dd>${money(r.amount)} · ${titleCase(r.status)}</dd>`)}<dt>Booked</dt><dd>${fmtDateTime(b.confirmedAt || b.createdAt)}</dd></dl></div>
          ${qr ? html`<div class="row">
            <a class="btn small" href="${mapsUrl(b.venue)}" target="_blank" rel="noopener">${icon('map')}Directions</a>
            ${b.status === 'confirmed' ? html`<button class="btn small" id="ics">${icon('calendar')}Add to calendar</button>` : ''}
            <a class="btn small" href="#/invoice/${b.id}">${icon('download')}Invoice</a>
            ${b.venue.phone ? html`<a class="btn small" href="tel:${b.venue.phone.replace(/\s/g, '')}">${icon('phone')}Call venue</a>` : ''}</div>` : ''}
          ${b.refundQuote ? html`<div class="card"><h3>Need to cancel?</h3><p class="muted">${b.refundQuote.percent === 100 ? `Cancel now for a full refund of ${money(b.refundQuote.amount)}.`
            : b.refundQuote.percent ? `Cancel now for a ${b.refundQuote.percent}% refund (${money(b.refundQuote.amount)}).` : 'Cancelling now is not refundable under the venue policy.'}</p>
            <button class="btn danger" id="cancel">Cancel booking</button></div>` : ''}
          ${b.status === 'completed' && !b.review ? html`<form class="card" id="review"><h3>Rate ${b.venue.name}</h3>
            <fieldset style="border:0;padding:0;margin:0 0 10px"><legend class="sr-only">Rating</legend><div class="chips wrap">${[1, 2, 3, 4, 5].map(n => html`
              <label class="chip"><input type="radio" name="rating" value="${n}" class="sr-only" required>${'★'.repeat(n)}</label>`)}</div></fieldset>
            <label for="rc">Comment (optional)</label><textarea id="rc" maxlength="1000" placeholder="Surface, lights, staff, facilities…"></textarea>
            <button class="btn primary" style="margin-top:10px">Post review</button></form>` : ''}
          ${b.review ? html`<div class="card"><h3>Your review</h3>${stars(b.review.rating)}<p>${b.review.comment}</p>${b.review.owner_reply ? html`<div class="owner-reply"><b>Venue reply</b><br>${b.review.owner_reply}</div>` : ''}</div>` : ''}
          <div class="row">
            ${b.status === 'completed' || b.status === 'cancelled' ? html`<a class="btn small primary" href="#/venue/${b.venue.slug}?sport=${b.sport}">Book again</a>` : ''}
            ${(b.status === 'completed' || b.status === 'cancelled') && b.payment && b.payment.amount > b.payment.refunded && !b.refunds.some(r => r.status === 'pending') ? html`<button class="btn small" id="refund-req">Request a refund</button>` : ''}
            <a class="btn small ghost" href="#/support/new?booking=${b.id}">${icon('chat')}Get help</a></div>
        </div>
      </div>`);
    $('#ics', main)?.addEventListener('click', () => downloadFile(`turfconnect-${b.ref}.ics`, ics(b), 'text/calendar'));
    $('#cancel', main)?.addEventListener('click', async () => {
      const reason = await confirmDialog(b.refundQuote.amount ? `You'll get ${money(b.refundQuote.amount)} back to your original payment method in 5–7 working days.` : 'You will not get a refund for this cancellation.',
        { title: 'Cancel this booking?', confirmLabel: 'Cancel booking', danger: true, input: { label: 'Reason (optional)', placeholder: 'e.g. Rain, team unavailable' } });
      if (reason === null) return;
      try { const r = await api(`/bookings/${b.id}/cancel`, { method: 'POST', body: { reason } }); b = r.booking; draw(); toast(r.refund ? `Cancelled. ${money(r.refund.amount)} refund issued.` : 'Booking cancelled'); }
      catch (e) { toast(e.message, 'bad'); }
    });
    $('#refund-req', main)?.addEventListener('click', async () => {
      const reason = await confirmDialog('Tell the venue what went wrong. They will review it and you will be notified of the decision.', { title: 'Request a refund', confirmLabel: 'Send request', input: { label: 'What happened?', multiline: true, required: true } });
      if (!reason) return;
      try { await api(`/bookings/${b.id}/refund-request`, { method: 'POST', body: { reason } }); toast('Request sent to the venue'); refresh(); } catch (e) { toast(e.message, 'bad'); }
    });
    const rf = $('#review', main);
    if (rf) {
      $$('input[name=rating]', rf).forEach(r => r.addEventListener('change', () => $$('label.chip', rf).forEach(l => l.classList.toggle('on', l.contains(r) && r.checked))));
      rf.onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
        const rating = $('input[name=rating]:checked', rf)?.value;
        if (!rating) throw new Error('Pick a star rating');
        await api(`/bookings/${b.id}/review`, { method: 'POST', body: { rating: Number(rating), comment: $('#rc', rf).value } }); toast('Thanks for your review!'); refresh();
      }); };
    }
  }
  draw();
  if (waiting() && !offline) {
    const onUpdate = e => { if (e.detail.id === id) refresh(); };
    window.addEventListener('booking-update', onUpdate);
    const started = Date.now();
    const poll = setInterval(async () => { await refresh(); if (!waiting() || Date.now() - started > 90000) clearInterval(poll); }, 1500);
    onLeave(() => { clearInterval(poll); window.removeEventListener('booking-update', onUpdate); });
  }
}

export async function bookingsView(main, _p, query) {
  const tab = query.get('tab') === 'past' ? 'past' : 'upcoming';
  mount(main, html`<h1>My bookings</h1><div class="tabs" role="tablist">
    <a href="#/bookings" role="tab" aria-selected="${tab === 'upcoming'}">Upcoming</a><a href="#/bookings?tab=past" role="tab" aria-selected="${tab === 'past'}">Past</a></div><div id="list">${skeleton('card', 3)}</div>`);
  let list;
  try { list = await api(`/bookings/mine?scope=${tab}`); store.set(`tc.bookings.${tab}`, list); }
  catch (e) { list = store.get(`tc.bookings.${tab}`); if (!list || e.code !== 'network') throw e; toast('Offline: showing saved bookings'); }
  mount($('#list', main), list.length ? html`<div class="list">${list.map(b => html`
    <a class="list-item" href="#/booking/${b.id}">
      <div style="text-align:center;min-width:52px"><div class="faint" style="font-weight:700;text-transform:uppercase">${fmtDate(b.date).split(' ')[2]}</div><div style="font-size:1.5rem;font-weight:800;line-height:1">${Number(b.date.slice(8))}</div><div class="faint">${fmtDate(b.date).split(',')[0]}</div></div>
      <div class="grow"><div class="title">${b.venue.name}</div><div class="muted" style="font-size:14px">${b.court.name} · ${fmtRange(b.startTime, b.endTime)}</div><div class="row" style="gap:6px;margin-top:4px">${statusTag(b.status)}<span class="faint">${money(b.amount)}</span></div></div>
      ${b.status === 'confirmed' ? icon('qr') : ''}</a>`)}</div>`
    : tab === 'upcoming' ? empty('ticket', 'No upcoming games', 'Find a turf and book your next game in under two minutes.', html`<a class="btn primary" href="#/">Find a turf</a>`)
      : empty('clock', 'No past bookings', 'Games you have played or cancelled will show here.'));
}

export async function invoiceView(main, { id }) {
  mount(main, skeleton('block', 1));
  const inv = await api(`/bookings/${id}/invoice`);
  const b = inv.booking, refunded = b.refunds.filter(r => r.status === 'processed').reduce((a, r) => a + r.amount, 0);
  mount(main, html`<div class="row between no-print" style="margin-bottom:12px"><a class="btn ghost small" href="#/booking/${id}">${icon('back')}Back</a><button class="btn small" id="print">${icon('print')}Print or save as PDF</button></div>
    <article class="card" style="max-width:760px;margin:0 auto">
      <div class="row between" style="align-items:flex-start"><div><h1 style="margin:0">Invoice</h1><div class="muted">${inv.number}</div></div>
        <div style="text-align:right"><b>TurfConnect</b><div class="faint">On behalf of ${inv.venue.business_name || inv.venue.name}</div>${inv.venue.tax_id ? html`<div class="faint">GSTIN ${inv.venue.tax_id}</div>` : ''}</div></div>
      <hr><div class="grid-2"><div><div class="faint">Billed to</div><b>${inv.customer.name || 'Customer'}</b><div class="muted">${inv.customer.phone || ''} ${inv.customer.email || ''}</div></div>
        <div><div class="faint">Issued</div><b>${fmtDateTime(inv.issuedAt)}</b><div class="faint" style="margin-top:6px">Venue</div><b>${inv.venue.name}</b><div class="muted">${inv.venue.address}, ${inv.venue.city}</div></div></div>
      <div class="table-wrap" style="margin-top:16px"><table><thead><tr><th>Item</th><th class="num">Amount</th></tr></thead><tbody>
        ${b.slots.map(s => html`<tr><td>${b.court.name} · ${sportLabel(b.sport)}<br><span class="faint">${fmtLongDate(b.date)}, ${fmtRange(s.start, s.end)}</span></td><td class="num">${money(s.price)}</td></tr>`)}
        ${b.discount ? html`<tr><td>Promo ${b.coupon || ''}</td><td class="num">−${money(b.discount)}</td></tr>` : ''}
        <tr><td><b>Total paid</b> <span class="faint">(${b.source === 'manual' ? `at venue, ${titleCase(b.offlineMethod)}` : 'online'})</span></td><td class="num"><b>${money(b.amount)}</b></td></tr>
        ${refunded ? html`<tr><td>Refunded</td><td class="num">−${money(refunded)}</td></tr>` : ''}</tbody></table></div>
      <p class="faint" style="margin-top:12px">Booking reference ${b.ref}. Prices include applicable taxes. This is a computer-generated invoice.</p>
    </article>`);
  $('#print', main).onclick = () => window.print();
}
