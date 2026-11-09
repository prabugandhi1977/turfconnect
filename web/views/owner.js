// Venue business console: onboarding, calendar, bookings, check-in, pricing, coupons, refunds, customers, reviews,
// reports, staff, payouts, settings and audit log. What each person sees follows their venue role.
import {
  $, $$, api, busy, confirmDialog, dayLabel, empty, errorView, fmtDate, fmtDateTime, fmtLongDate, fmtRange, fmtTime, go, html, icon, liveStream, money, mount, on, onLeave,
  plural, policyText, raw, setMe, sheet, skeleton, sportLabel, state, store, titleCase, toast, addDays, WEEKDAYS, weekdaysLabel,
} from '../lib.js';
import { ticketList } from './support.js';
import { MACHINE_ICON, statusPill } from './vending.js';
import { answerForm, questionCard } from './community.js';

const LEVEL = { front_desk: 1, manager: 2, owner: 3, admin: 4 };
const can = (role, min) => LEVEL[role] >= LEVEL[min];
const TABS = [
  ['overview', 'Overview', 'home', 'front_desk'], ['calendar', 'Calendar', 'calendar', 'front_desk'], ['bookings', 'Bookings', 'list', 'front_desk'],
  ['checkin', 'Check-in', 'qr', 'front_desk'], ['customers', 'Customers', 'users', 'front_desk'], ['support', 'Messages', 'chat', 'front_desk'],
  ['reviews', 'Reviews', 'star', 'front_desk'], ['sessions', 'Wellness classes', 'bulb', 'manager'], ['store', 'Shop & rentals', 'bag', 'front_desk'], ['vending', 'Vending machines', 'cash', 'manager'], ['surveillance', 'Surveillance', 'camera', 'front_desk'], ['access', 'Access & security', 'shield', 'front_desk'], ['media', 'Photos & videos', 'star', 'manager'], ['coaches', 'Coaches', 'users', 'manager'], ['questions', 'Questions', 'chat', 'manager'], ['pricing', 'Pricing & hours', 'tag', 'manager'], ['coupons', 'Promo codes', 'gift', 'manager'],
  ['refunds', 'Refunds', 'wallet', 'manager'], ['reports', 'Reports', 'chart', 'manager'], ['settings', 'Venue setup', 'settings', 'manager'],
  ['staff', 'Staff', 'users', 'owner'], ['payouts', 'Payouts', 'cash', 'owner'], ['audit', 'Audit log', 'shield', 'owner'],
];
const STATUS_TAG = { held: ['warn', 'Awaiting payment'], confirmed: ['good', 'Confirmed'], completed: ['info', 'Played'], cancelled: ['bad', 'Cancelled'], failed: ['bad', 'Failed'], expired: ['', 'Expired'] };
const statusTag = s => html`<span class="tag ${STATUS_TAG[s]?.[0] || ''}">${STATUS_TAG[s]?.[1] || s}</span>`;
const venueStatus = s => html`<span class="tag ${{ active: 'good', pending: 'warn', suspended: 'bad', rejected: 'bad' }[s]}">${{ active: 'Live', pending: 'Awaiting verification', suspended: 'Suspended', rejected: 'Needs changes' }[s]}</span>`;
const kpi = (k, v, s = '') => html`<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div>${s ? html`<div class="s">${s}</div>` : ''}</div>`;
const who = b => b.customerName || 'Customer';
const formData = form => Object.fromEntries(new FormData(form).entries());
// Re-render a pane into a fresh element so delegated listeners from the previous render do not pile up.
function repaint(ctx, paneFn) { const n = ctx.pane.cloneNode(false); ctx.pane.replaceWith(n); ctx.pane = n; return paneFn(ctx); }

// ---- Entry points ---------------------------------------------------------------------------------------------
export async function ownerHome(main) {
  mount(main, skeleton('card', 2));
  const me = await api('/me'); setMe(me);
  if (!me.venues.length) return go('#/owner/new', { replace: true });
  const last = store.get('tc.venue');
  go(`#/owner/${(me.venues.find(v => v.id === last) || me.venues[0]).id}`, { replace: true });
}

export async function ownerConsole(main, { vid, tab = 'overview' }) {
  mount(main, skeleton('block', 1));
  const venue = await api(`/owner/venues/${vid}`);
  const role = venue.role;
  store.set('tc.venue', vid);
  const tabs = TABS.filter(t => can(role, t[3]));
  if (!tabs.some(t => t[0] === tab)) return go(`#/owner/${vid}`, { replace: true });
  const venues = state.me?.venues || [];
  mount(main, html`
    <div class="console-head">
      ${venues.length > 1 ? html`<label class="sr-only" for="venue-pick">Venue</label><select id="venue-pick">${venues.map(v => html`<option value="${v.id}" ${v.id === vid ? 'selected' : ''}>${v.name}</option>`)}</select>`
        : html`<h1 style="margin:0">${venue.name}</h1>`}
      ${venueStatus(venue.status)}<span class="tag">${titleCase(role)}</span><span class="spacer" style="flex:1"></span>
      ${venue.status === 'active' ? html`<a class="btn small" href="#/venue/${venue.slug}">${icon('ext')}Public page</a>` : ''}
      ${can(role, 'owner') && role !== 'admin' ? html`<a class="btn small" href="#/owner/new">${icon('plus')}Add venue</a>` : ''}
    </div>
    <div class="console">
      <nav class="console-nav" aria-label="Venue sections">${tabs.map(([k, l, ic]) => html`<a href="#/owner/${vid}/${k}" ${k === tab ? raw('aria-current="page"') : ''}>${icon(ic)}${l}</a>`)}</nav>
      <section id="pane" aria-label="${tabs.find(t => t[0] === tab)[1]}"></section>
    </div>`);
  $('#venue-pick', main)?.addEventListener('change', e => go(`#/owner/${e.target.value}/${tab}`));
  const pane = $('#pane', main);
  const ctx = { vid, venue, role, pane, reload: () => ownerConsole(main, { vid, tab }) };
  mount(pane, skeleton('card', 2));
  try { await PANES[tab](ctx); }
  catch (e) { mount(pane, errorView(e)); $('[data-retry]', pane).onclick = ctx.reload; }
}

// ---- Overview -------------------------------------------------------------------------------------------------
async function overviewPane(ctx) {
  const { vid, venue, role, pane } = ctx;
  const o = await api(`/owner/venues/${vid}/overview`);
  mount(pane, html`
    ${venue.status === 'pending' ? html`<div class="notice warn">${icon('clock')}<div><b>Your venue is being verified.</b> Thidal usually reviews new venues within one working day. You can finish setting up courts, prices and photos meanwhile.</div></div>` : ''}
    ${venue.status === 'suspended' || venue.status === 'rejected' ? html`<div class="notice bad">${icon('alert')}<div><b>${venue.status === 'suspended' ? 'Bookings are paused.' : 'Your application needs changes.'}</b> ${o.statusNote || ''} Contact Thidal support to resolve this.</div></div>` : ''}
    <h2 style="margin-top:12px">Today · ${fmtLongDate(o.today)}</h2>
    <div class="kpis">
      ${kpi('Bookings today', o.todayBookings, `${o.checkedIn} checked in`)}
      ${o.report ? kpi('Revenue today', money(o.report.revenue), `${money(o.report.online)} online · ${money(o.report.offline)} at desk`) : ''}
      ${o.report ? kpi('Occupancy today', `${o.report.occupancy}%`, `${o.report.bookedSlots} of ${o.report.capacity} slots`) : ''}
      ${kpi('Rating', o.rating.r ?? '—', plural(o.rating.n, 'review'))}
      ${can(role, 'manager') ? kpi('Refund requests', o.pendingRefunds, o.pendingRefunds ? 'Waiting for you' : 'All clear') : ''}
      ${kpi('Open messages', o.openTickets)}
    </div>
    <div class="row section"><a class="btn primary" href="#/owner/${vid}/calendar">${icon('calendar')}Open calendar</a><a class="btn" href="#/owner/${vid}/checkin">${icon('qr')}Check in a player</a>
      ${can(role, 'manager') ? html`<a class="btn" href="#/owner/${vid}/reports">${icon('chart')}Reports</a>` : ''}</div>
    <h2 class="section">Next up</h2>
    ${o.upcoming.length ? html`<div class="list">${o.upcoming.map(b => html`<button class="list-item" style="cursor:pointer;text-align:left;width:100%" data-booking="${b.id}">
      <div style="min-width:76px"><b>${fmtTime(b.startTime)}</b><div class="faint">${dayLabel(b.date, o.today)}</div></div>
      <div class="grow"><div class="title">${who(b)}</div><div class="faint">${b.court.name} · ${b.ref} · ${b.source === 'manual' ? 'Desk booking' : 'Online'}</div></div>
      ${b.checkedInAt ? html`<span class="tag good">${icon('check')}In</span>` : statusTag(b.status)}</button>`)}</div>`
      : empty('calendar', 'Nothing booked yet', 'Upcoming bookings will appear here.')}`);
  on(pane, 'click', '[data-booking]', (_e, b) => bookingSheet(vid, b.dataset.booking, role, () => repaint(ctx, overviewPane)));
}

// ---- Booking detail sheet (shared by calendar, bookings, check-in) ---------------------------------------------------
async function bookingSheet(vid, bookingId, role, onChange) {
  let b = await api(`/owner/venues/${vid}/bookings/${bookingId}`).catch(e => { toast(e.message, 'bad'); });
  if (!b) return;
  const s = sheet({ title: `Booking ${b.ref}`, body: '', onMount: () => {} });
  const draw = () => {
    const started = b.startAt <= Date.now();
    const paidOnline = b.payment && ['succeeded', 'partially_refunded'].includes(b.payment.status);
    mount($('.sheet-body', s.el), html`
      <div class="row between"><div><b style="font-size:1.1rem">${who(b)}</b><div class="faint">${b.customerPhone ? html`<a href="tel:${b.customerPhone}">${b.customerPhone}</a>` : 'No phone'}</div></div>${statusTag(b.status)}</div>
      <hr><dl class="kv">
        <dt>When</dt><dd>${fmtDate(b.date)}, ${fmtRange(b.startTime, b.endTime)}</dd><dt>Court</dt><dd>${b.court.name}</dd><dt>Sport</dt><dd>${sportLabel(b.sport)}</dd>
        <dt>Source</dt><dd>${b.source === 'manual' ? `Desk · ${titleCase(b.offlineMethod)}` : 'Online'}</dd><dt>Amount</dt><dd>${money(b.amount)}${b.discount ? html` <span class="faint">(−${money(b.discount)} ${b.coupon || ''})</span>` : ''}</dd>
        ${b.payment ? html`<dt>Payment</dt><dd>${titleCase(b.payment.status)}${b.payment.refunded ? ` · ${money(b.payment.refunded)} refunded` : ''}</dd>` : ''}
        <dt>Check-in</dt><dd>${b.checkedInAt ? fmtDateTime(b.checkedInAt) : b.noShow ? 'No-show' : '—'}</dd>
        ${b.cancelReason ? html`<dt>Cancel reason</dt><dd>${b.cancelReason}</dd>` : ''}
      </dl>
      ${b.refunds.length ? html`<h3 class="section">Refunds</h3>${b.refunds.map(r => html`<div class="faint">${money(r.amount)} · ${titleCase(r.status)} · ${r.reason}</div>`)}` : ''}
      <form id="notes" class="section"><label for="bn">Notes (visible to staff)</label><div class="row nowrap"><input id="bn" value="${b.notes || ''}" maxlength="300"><button class="btn small">Save</button></div>
        ${b.status === 'completed' ? html`<div class="hint faint">Edits to completed bookings are recorded in the audit log.</div>` : ''}</form>
      <div class="row section">
        ${['confirmed', 'completed'].includes(b.status) && !b.checkedInAt ? html`<button class="btn primary" data-act="checkin">${icon('check')}Check in</button>` : ''}
        ${['confirmed', 'completed'].includes(b.status) && started && !b.checkedInAt && !b.noShow ? html`<button class="btn" data-act="noshow">Mark no-show</button>` : ''}
        ${b.status === 'confirmed' && can(role, 'manager') ? html`<button class="btn danger" data-act="cancel">Cancel booking</button>` : ''}
        ${paidOnline && can(role, 'manager') ? html`<button class="btn" data-act="refund">Issue refund</button>` : ''}
      </div>`);
  };
  draw();
  const act = async (fn) => { try { b = await fn(); draw(); onChange?.(); } catch (e) { toast(e.message, 'bad'); } };
  on(s.el, 'submit', '#notes', e => { e.preventDefault(); act(async () => { const r = await api(`/owner/venues/${vid}/bookings/${b.id}`, { method: 'PATCH', body: { notes: $('#bn', s.el).value } }); toast('Notes saved'); return r; }); });
  on(s.el, 'click', '[data-act]', async (_e, btn) => {
    const a = btn.dataset.act;
    if (a === 'checkin') return act(async () => { const r = await api(`/owner/venues/${vid}/bookings/${b.id}/check-in`, { method: 'POST' }); toast(`${who(r)} checked in`); return r; });
    if (a === 'noshow') return act(() => api(`/owner/venues/${vid}/bookings/${b.id}/no-show`, { method: 'POST' }));
    if (a === 'cancel') {
      const reason = await confirmDialog(b.source === 'online' ? `The customer gets a full refund of ${money(b.payment ? b.payment.amount - b.payment.refunded : 0)} and a notification.` : 'This frees the slot. Settle any cash with the customer at the desk.',
        { title: `Cancel ${b.ref}?`, confirmLabel: 'Cancel booking', danger: true, input: { label: 'Reason (shared with the customer)', required: true, placeholder: 'e.g. Pitch maintenance' } });
      if (reason) act(async () => (await api(`/owner/venues/${vid}/bookings/${b.id}/cancel`, { method: 'POST', body: { reason } })).booking);
    }
    if (a === 'refund') {
      const left = b.payment.amount - b.payment.refunded;
      sheet({ title: 'Issue a refund', body: html`<div class="field"><label for="ra">Amount (₹)</label><input id="ra" type="number" min="1" max="${left / 100}" step="1" value="${left / 100}" inputmode="decimal"><div class="hint">Up to ${money(left)} remains on this payment.</div></div>
          <div class="field"><label for="rr">Reason</label><input id="rr" required placeholder="e.g. Lights failed for 20 minutes"></div><p class="form-error" id="re" role="alert"></p>`,
        foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="go">Refund</button>`,
        onMount: (el, close) => { $('#go', el).onclick = e => busy(e.currentTarget, async () => {
          try { await api(`/owner/venues/${vid}/bookings/${b.id}/refund`, { method: 'POST', body: { amount: $('#ra', el).value, reason: $('#rr', el).value } }); close(); toast('Refund issued');
            b = await api(`/owner/venues/${vid}/bookings/${b.id}`); draw(); onChange?.(); } catch (err) { $('#re', el).textContent = err.message; }
        }); } });
    }
  });
}

// Manual (desk) booking: walk-ins and phone bookings. Paid at the venue, confirmed immediately.
function manualBookingSheet(ctx, { courtId, date, start }, onDone) {
  const { vid, venue } = ctx;
  const courts = venue.courts.filter(c => c.active);
  const court = courts.find(c => c.id === courtId) || courts[0];
  const starts = slotTimes(venue);
  sheet({
    title: 'New desk booking',
    body: html`<form id="mb">
      <div class="grid-2"><div class="field"><label for="m-court">Court</label><select id="m-court" name="courtId">${courts.map(c => html`<option value="${c.id}" ${c.id === court.id ? 'selected' : ''}>${c.name}</option>`)}</select></div>
      <div class="field"><label for="m-date">Date</label><input id="m-date" name="date" type="date" value="${date}" required></div>
      <div class="field"><label for="m-start">Start</label><select id="m-start" name="start">${starts.map(t => html`<option value="${t}" ${t === start ? 'selected' : ''}>${fmtTime(t)}</option>`)}</select></div>
      <div class="field"><label for="m-len">Duration</label><select id="m-len" name="len">${[1, 2, 3, 4].map(n => html`<option value="${n}">${plural(n * venue.slot_minutes / 60, 'hour')}</option>`)}</select></div>
      <div class="field"><label for="m-name">Customer name</label><input id="m-name" name="customerName" required autocomplete="off"></div>
      <div class="field"><label for="m-phone">Phone (optional)</label><input id="m-phone" name="customerPhone" type="tel" autocomplete="off"><div class="hint">If they have a Thidal account, they get the booking in their app.</div></div>
      <div class="field"><label for="m-method">Payment</label><select id="m-method" name="method">${['cash', 'upi', 'card_terminal', 'unpaid', 'complimentary'].map(m => html`<option value="${m}">${titleCase(m)}</option>`)}</select></div>
      <div class="field"><label for="m-amt">Amount charged (₹)</label><input id="m-amt" name="amount" type="number" min="0" step="1" placeholder="Standard price" inputmode="decimal"></div></div>
      <div class="field"><label for="m-notes">Notes</label><input id="m-notes" name="notes" maxlength="300"></div>
      <p class="form-error" id="m-err" role="alert"></p></form>`,
    foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="m-go">Confirm booking</button>`,
    onMount: (el, close) => { $('#m-go', el).onclick = e => busy(e.currentTarget, async () => {
      const f = formData($('#mb', el)), i = starts.indexOf(f.start);
      try {
        const b = await api(`/owner/venues/${vid}/bookings`, { method: 'POST', body: { courtId: f.courtId, date: f.date, starts: starts.slice(i, i + Number(f.len)), customerName: f.customerName, customerPhone: f.customerPhone, method: f.method, amount: f.amount, notes: f.notes } });
        close(); toast(`Booked ${b.ref} for ${b.customerName}`); onDone?.();
      } catch (err) { $('#m-err', el).textContent = err.message; }
    }); },
  });
}
function slotTimes(v) { const out = []; const [oh, om] = v.open_time.split(':').map(Number), [ch, cm] = v.close_time.split(':').map(Number);
  for (let t = oh * 60 + om; t + v.slot_minutes <= ch * 60 + cm; t += v.slot_minutes) out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`); return out; }

// ---- Calendar -------------------------------------------------------------------------------------------------------
async function calendarPane(ctx) {
  const { vid, venue, role, pane } = ctx;
  let date = store.get(`tc.cal.${vid}`, venue.today);
  if (date < addDays(venue.today, -60)) date = venue.today;
  mount(pane, html`<div class="row between" style="margin-bottom:12px">
      <div class="row"><button class="icon-btn" id="prev" aria-label="Previous day">${icon('back')}</button>
        <label class="sr-only" for="cal-date">Date</label><input type="date" id="cal-date" value="${date}" style="width:auto">
        <button class="icon-btn" id="next" aria-label="Next day" style="transform:rotate(180deg)">${icon('back')}</button>
        <button class="btn small" id="today">Today</button></div>
      <button class="btn primary small" id="new">${icon('plus')}Desk booking</button></div>
    <div class="legend"><span><i></i>Free (tap to book or block)</span><span><i style="background:var(--brand-soft);border-color:transparent"></i>Online</span><span><i style="background:var(--info-soft);border-color:transparent"></i>Desk</span><span><i class="held"></i>Checkout in progress</span><span><i class="closed"></i>Closed</span></div>
    <div id="grid"><div class="skeleton sk-block"></div></div>`);
  let data;
  const load = async () => {
    store.set(`tc.cal.${vid}`, date); $('#cal-date', pane).value = date;
    try { data = await api(`/owner/venues/${vid}/calendar?date=${date}`); draw(); }
    catch (e) { mount($('#grid', pane), errorView(e)); $('[data-retry]', pane).onclick = load; }
  };
  const draw = () => {
    const times = data.courts[0]?.slots.map(s => s) || [];
    if (!data.courts.length) return mount($('#grid', pane), empty('settings', 'No active courts', 'Add a court in Venue setup to start taking bookings.'));
    mount($('#grid', pane), html`<p class="faint">${fmtLongDate(date)}${date === data.today ? ' · today' : ''}</p><div class="cal-wrap"><div class="cal" role="grid" aria-label="Bookings by court and time" style="grid-template-columns:64px repeat(${data.courts.length}, minmax(150px,1fr))">
      <div class="h corner" role="columnheader">Time</div>${data.courts.map(c => html`<div class="h" role="columnheader">${c.name}<div class="faint" style="font-weight:500">${c.sports.map(sportLabel).join(', ')}</div></div>`)}
      ${times.map((t, i) => html`<div class="t" role="rowheader">${fmtTime(t.start)}</div>${data.courts.map(c => {
        const s = c.slots[i];
        const label = s.state === 'booked' || s.state === 'held' ? `${s.who || 'Customer'}` : s.state === 'closed' ? s.reason : 'Free';
        return html`<button class="cell ${s.state === 'almost_full' ? 'available' : s.state} ${s.source === 'manual' ? 'manual' : ''}" role="gridcell" data-court="${c.id}" data-start="${s.start}"
          aria-label="${c.name} ${fmtTime(s.start)}: ${label}${s.ref ? `, ${s.ref}` : ''}">
          <b>${label}</b><small>${s.ref ? html`${s.ref}${s.checkedIn ? html` · <span class="ci">checked in</span>` : ''}` : s.state === 'closed' ? '' : money(s.price)}${s.priceSource === 'override' ? ' · custom' : ''}</small></button>`;
      })}`)}</div></div>`);
  };
  on(pane, 'click', '.cell', async (_e, cell) => {
    const court = data.courts.find(c => c.id === cell.dataset.court), s = court.slots.find(x => x.start === cell.dataset.start);
    if (s.bookingId) return bookingSheet(vid, s.bookingId, role, load);
    if (s.reason === 'Past') return toast('This time has passed');
    const manager = can(role, 'manager');
    const slotAction = (action, extra = {}) => api(`/owner/venues/${vid}/slots`, { method: 'PUT', body: { courtId: court.id, date, starts: [s.start], action, ...extra } }).then(load).catch(e => toast(e.message, 'bad'));
    sheet({
      title: `${court.name} · ${fmtTime(s.start)}`,
      body: html`<p class="muted">${fmtLongDate(date)} · ${s.state === 'closed' ? `Closed (${s.reason})` : `Free · ${money(s.price)}${s.priceSource && s.priceSource !== 'base' ? ` (${s.priceSource})` : ''}`}</p>
        <div class="list">
          ${s.state !== 'closed' ? html`<button class="list-item" style="cursor:pointer;text-align:left" data-do="book">${icon('plus')}<div class="grow"><div class="title">Desk booking</div><div class="faint">Walk-in or phone booking, paid at the venue</div></div></button>` : ''}
          ${manager && s.state !== 'closed' ? html`<button class="list-item" style="cursor:pointer;text-align:left" data-do="block">${icon('x')}<div class="grow"><div class="title">Block this slot</div><div class="faint">Maintenance, private event, coaching</div></div></button>` : ''}
          ${manager && s.blocked ? html`<button class="list-item" style="cursor:pointer;text-align:left" data-do="open">${icon('check')}<div class="grow"><div class="title">Re-open slot</div></div></button>` : ''}
          ${manager && s.recurring ? html`<button class="list-item" style="cursor:pointer;text-align:left" data-do="open">${icon('check')}<div class="grow"><div class="title">Open just this date</div><div class="faint">The weekly closure stays for other weeks</div></div></button>` : ''}
          ${manager && s.state !== 'closed' ? html`<button class="list-item" style="cursor:pointer;text-align:left" data-do="price">${icon('tag')}<div class="grow"><div class="title">Set a price for this slot</div><div class="faint">Only affects new bookings</div></div></button>` : ''}
          ${manager && s.priceSource === 'override' ? html`<button class="list-item" style="cursor:pointer;text-align:left" data-do="reset">${icon('refresh')}<div class="grow"><div class="title">Back to standard price</div></div></button>` : ''}
        </div>`,
      onMount: (el, close) => on(el, 'click', '[data-do]', async (_e, b) => {
        const what = b.dataset.do; close();
        if (what === 'book') return manualBookingSheet(ctx, { courtId: court.id, date, start: s.start }, load);
        if (what === 'block') { const reason = await confirmDialog('Customers will see this slot as closed.', { title: 'Block slot', confirmLabel: 'Block', input: { label: 'Reason', placeholder: 'e.g. Turf maintenance' } }); if (reason !== null) slotAction('block', { reason }); }
        if (what === 'open' || what === 'reset') slotAction(what);
        if (what === 'price') { const p = await confirmDialog('Existing bookings keep the price they paid.', { title: 'Slot price', confirmLabel: 'Set price', input: { label: 'Price (₹)', type: 'number', value: s.price / 100, required: true } }); if (p) slotAction('price', { price: p }); }
      }),
    });
  });
  $('#prev', pane).onclick = () => { date = addDays(date, -1); load(); };
  $('#next', pane).onclick = () => { date = addDays(date, 1); load(); };
  $('#today', pane).onclick = () => { date = venue.today; load(); };
  $('#cal-date', pane).onchange = e => { if (e.target.value) { date = e.target.value; load(); } };
  $('#new', pane).onclick = () => manualBookingSheet(ctx, { date, start: slotTimes(venue)[0] }, load);
  await load();
  const stop = await liveStream({ venueId: vid, handlers: { availability: e => { if (!e.date || e.date === date) load(); } } });
  onLeave(stop);
}

// ---- Bookings list --------------------------------------------------------------------------------------------------
async function bookingsPane({ vid, venue, role, pane }) {
  const f = { from: venue.today, to: addDays(venue.today, 6), q: '', status: '' };
  mount(pane, html`<form class="row" id="bf" style="margin-bottom:12px">
      <div class="search-box" style="flex:1;min-width:200px">${icon('search')}<input type="search" id="bq" placeholder="Ref, name or phone" aria-label="Search bookings"></div>
      <label class="sr-only" for="bfrom">From</label><input type="date" id="bfrom" value="${f.from}" style="width:auto"><label class="sr-only" for="bto">To</label><input type="date" id="bto" value="${f.to}" style="width:auto">
      <label class="sr-only" for="bst">Status</label><select id="bst" style="width:auto"><option value="">All statuses</option>${['confirmed', 'completed', 'cancelled', 'held'].map(s => html`<option value="${s}">${STATUS_TAG[s][1]}</option>`)}</select></form>
    <div id="bl">${skeleton('line', 6)}</div>`);
  let t;
  const load = async () => {
    const qs = new URLSearchParams({ from: f.from, to: f.to }); if (f.q) qs.set('q', f.q); if (f.status) qs.set('status', f.status);
    const list = await api(`/owner/venues/${vid}/bookings?${qs}`);
    mount($('#bl', pane), list.length ? html`<p class="faint">${plural(list.length, 'booking')} · ${money(list.filter(b => b.status !== 'cancelled').reduce((a, b) => a + b.amount, 0))}</p>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th>Court</th><th>Customer</th><th>Ref</th><th>Source</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
      ${list.map(b => html`<tr data-booking="${b.id}" style="cursor:pointer" tabindex="0"><td>${fmtDate(b.date)}</td><td>${fmtRange(b.startTime, b.endTime)}</td><td>${b.court.name}</td><td>${who(b)}</td><td>${b.ref}</td>
        <td>${b.source === 'manual' ? 'Desk' : 'Online'}</td><td class="num">${money(b.amount)}</td><td>${statusTag(b.status)} ${b.checkedInAt ? html`<span class="tag good">In</span>` : ''}</td></tr>`)}</tbody></table></div>`
      : empty('list', 'No bookings', 'Nothing matches these filters.'));
  };
  $('#bq', pane).oninput = e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 300); };
  $('#bfrom', pane).onchange = e => { f.from = e.target.value; load(); };
  $('#bto', pane).onchange = e => { f.to = e.target.value; load(); };
  $('#bst', pane).onchange = e => { f.status = e.target.value; load(); };
  on(pane, 'click', '[data-booking]', (_e, r) => bookingSheet(vid, r.dataset.booking, role, load));
  on(pane, 'keydown', '[data-booking]', (e, r) => { if (e.key === 'Enter') bookingSheet(vid, r.dataset.booking, role, load); });
  await load();
}

// ---- Check-in (typed code or camera QR scan via BarcodeDetector where the browser supports it) ----------------------
async function checkinPane({ vid, venue, role, pane }) {
  mount(pane, html`<div class="grid-2" style="align-items:start">
    <div class="card"><h2>Check in a player</h2>
      <form id="cf" class="row nowrap"><label class="sr-only" for="code">Booking code</label><input id="code" placeholder="Booking code, e.g. TC7K3M9Q2X" autocomplete="off" style="text-transform:uppercase;font-family:ui-monospace,monospace" autofocus><button class="btn primary">Find</button></form>
      ${'BarcodeDetector' in window ? html`<button class="btn block" id="scan" style="margin-top:10px">${icon('camera')}Scan QR code</button>` : html`<p class="faint" style="margin-top:8px">QR scanning needs a browser with camera barcode support (Chrome on Android). Type the code instead.</p>`}
      <div class="scanner" id="scanner" hidden><video id="video" playsinline muted></video><button class="btn small" id="stop-scan" style="margin-top:8px">Stop scanning</button></div>
      <div id="found" class="section"></div></div>
    <div class="card"><h2>Arriving today</h2><div id="arrivals">${skeleton('line', 4)}</div></div></div>`);
  const show = b => mount($('#found', pane), html`<div class="notice ${b.checkedInAt ? 'good' : ['confirmed', 'completed'].includes(b.status) ? '' : 'bad'}">${icon(b.checkedInAt ? 'check' : 'info')}<div>
      <b>${who(b)}</b> · ${b.court.name} · ${fmtDate(b.date)} ${fmtRange(b.startTime, b.endTime)}<br>${statusTag(b.status)} ${b.checkedInAt ? `Checked in ${fmtDateTime(b.checkedInAt)}` : ''}
      ${b.date !== venue.today && ['confirmed'].includes(b.status) ? html`<div class="faint">Heads up: this booking is for ${dayLabel(b.date, venue.today)}, not today.</div>` : ''}
      ${['confirmed', 'completed'].includes(b.status) && !b.checkedInAt ? html`<div style="margin-top:8px"><button class="btn primary small" data-checkin="${b.id}">${icon('check')}Check in</button></div>` : ''}</div></div>`);
  const lookup = async code => { try { show(await api(`/owner/venues/${vid}/lookup`, { method: 'POST', body: { code } })); } catch (e) { mount($('#found', pane), html`<div class="notice bad">${icon('alert')}<div>${e.message}</div></div>`); } };
  const arrivals = async () => {
    const list = (await api(`/owner/venues/${vid}/bookings?from=${venue.today}&to=${venue.today}&status=confirmed`));
    mount($('#arrivals', pane), list.length ? html`<div class="list">${list.map(b => html`<div class="list-item"><div style="min-width:64px"><b>${fmtTime(b.startTime)}</b></div><div class="grow"><div class="title">${who(b)}</div><div class="faint">${b.court.name} · ${b.ref}</div></div>
      ${b.checkedInAt ? html`<span class="tag good">${icon('check')}In</span>` : html`<button class="btn small" data-checkin="${b.id}">Check in</button>`}</div>`)}</div>` : empty('users', 'No more arrivals today', ''));
  };
  $('#cf', pane).onsubmit = e => { e.preventDefault(); const c = $('#code', pane).value.trim(); if (c) lookup(c); };
  on(pane, 'click', '[data-checkin]', (_e, b) => busy(b, async () => { const r = await api(`/owner/venues/${vid}/bookings/${b.dataset.checkin}/check-in`, { method: 'POST' }); toast(`${who(r)} checked in`); show(r); arrivals(); }));
  let stream, scanning = false;
  const stopScan = () => { scanning = false; stream?.getTracks().forEach(t => t.stop()); stream = null; $('#scanner', pane) && ($('#scanner', pane).hidden = true); };
  $('#scan', pane)?.addEventListener('click', async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const video = $('#video', pane); video.srcObject = stream; await video.play(); $('#scanner', pane).hidden = false; scanning = true;
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const loop = async () => { if (!scanning) return; try { const [hit] = await detector.detect(video); if (hit) { stopScan(); $('#code', pane).value = hit.rawValue; return lookup(hit.rawValue); } } catch {} requestAnimationFrame(loop); };
      loop();
    } catch { toast('Could not open the camera. Type the code instead.', 'bad'); }
  });
  $('#stop-scan', pane).onclick = stopScan;
  onLeave(stopScan);
  void role;
  await arrivals();
}

// ---- Customers, reviews, messages ---------------------------------------------------------------------------------
async function customersPane({ vid, pane }) {
  mount(pane, html`<div class="search-box" style="max-width:420px;margin-bottom:12px">${icon('search')}<input type="search" id="cq" placeholder="Search name or phone" aria-label="Search customers"></div><div id="cl">${skeleton('line', 6)}</div>`);
  let t;
  const load = async (q = '') => {
    const list = await api(`/owner/venues/${vid}/customers?q=${encodeURIComponent(q)}`);
    mount($('#cl', pane), list.length ? html`<p class="faint">${plural(list.length, 'customer')} · ${list.filter(c => c.bookings > 1).length} repeat</p><div class="table-wrap"><table><thead><tr><th>Name</th><th>Phone</th><th class="num">Bookings</th><th class="num">Spend</th><th class="num">Cancels</th><th class="num">No-shows</th><th>First visit</th><th>Last visit</th></tr></thead><tbody>
      ${list.map(c => html`<tr><td>${c.name || '—'} ${c.bookings >= 5 ? html`<span class="tag good">Regular</span>` : ''}</td><td>${c.phone ? html`<a href="tel:${c.phone}">${c.phone}</a>` : '—'}</td><td class="num">${c.bookings}</td><td class="num">${money(c.spend)}</td>
        <td class="num">${c.cancellations}</td><td class="num">${c.no_shows}</td><td>${fmtDate(c.first_visit)}</td><td>${fmtDate(c.last_visit)}</td></tr>`)}</tbody></table></div>` : empty('users', 'No customers yet', 'People who book with you will appear here.'));
  };
  $('#cq', pane).oninput = e => { clearTimeout(t); t = setTimeout(() => load(e.target.value.trim()), 300); };
  await load();
}

async function reviewsPane(ctx) {
  const { vid, role, pane } = ctx;
  const list = await api(`/owner/venues/${vid}/reviews`);
  const avg = list.length ? (list.reduce((a, r) => a + r.rating, 0) / list.length).toFixed(1) : '—';
  mount(pane, html`<div class="kpis" style="margin-bottom:12px">${kpi('Average rating', avg)}${kpi('Reviews', list.length)}${kpi('Awaiting reply', list.filter(r => !r.owner_reply).length)}</div>
    ${list.length ? html`<div class="list">${list.map(r => html`<div class="card"><div class="row between"><b>${r.name}</b><span>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span></div>
      <div class="faint">${fmtDate(r.date)} · ${r.ref}${r.hidden ? ' · hidden by Thidal' : ''}</div>${r.comment ? html`<p style="margin:6px 0">${r.comment}</p>` : ''}
      ${r.owner_reply ? html`<div class="owner-reply"><b>Your reply</b><br>${r.owner_reply}</div>` : can(role, 'manager') ? html`<form class="row nowrap" data-reply="${r.id}" style="margin-top:8px"><label class="sr-only" for="rp-${r.id}">Reply</label><input id="rp-${r.id}" placeholder="Write a public reply…" required><button class="btn small">Reply</button></form>` : ''}</div>`)}</div>`
      : empty('star', 'No reviews yet', 'Players can review after their game.')}`);
  on(pane, 'submit', '[data-reply]', (e, f) => { e.preventDefault(); busy(e.submitter, async () => { await api(`/owner/venues/${vid}/reviews/${f.dataset.reply}/reply`, { method: 'POST', body: { reply: $('input', f).value } }); toast('Reply posted'); repaint(ctx, reviewsPane); }); });
}

async function supportPane({ vid, pane }) {
  mount(pane, html`<p class="muted">Questions from players about this venue. Disputes about charges go to Thidal support.</p>${ticketList(await api(`/support/tickets?view=venue&venue=${vid}`))}`);
}

// ---- Pricing, hours, closures ---------------------------------------------------------------------------------------
function weekdayPicker(name, value = '0123456') {
  return html`<div class="weekday-picker" role="group" aria-label="Days">${WEEKDAYS.map((d, i) => html`<label class="chip ${value.includes(String(i)) ? 'on' : ''}"><input type="checkbox" class="sr-only" name="${name}" value="${i}" ${value.includes(String(i)) ? 'checked' : ''}>${d}</label>`)}</div>`;
}
function wireWeekdays(root) { on(root, 'change', '.weekday-picker input', (_e, i) => i.closest('label').classList.toggle('on', i.checked)); }
const pickedDays = (form, name) => $$(`input[name=${name}]:checked`, form).map(i => i.value).join('');

async function pricingPane(ctx) {
  const { vid, pane } = ctx;
  const v = await api(`/owner/venues/${vid}`);
  const courtName = id => id ? v.courts.find(c => c.id === id)?.name || 'Court' : 'All courts';
  const times = slotTimes(v).concat(v.close_time);
  const timeOpts = (sel) => times.map(t => html`<option value="${t}" ${t === sel ? 'selected' : ''}>${fmtTime(t)}</option>`);
  mount(pane, html`
    <div class="card"><h2>Base prices</h2><p class="muted">The price per ${v.slot_minutes}-minute slot when no rule applies. Edit courts in Venue setup.</p>
      <div class="table-wrap"><table><thead><tr><th>Court</th><th>Sports</th><th class="num">Base price</th></tr></thead><tbody>${v.courts.map(c => html`<tr><td>${c.name}${c.active ? '' : ' (inactive)'}</td><td>${c.sports.map(sportLabel).join(', ')}</td><td class="num">${money(c.base_price)}</td></tr>`)}</tbody></table></div></div>
    <div class="card"><h2>Peak and off-peak pricing</h2><p class="muted">Rules set a different price by day and time. A court-specific rule beats an all-courts rule; one-off slot prices from the calendar beat both. Changes only affect new bookings.</p>
      ${v.priceRules.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Days</th><th>Time</th><th>Applies to</th><th class="num">Price</th><th></th></tr></thead><tbody>
        ${v.priceRules.map(r => html`<tr><td>${r.label || '—'}</td><td>${weekdaysLabel(r.weekdays)}</td><td>${fmtRange(r.start_time, r.end_time)}</td><td>${courtName(r.court_id)}</td><td class="num">${money(r.price)}</td>
          <td><button class="btn small ghost danger" data-del-rule="${r.id}" aria-label="Delete rule ${r.label}">${icon('trash')}</button></td></tr>`)}</tbody></table></div>` : html`<p class="faint">No rules yet — every slot uses the base price.</p>`}
      <form id="rule" class="section"><h3>Add a rule</h3>
        <div class="grid-2"><div class="field"><label for="r-label">Name</label><input id="r-label" name="label" placeholder="e.g. Evening peak" maxlength="40"></div>
          <div class="field"><label for="r-court">Applies to</label><select id="r-court" name="courtId"><option value="">All courts</option>${v.courts.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select></div>
          <div class="field"><label for="r-from">From</label><select id="r-from" name="startTime">${timeOpts('18:00')}</select></div>
          <div class="field"><label for="r-to">Until</label><select id="r-to" name="endTime">${timeOpts(v.close_time)}</select></div>
          <div class="field"><label for="r-price">Price per slot (₹)</label><input id="r-price" name="price" type="number" min="0" step="10" required inputmode="decimal"></div></div>
        <div class="field"><span class="label">Days</span>${weekdayPicker('rdays', '12345')}</div>
        <button class="btn primary">Add rule</button></form></div>
    <div class="card"><h2>Weekly closures</h2><p class="muted">Recurring times the venue is closed, e.g. turf maintenance or academy sessions. You can still open a single date from the calendar.</p>
      ${v.recurringBlocks.length ? html`<div class="table-wrap"><table><thead><tr><th>Reason</th><th>Days</th><th>Time</th><th>Courts</th><th></th></tr></thead><tbody>
        ${v.recurringBlocks.map(b => html`<tr><td>${b.reason || '—'}</td><td>${weekdaysLabel(b.weekdays)}</td><td>${fmtRange(b.start_time, b.end_time)}</td><td>${courtName(b.court_id)}</td>
          <td><button class="btn small ghost danger" data-del-block="${b.id}" aria-label="Delete closure">${icon('trash')}</button></td></tr>`)}</tbody></table></div>` : html`<p class="faint">No weekly closures.</p>`}
      <form id="block" class="section"><h3>Add a weekly closure</h3>
        <div class="grid-2"><div class="field"><label for="b-reason">Reason</label><input id="b-reason" name="reason" placeholder="e.g. Turf maintenance" maxlength="80"></div>
          <div class="field"><label for="b-court">Courts</label><select id="b-court" name="courtId"><option value="">All courts</option>${v.courts.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select></div>
          <div class="field"><label for="b-from">From</label><select id="b-from" name="startTime">${timeOpts(v.open_time)}</select></div>
          <div class="field"><label for="b-to">Until</label><select id="b-to" name="endTime">${timeOpts(times[2] || v.close_time)}</select></div></div>
        <div class="field"><span class="label">Days</span>${weekdayPicker('bdays', '1')}</div>
        <button class="btn primary">Add closure</button></form></div>`);
  wireWeekdays(pane);
  const submit = (sel, path, days) => $(sel, pane).onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => {
    const f = formData(e.target); f.weekdays = pickedDays(e.target, days);
    if (!f.weekdays) throw new Error('Pick at least one day');
    await api(`/owner/venues/${vid}/${path}`, { method: 'POST', body: { ...f, courtId: f.courtId || null } }); toast('Saved'); repaint(ctx, pricingPane);
  }); };
  submit('#rule', 'price-rules', 'rdays'); submit('#block', 'recurring-blocks', 'bdays');
  on(pane, 'click', '[data-del-rule]', async (_e, b) => { if (await confirmDialog('New bookings will use the remaining rules or base price.', { title: 'Delete this price rule?', confirmLabel: 'Delete', danger: true })) { await api(`/owner/venues/${vid}/price-rules/${b.dataset.delRule}`, { method: 'DELETE' }); repaint(ctx, pricingPane); } });
  on(pane, 'click', '[data-del-block]', async (_e, b) => { if (await confirmDialog('Those times become bookable again.', { title: 'Delete this closure?', confirmLabel: 'Delete', danger: true })) { await api(`/owner/venues/${vid}/recurring-blocks/${b.dataset.delBlock}`, { method: 'DELETE' }); repaint(ctx, pricingPane); } });
}

// ---- Coupons ------------------------------------------------------------------------------------------------------
async function couponsPane(ctx) {
  const { vid, pane } = ctx;
  const list = await api(`/owner/venues/${vid}/coupons`);
  mount(pane, html`<div class="row between"><p class="muted" style="margin:0">Codes customers enter at checkout for this venue.</p><button class="btn primary" id="new">${icon('plus')}New promo code</button></div>
    <div class="section">${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Code</th><th>Discount</th><th>Conditions</th><th class="num">Used</th><th>Valid until</th><th>Active</th></tr></thead><tbody>
      ${list.map(c => html`<tr><td><b>${c.code}</b><div class="faint">${c.description}</div></td><td>${c.kind === 'percent' ? `${c.value}%${c.max_discount ? ` (max ${money(c.max_discount)})` : ''}` : money(c.value)}</td>
        <td>${c.min_amount ? `Min ${money(c.min_amount)}` : 'Any amount'} · ${c.per_user_limit}/customer</td><td class="num">${c.redemptions}${c.max_uses ? ` / ${c.max_uses}` : ''}</td><td>${c.valid_until ? fmtDate(c.valid_until) : 'No end'}</td>
        <td><label class="check"><input type="checkbox" data-toggle="${c.id}" ${c.active ? 'checked' : ''}><span class="sr-only">Active</span></label></td></tr>`)}</tbody></table></div>`
      : empty('gift', 'No promo codes', 'Create a code to fill quiet hours or reward regulars.')}</div>`);
  on(pane, 'change', '[data-toggle]', async (_e, i) => { try { await api(`/owner/venues/${vid}/coupons/${i.dataset.toggle}`, { method: 'PATCH', body: { active: i.checked } }); toast(i.checked ? 'Code turned on' : 'Code turned off'); } catch (e) { toast(e.message, 'bad'); i.checked = !i.checked; } });
  $('#new', pane).onclick = () => sheet({
    title: 'New promo code',
    body: html`<form id="cf"><div class="grid-2">
      <div class="field"><label for="c-code">Code</label><input id="c-code" name="code" required maxlength="20" style="text-transform:uppercase" placeholder="MONSOON20"></div>
      <div class="field"><label for="c-kind">Type</label><select id="c-kind" name="kind"><option value="percent">Percentage off</option><option value="flat">Fixed amount off (₹)</option></select></div>
      <div class="field"><label for="c-val">Discount</label><input id="c-val" name="value" type="number" min="1" required inputmode="decimal"></div>
      <div class="field"><label for="c-max">Max discount (₹, optional)</label><input id="c-max" name="maxDiscount" type="number" min="0" inputmode="decimal"></div>
      <div class="field"><label for="c-min">Minimum spend (₹)</label><input id="c-min" name="minAmount" type="number" min="0" inputmode="decimal"></div>
      <div class="field"><label for="c-uses">Total uses (optional)</label><input id="c-uses" name="maxUses" type="number" min="1" inputmode="numeric"></div>
      <div class="field"><label for="c-per">Uses per customer</label><input id="c-per" name="perUserLimit" type="number" min="1" value="1" inputmode="numeric"></div>
      <div class="field"><label for="c-until">Valid until (optional)</label><input id="c-until" name="validUntil" type="date"></div></div>
      <div class="field"><label for="c-desc">Description shown to customers</label><input id="c-desc" name="description" maxlength="120"></div><p class="form-error" id="c-err" role="alert"></p></form>`,
    foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="c-go">Create</button>`,
    onMount: (el, close) => { $('#c-go', el).onclick = e => busy(e.currentTarget, async () => {
      try { await api(`/owner/venues/${vid}/coupons`, { method: 'POST', body: formData($('#cf', el)) }); close(); toast('Promo code created'); repaint(ctx, couponsPane); }
      catch (err) { $('#c-err', el).textContent = err.message; }
    }); },
  });
}

async function sessionsPane(ctx) {
  const { vid, venue, pane } = ctx;
  const [list, meta] = await Promise.all([api(`/owner/venues/${vid}/sessions`), state.meta ? state.meta : api('/meta').then(m => (state.meta = m))]);
  const upcoming = list.filter(s => s.endAt > Date.now());
  mount(pane, html`<div class="row between"><p class="muted" style="margin:0">Yoga, meditation, fitness and aqua classes, in person or online. Players book a seat and pay at checkout.</p>
    <button class="btn primary" id="new">${icon('plus')}New class</button></div>
    <div class="section">${upcoming.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Class</th><th>Format</th><th class="num">Seats</th><th class="num">Price</th><th>Status</th><th></th></tr></thead><tbody>
      ${upcoming.map(s => html`<tr><td>${fmtDate(s.date)}<div class="faint">${fmtRange(s.startTime, s.endTime)}</div></td><td><b>${s.title}</b><div class="faint">${titleCase(s.kind)}${s.trainer ? ' · ' + s.trainer : ''}</div></td>
        <td>${s.mode === 'online' ? 'Online' : 'In person'}</td><td class="num">${s.seatsTaken} / ${s.capacity}</td><td class="num">${s.price ? money(s.price) : 'Free'}</td>
        <td>${s.status === 'cancelled' ? html`<span class="tag bad">Cancelled</span>` : html`<span class="tag good">Scheduled</span>`}</td>
        <td class="nowrap"><button class="btn small" data-people="${s.id}">Attendees</button> ${s.status === 'scheduled' ? html`<button class="btn small danger" data-cancel="${s.id}">Cancel</button>` : ''}</td></tr>`)}</tbody></table></div>`
      : empty('bulb', 'No classes scheduled', 'Add your first class so players can book a seat.')}</div>`);
  on(pane, 'click', '[data-people]', async (_e, b) => {
    const s = list.find(x => x.id === b.dataset.people), people = await api(`/owner/venues/${vid}/sessions/${s.id}/attendees`);
    sheet({ title: s.title, body: people.length ? html`<div class="list">${people.map(p => html`<div class="list-item"><div class="grow"><div class="title">${p.name || 'Player'}</div><div class="faint">${p.ref} · ${p.phone || 'no phone'}</div></div>${statusTag(p.status)}</div>`)}</div>`
      : html`<p class="muted">No seats booked yet.</p>` });
  });
  on(pane, 'click', '[data-cancel]', async (_e, b) => {
    const s = list.find(x => x.id === b.dataset.cancel);
    const reason = await confirmDialog(`${plural(s.seatsTaken, 'booked seat')} will be cancelled and refunded in full, and players are notified.`, { title: 'Cancel this class?', confirmLabel: 'Cancel class', danger: true, input: { label: 'Reason (shown to players)', placeholder: 'e.g. Trainer unwell' } });
    if (reason === null) return;
    try { const r = await api(`/owner/venues/${vid}/sessions/${s.id}/cancel`, { method: 'POST', body: { reason } }); toast(`Class cancelled. ${plural(r.seatsRefunded, 'seat')} refunded.`); repaint(ctx, sessionsPane); }
    catch (e) { toast(e.message, 'bad'); }
  });
  $('#new', pane).onclick = () => sheet({
    title: 'New wellness class',
    body: html`<form id="sf"><div class="grid-2">
      <div class="field"><label for="s-title">Title</label><input id="s-title" name="title" required maxlength="80" placeholder="Morning vinyasa yoga"></div>
      <div class="field"><label for="s-kind">Type</label><select id="s-kind" name="kind">${meta.wellnessKinds.map(k => html`<option value="${k}">${titleCase(k)}</option>`)}</select></div>
      <div class="field"><label for="s-mode">Format</label><select id="s-mode" name="mode"><option value="in_person">In person at this venue</option><option value="online">Online (live)</option></select></div>
      <div class="field"><label for="s-trainer">Trainer</label><input id="s-trainer" name="trainer" maxlength="80"></div>
      <div class="field"><label for="s-date">Date</label><input id="s-date" name="date" type="date" required min="${venue.today}"></div>
      <div class="field"><label for="s-start">Starts</label><input id="s-start" name="startTime" type="time" required></div>
      <div class="field"><label for="s-end">Ends</label><input id="s-end" name="endTime" type="time" required></div>
      <div class="field"><label for="s-cap">Seats</label><input id="s-cap" name="capacity" type="number" min="1" max="500" value="12" required inputmode="numeric"></div>
      <div class="field"><label for="s-price">Price per seat (₹)</label><input id="s-price" name="price" type="number" min="0" value="300" required inputmode="decimal"></div></div>
      <div class="field" id="s-url-wrap" hidden><label for="s-url">Join link (https)</label><input id="s-url" name="joinUrl" type="url" placeholder="https://meet.google.com/..."><div class="hint">Only players who have paid can see this link.</div></div>
      <div class="field"><label for="s-desc">Description</label><textarea id="s-desc" name="description" maxlength="1000" placeholder="What to expect, what to bring"></textarea></div><p class="form-error" id="s-err" role="alert"></p></form>`,
    foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="s-go">Schedule</button>`,
    onMount: (el, close) => {
      $('#s-mode', el).onchange = e => { $('#s-url-wrap', el).hidden = e.target.value !== 'online'; };
      $('#s-go', el).onclick = e => busy(e.currentTarget, async () => {
        try { await api(`/owner/venues/${vid}/sessions`, { method: 'POST', body: formData($('#sf', el)) }); close(); toast('Class scheduled'); repaint(ctx, sessionsPane); }
        catch (err) { $('#s-err', el).textContent = err.message; }
      });
    },
  });
}

// ---- Vending machines -----------------------------------------------------------------------------------------------
// ---- Shop and rentals: hand over with the player's code, take returns (refunding the deposit), manage the catalogue ---------
const STORE_CATS = ['accessories', 'equipment', 'clothing', 'footwear', 'books', 'nutrition'];
async function storePane(ctx) {
  const { vid, role, pane } = ctx;
  const { items, orders, summary } = await api(`/owner/venues/${vid}/store`);
  const manager = can(role, 'manager'), base = `/owner/venues/${vid}/store`;
  const paid = orders.filter(o => o.status === 'paid'), out = orders.filter(o => o.status === 'out'), done = orders.filter(o => !['paid', 'out'].includes(o.status)).slice(0, 15);
  const line = o => o.items.map(i => `${i.qty}× ${i.name}${i.size ? ` (${i.size})` : ''}`).join(', ');
  const overdue = out.filter(o => o.overdue).length;
  mount(pane, html`
    <div class="kpis">${kpi('To collect', summary.toCollect, 'Paid, waiting at the desk')}${kpi('Hired out now', summary.out, overdue ? `${overdue} overdue` : 'All on time')}
      ${manager ? kpi('Shop sales (30 days)', money(summary.sales)) : ''}${manager ? kpi('Rental income (30 days)', money(summary.rentals), 'Deposits not included') : ''}</div>
    <form class="card section row" id="hand"><label for="hcode" style="margin:0">Pickup code</label><input id="hcode" inputmode="numeric" autocomplete="off" placeholder="6-digit code or order ref" style="flex:1;min-width:180px;font-family:var(--f-mono)"><button class="btn primary">Hand over</button></form>
    <h2 class="section">Waiting to collect</h2>
    ${paid.length ? html`<div class="list">${paid.map(o => html`<div class="list-item"><span class="p-art small" aria-hidden="true">${o.items[0]?.emoji || '🛍️'}</span>
      <div class="grow"><div class="title">${line(o)}</div><div class="faint">${o.customer?.name || 'Player'} · ${o.kind === 'rental' ? `Hire for ${fmtDate(o.startDate)}${o.endDate !== o.startDate ? ' – ' + fmtDate(o.endDate) : ''}` : 'Purchase'} · ${o.ref}</div></div>
      <span class="tag good mono">${o.pickupCode}</span>${manager ? html`<button class="btn small ghost" data-refund="${o.id}">Refund</button>` : ''}</div>`)}</div>` : html`<p class="faint">Nothing waiting.</p>`}
    <h2 class="section">Hired out</h2>
    ${out.length ? html`<div class="list">${out.map(o => html`<div class="list-item"><span class="p-art small" aria-hidden="true">${o.items[0]?.emoji || '🎒'}</span>
      <div class="grow"><div class="title">${line(o)}</div><div class="faint">${o.customer?.name || 'Player'}${o.customer?.phone ? html` · <a href="tel:${o.customer.phone}">${o.customer.phone}</a>` : ''} · due back ${fmtDate(o.endDate)} · deposit ${money(o.deposit)}</div></div>
      ${o.overdue ? html`<span class="tag bad">Overdue</span>` : ''}<button class="btn small primary" data-return="${o.id}" data-deposit="${o.deposit}">Returned</button></div>`)}</div>` : html`<p class="faint">Nothing out right now.</p>`}
    ${done.length ? html`<details class="section"><summary style="cursor:pointer;font-weight:700">Recent orders</summary><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>When</th><th>Ref</th><th>Player</th><th>Items</th><th class="num">Paid</th><th>Status</th></tr></thead><tbody>
      ${done.map(o => html`<tr><td>${fmtDateTime(o.paidAt || o.createdAt)}</td><td>${o.ref}</td><td>${o.customer?.name || ''}</td><td style="white-space:normal">${line(o)}</td><td class="num">${money(o.amount)}</td><td>${titleCase(o.status)}${o.depositKept ? ` · kept ${money(o.depositKept)}` : ''}</td></tr>`)}</tbody></table></div></details>` : ''}
    <div class="row between section"><h2 style="margin:0">Catalogue</h2>${manager ? html`<button class="btn small" id="add-item">${icon('plus')}Add item</button>` : ''}</div>
    <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Item</th><th>Category</th><th class="num">Sale price</th><th class="num">In stock</th><th class="num">Hire</th><th class="num">Units</th><th></th></tr></thead><tbody>
      ${items.map(i => html`<tr ${i.active ? '' : raw('style="opacity:.55"')}><td>${i.emoji} ${i.name}${i.sizes.length ? html`<div class="faint">Sizes ${i.sizes.join(', ')}</div>` : ''}</td><td>${titleCase(i.category)}</td>
        <td class="num">${i.forSale ? money(i.salePrice) : '—'}</td><td class="num">${i.forSale ? i.stock : '—'}</td><td class="num">${i.forRent ? `${money(i.rentPrice)}/${i.rentUnit}` : '—'}</td><td class="num">${i.forRent ? i.rentStock : '—'}</td>
        <td>${manager ? html`<button class="btn small ghost" data-edit="${i.id}">Edit</button>` : ''}</td></tr>`)}</tbody></table></div>`);

  $('#hand', pane).onsubmit = e => {
    e.preventDefault();
    const code = $('#hcode', pane).value.trim();
    if (!code) return;
    busy(e.submitter, async () => {
      try { const o = await api(`${base}/handover`, { method: 'POST', body: { code } }); toast(`${o.kind === 'rental' ? 'Handed out' : 'Collected'}: ${o.items.map(i => i.name).join(', ')}`); repaint(ctx, storePane); }
      catch (err) { toast(err.message, 'bad'); }
    });
  };
  on(pane, 'click', '[data-return]', (_e, b) => sheet({
    title: 'Mark as returned',
    body: html`<p class="muted">The ${money(Number(b.dataset.deposit))} deposit goes back to the player. Keep part of it only for damage or missing items.</p>
      <div class="field"><label for="keep">Keep from deposit (₹)</label><input id="keep" type="number" min="0" max="${Number(b.dataset.deposit) / 100}" step="1" value="0" inputmode="decimal"></div>
      <div class="field"><label for="rnote">Reason (shown to the player if you keep any)</label><input id="rnote" maxlength="200"></div><p class="form-error" id="rerr" role="alert"></p>`,
    foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="rgo">Confirm return</button>`,
    onMount: (el, close) => {
      $('#rgo', el).onclick = ev => busy(ev.currentTarget, async () => {
        try { await api(`${base}/orders/${b.dataset.return}/return`, { method: 'POST', body: { keep: $('#keep', el).value, note: $('#rnote', el).value } }); close(); toast('Returned. Deposit refund sent.'); repaint(ctx, storePane); }
        catch (err) { $('#rerr', el).textContent = err.message; }
      });
    },
  }));
  on(pane, 'click', '[data-refund]', async (_e, b) => {
    const reason = await confirmDialog('The player gets a full refund and the items go back on sale.', { title: 'Refund this order?', confirmLabel: 'Refund', danger: true, input: { label: 'Reason (sent to the player)', required: true } });
    if (!reason) return;
    try { await api(`${base}/orders/${b.dataset.refund}/refund`, { method: 'POST', body: { reason } }); toast('Refunded'); repaint(ctx, storePane); } catch (e) { toast(e.message, 'bad'); }
  });
  const itemSheet = it => sheet({
    title: it ? `Edit ${it.name}` : 'Add an item',
    body: html`<form id="sf"><div class="grid-2">
      <div class="field"><label for="s-name">Name</label><input id="s-name" name="name" value="${it?.name || ''}" required></div>
      <div class="field"><label for="s-cat">Category</label><select id="s-cat" name="category">${STORE_CATS.map(c => html`<option value="${c}" ${it?.category === c ? raw('selected') : ''}>${titleCase(c)}</option>`)}</select></div>
      <div class="field"><label for="s-emoji">Icon (emoji)</label><input id="s-emoji" name="emoji" value="${it?.emoji || ''}" maxlength="8"></div>
      <div class="field"><label for="s-sizes">Sizes (comma separated)</label><input id="s-sizes" name="sizes" value="${it ? it.sizes.join(', ') : ''}" placeholder="S, M, L or 7, 8, 9"></div>
      <div class="field"><label for="s-sale">Sale price (₹, blank if not for sale)</label><input id="s-sale" name="salePrice" type="number" min="0" value="${it?.forSale ? it.salePrice / 100 : ''}" inputmode="decimal"></div>
      <div class="field"><label for="s-stock">In stock</label><input id="s-stock" name="stock" type="number" min="0" value="${it?.stock ?? 0}" inputmode="numeric"></div>
      <div class="field"><label for="s-rent">Hire price (₹, blank if not for hire)</label><input id="s-rent" name="rentPrice" type="number" min="0" value="${it?.forRent ? it.rentPrice / 100 : ''}" inputmode="decimal"></div>
      <div class="field"><label for="s-unit">Hire per</label><select id="s-unit" name="rentUnit"><option value="game" ${it?.rentUnit !== 'day' ? raw('selected') : ''}>Game (same day)</option><option value="day" ${it?.rentUnit === 'day' ? raw('selected') : ''}>Day (take home)</option></select></div>
      <div class="field"><label for="s-dep">Deposit (₹)</label><input id="s-dep" name="deposit" type="number" min="0" value="${it ? it.deposit / 100 : 0}" inputmode="decimal"></div>
      <div class="field"><label for="s-units">Units for hire</label><input id="s-units" name="rentStock" type="number" min="0" value="${it?.rentStock ?? 0}" inputmode="numeric"></div></div>
      <div class="field"><label for="s-desc">Description</label><input id="s-desc" name="description" value="${it?.description || ''}" maxlength="300"></div>
      ${it ? html`<label class="check"><input type="checkbox" name="active" ${it.active ? raw('checked') : ''}>Show in the app</label>` : ''}<p class="form-error" id="s-err" role="alert"></p></form>`,
    foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="s-go">Save</button>`,
    onMount: (el, close) => {
      $('#s-go', el).onclick = ev => busy(ev.currentTarget, async () => {
        const f = formData($('#sf', el));
        if (it) f.active = !!f.active;
        try { await api(it ? `${base}/items/${it.id}` : `${base}/items`, { method: it ? 'PATCH' : 'POST', body: f }); close(); toast('Saved'); repaint(ctx, storePane); }
        catch (err) { $('#s-err', el).textContent = err.message; }
      });
    },
  });
  $('#add-item', pane)?.addEventListener('click', () => itemSheet(null));
  on(pane, 'click', '[data-edit]', (_e, b) => itemSheet(items.find(i => i.id === b.dataset.edit)));
}

async function vendingPane(ctx) {
  const { vid, pane } = ctx;
  const { machines, orders, summary } = await api(`/owner/venues/${vid}/vending`);
  const attention = machines.filter(m => m.active && (m.status !== 'online' || m.lowStock || m.soldOut)).length;
  const ago = t => !t ? 'never' : Date.now() - t < 90000 ? 'just now' : `${Math.round((Date.now() - t) / 60000)} min ago`;
  const bar = i => html`<div class="stockbar ${i.stock <= i.lowAt ? 'low' : ''}" role="img" aria-label="${i.stock} of ${i.capacity} in stock"><i style="width:${Math.min(100, Math.round(i.stock / i.capacity * 100))}%"></i></div>`;
  mount(pane, html`
    <div class="row between"><p class="muted" style="margin:0">Snack and coffee machines at this venue: live status, stock, faults and sales.</p><button class="btn primary" id="add">${icon('plus')}Add machine</button></div>
    <div class="kpis section">${kpi('Machines working', `${machines.filter(m => m.status === 'online').length} / ${machines.length}`, attention ? `${attention} need attention` : 'All good')}
      ${kpi('Orders (7 days)', summary.orders)}${kpi('Sales (7 days)', money(summary.revenue))}${kpi('Top seller', summary.top[0]?.name || '—', summary.top[0] ? `${summary.top[0].qty} sold` : '')}</div>
    ${machines.length ? machines.map(m => html`<section class="card machine-admin ${m.status}" data-machine="${m.id}">
      <div class="row between"><div class="row"><span class="machine-ico" aria-hidden="true">${MACHINE_ICON[m.kind]}</span><div><h3 style="margin:0">${m.name}</h3><div class="faint">${m.location || 'No location set'} · seen ${ago(m.lastSeenAt)}${m.temperature != null ? ` · ${m.temperature}°C` : ''}${m.doorOpen ? ' · door open' : ''}</div></div></div>
        <div class="row">${m.active ? statusPill(m.status) : html`<span class="tag">Paused</span>`}</div></div>
      ${m.faults.length ? html`<div class="stack" style="margin-top:10px">${m.faults.map(f => html`<div class="notice ${f.severity === 'critical' ? 'bad' : 'warn'}">${icon('alert')}<div class="grow"><b>${f.code}</b> ${f.message || ''}<div class="faint">Since ${fmtDateTime(new Date(f.opened_at).toISOString())}</div></div><button class="btn small" data-resolve="${m.id}:${f.id}">Mark fixed</button></div>`)}</div>` : ''}
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Slot</th><th>Item</th><th class="num">Price</th><th>Stock</th><th></th></tr></thead><tbody>
        ${m.items.map(i => html`<tr><td>${i.slot}</td><td>${i.name}${i.stock <= i.lowAt ? html` <span class="tag ${i.stock === 0 ? 'bad' : 'warn'}">${i.stock === 0 ? 'Sold out' : 'Low'}</span>` : ''}</td><td class="num">${money(i.price)}</td>
          <td style="min-width:140px">${i.stock} / ${i.capacity}${bar(i)}</td><td><button class="btn small" data-edit="${m.id}:${i.id}">Edit / restock</button></td></tr>`)}</tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="btn small" data-item="${m.id}">${icon('plus')}Add item</button><button class="btn small" data-pause="${m.id}">${m.active ? 'Pause machine' : 'Resume machine'}</button>
        <button class="btn small ghost" data-key="${m.id}">${icon('shield')}New API key</button></div></section>`) : empty('bulb', 'No machines yet', 'Add a machine to get its API key, then point the machine controller at it.')}
    <h2 class="section">Recent orders</h2>
    ${orders.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Order</th><th>Machine</th><th>Items</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>
      ${orders.map(o => html`<tr><td>${fmtDateTime(o.createdAt)}</td><td>${o.ref}<div class="faint">${o.customer}</div></td><td>${o.machine.name}</td><td>${o.items.map(i => `${i.qty}× ${i.name}`).join(', ')}</td><td class="num">${money(o.amount)}</td>
        <td><span class="tag ${{ dispensed: 'good', paid: 'info', refunded: 'warn' }[o.status] || ''}">${titleCase(o.status)}</span></td>
        <td>${o.status === 'paid' ? html`<button class="btn small danger" data-refund="${o.id}">Refund</button>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">No orders yet.</p>`}`);

  const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); repaint(ctx, vendingPane); } catch (e) { toast(e.message, 'bad'); } };
  const base = `/owner/venues/${vid}/vending`;
  on(pane, 'click', '[data-resolve]', (_e, b) => { const [mid, fid] = b.dataset.resolve.split(':'); act(() => api(`${base}/machines/${mid}/faults/${fid}/resolve`, { method: 'POST' }), 'Marked as fixed'); });
  on(pane, 'click', '[data-pause]', (_e, b) => { const m = machines.find(x => x.id === b.dataset.pause); act(() => api(`${base}/machines/${m.id}`, { method: 'PATCH', body: { active: !m.active } }), m.active ? 'Machine paused' : 'Machine resumed'); });
  on(pane, 'click', '[data-refund]', async (_e, b) => {
    const reason = await confirmDialog('The player is refunded in full and their pickup code stops working.', { title: 'Refund this order?', confirmLabel: 'Refund', danger: true, input: { label: 'Reason (optional)', placeholder: 'e.g. Machine jammed' } });
    if (reason !== null) act(() => api(`${base}/orders/${b.dataset.refund}/refund`, { method: 'POST', body: { reason } }), 'Order refunded');
  });
  on(pane, 'click', '[data-key]', async (_e, b) => {
    if (!(await confirmDialog('The old key stops working immediately. Update the machine controller with the new one.', { title: 'Create a new API key?', confirmLabel: 'Create key' }))) return;
    try { const r = await api(`${base}/machines/${b.dataset.key}/key`, { method: 'POST' }); keySheet(r.key, b.dataset.key); } catch (e) { toast(e.message, 'bad'); }
  });
  function keySheet(key, mid) {
    sheet({ title: 'Machine API key', body: html`<div class="notice warn">${icon('info')}<div>Copy this now. It is shown only once and cannot be recovered.</div></div>
      <p><code class="keybox">${key}</code></p><p class="muted">The machine controller sends it in the <code>x-machine-key</code> header:</p>
      <pre class="keybox" style="white-space:pre-wrap">POST /api/device/vending/${mid}/heartbeat
{ "temperature": 4.1, "stock": { "A1": 12 }, "faults": [] }

POST /api/device/vending/${mid}/dispense
{ "code": "123456" }</pre>`, foot: html`<button class="btn primary" data-close>Done</button>` });
  }
  const itemForm = (i = {}) => html`<form id="if"><div class="grid-2">
    <div class="field"><label for="i-slot">Slot</label><input id="i-slot" name="slot" required maxlength="8" value="${i.slot || ''}" style="text-transform:uppercase"></div>
    <div class="field"><label for="i-name">Name</label><input id="i-name" name="name" required maxlength="60" value="${i.name || ''}"></div>
    <div class="field"><label for="i-cat">Category</label><select id="i-cat" name="category">${[['snack', 'Snack'], ['coffee', 'Hot drink'], ['drink', 'Cold drink']].map(([v, l]) => html`<option value="${v}" ${i.category === v ? 'selected' : ''}>${l}</option>`)}</select></div>
    <div class="field"><label for="i-price">Price (₹)</label><input id="i-price" name="price" type="number" min="0" step="0.5" required value="${i.price != null ? i.price / 100 : ''}"></div>
    <div class="field"><label for="i-stock">In stock now</label><input id="i-stock" name="stock" type="number" min="0" required value="${i.stock ?? 0}"></div>
    <div class="field"><label for="i-cap">Capacity</label><input id="i-cap" name="capacity" type="number" min="1" required value="${i.capacity ?? 10}"></div>
    <div class="field"><label for="i-low">Low-stock alert at</label><input id="i-low" name="lowAt" type="number" min="0" required value="${i.lowAt ?? 3}"></div></div><p class="form-error" id="i-err" role="alert"></p></form>`;
  on(pane, 'click', '[data-item]', (_e, b) => sheet({ title: 'Add item', body: itemForm(), foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="i-go">Add</button>`,
    onMount: (el, close) => { $('#i-go', el).onclick = e => busy(e.currentTarget, async () => { try { await api(`${base}/machines/${b.dataset.item}/items`, { method: 'POST', body: formData($('#if', el)) }); close(); toast('Item added'); repaint(ctx, vendingPane); } catch (err) { $('#i-err', el).textContent = err.message; } }); } }));
  on(pane, 'click', '[data-edit]', (_e, b) => {
    const [mid, iid] = b.dataset.edit.split(':'), item = machines.find(m => m.id === mid).items.find(i => i.id === iid);
    sheet({ title: `Edit ${item.name}`, body: itemForm(item), foot: html`<button class="btn danger" id="i-off">Remove from menu</button><span style="flex:1"></span><button class="btn primary" id="i-go">Save</button>`,
      onMount: (el, close) => {
        $('#i-go', el).onclick = e => busy(e.currentTarget, async () => { try { await api(`${base}/machines/${mid}/items/${iid}`, { method: 'PATCH', body: formData($('#if', el)) }); close(); toast('Saved'); repaint(ctx, vendingPane); } catch (err) { $('#i-err', el).textContent = err.message; } });
        $('#i-off', el).onclick = e => busy(e.currentTarget, async () => { await api(`${base}/machines/${mid}/items/${iid}`, { method: 'PATCH', body: { active: false } }); close(); toast('Removed from the menu'); repaint(ctx, vendingPane); });
      } });
  });
  $('#add', pane).onclick = () => sheet({
    title: 'Add a machine',
    body: html`<form id="mf"><div class="field"><label for="m-name">Name</label><input id="m-name" name="name" required maxlength="60" placeholder="Lobby coffee machine"></div>
      <div class="field"><label for="m-kind">Type</label><select id="m-kind" name="kind"><option value="combo">Snacks and drinks</option><option value="snacks">Snacks</option><option value="coffee">Coffee and hot drinks</option></select></div>
      <div class="field"><label for="m-loc">Where is it?</label><input id="m-loc" name="location" maxlength="100" placeholder="Near the main entrance"></div><p class="form-error" id="m-err" role="alert"></p></form>`,
    foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="m-go">Create</button>`,
    onMount: (el, close) => { $('#m-go', el).onclick = e => busy(e.currentTarget, async () => {
      try { const r = await api(`${base}/machines`, { method: 'POST', body: formData($('#mf', el)) }); close(); keySheet(r.key, r.machine.id); repaint(ctx, vendingPane); }
      catch (err) { $('#m-err', el).textContent = err.message; }
    }); },
  });
}

// ---- Access control and surveillance --------------------------------------------------------------------------------
const ALERT_ICON = { critical: 'bad', warning: 'warn', info: '' };
const REASON = { unknown: 'Unknown code', cancelled: 'Cancelled booking', not_paid: 'Not paid', too_early: 'Too early', ended: 'Slot ended', online_only: 'Online class', full: 'Over limit' };
const ALERT_LABEL = { overstay: 'Overstays', no_show: 'No-shows', denied_burst: 'Refused-entry bursts', headcount: 'Head-count mismatches', unknown_person: 'Unknown person', tamper: 'Camera tampering', device_offline: 'Device offline' };
const clock = at => new Date(at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
// Collapse runs of identical events (a team walking through one gate) into one line with a count.
const groupEvents = list => list.reduce((out, e) => { const last = out.at(-1); const key = t => t.replace(/^[^:]+: /, ''); if (last && key(last.text) === key(e.text) && last.type === e.type && last.at - e.at < 180000) last.n++; else out.push({ ...e, n: 1 }); return out; }, []);
const devStatus = s => html`<span class="tag ${s === 'online' ? 'good' : 'warn'}">${s === 'online' ? 'Online' : 'Offline'}</span>`;

// The add-camera form offers "this computer's webcam"; that is stored as source=webcam with no stream link.
const deviceBody = (form, cam) => { const b = formData(form); if (cam && b.viewMode === 'webcam') { b.source = 'webcam'; b.viewMode = 'link'; b.streamUrl = ''; } return b; };

// Test camera: this computer's webcam shown in the browser. Simple motion detection reports events like a real camera would
// (through the demo simulator, so it needs demo mode). The picture itself never leaves the browser.
async function startWebcam(el, cam, base, stops) {
  const video = $('video', el), note = $('.webcam-note', el);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 } }, audio: false }); }
  catch (e) { note.hidden = false; note.textContent = e.name === 'NotAllowedError' ? 'The browser blocked the camera. Click the camera icon in the address bar, allow it, then reload this page.' : 'No webcam was found on this computer.'; return; }
  video.srcObject = stream; stops.push(() => stream.getTracks().forEach(t => t.stop()));
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  let prev = null, lastMotion = 0, moving = false;
  const send = body => api(`${base}/simulate`, { method: 'POST', body: { type: 'camera', deviceId: cam.id, ...body } }).catch(() => {});
  send({ kind: 'people_count', people: 0 });
  const tick = setInterval(() => {
    if (video.readyState < 2) return;
    g.drawImage(video, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let diff = 0;
    if (prev) for (let i = 0; i < d.length; i += 4) diff += Math.abs(d[i + 1] - prev[i + 1]);
    prev = new Uint8ClampedArray(d);
    moving = diff / (64 * 36) > 9;
    el.classList.toggle('moving', moving);
    if (moving && Date.now() - lastMotion > 20000) { lastMotion = Date.now(); send({ kind: 'motion', note: 'Webcam motion' }); }
  }, 400);
  const keepAlive = setInterval(() => send({ kind: 'people_count', people: moving ? 1 : 0 }), 60000);   // also keeps the camera "online"
  stops.push(() => { clearInterval(tick); clearInterval(keepAlive); });
}

async function accessPane(ctx) {
  const { vid, role, pane } = ctx, isManager = can(role, 'manager'), base = `/owner/venues/${vid}/access`;
  let view = 'live', data = await api(base), timer;
  const refresh = async () => { try { data = await api(base); if (view === 'live') drawLive(); } catch {} };
  timer = setInterval(() => { if (!document.hidden && view === 'live' && !document.querySelector('dialog[open]') && !body()?.querySelector('details[open]')) refresh(); }, 8000);
  onLeave(() => clearInterval(timer));

  const shell = () => mount(pane, html`<div class="row between"><div class="seg" role="group" aria-label="Section">
      <button type="button" data-view="live" aria-pressed="${view === 'live'}">Live</button>
      ${isManager ? html`<button type="button" data-view="report" aria-pressed="${view === 'report'}">Analysis</button><button type="button" data-view="devices" aria-pressed="${view === 'devices'}">Devices</button>` : ''}</div>
      <span class="faint">Gates scan booking QR codes; cameras report events and head counts.</span></div><div id="body" class="section"></div>`);
  const body = () => $('#body', pane);

  function drawLive() {
    const simOpen = !!body()?.querySelector('details[open]');
    const open = data.alerts, gOn = data.points.filter(p => p.status === 'online').length, cOn = data.cameras.filter(c => c.status === 'online').length;
    mount(body(), html`
      <div class="kpis">${kpi('Inside now', data.insideTotal, `${plural(data.inside.length, 'booking')}`)}${kpi('Open alerts', open.length, open.length ? 'Needs attention' : 'All clear')}
        ${kpi('Gates online', `${gOn} / ${data.points.length}`)}${kpi('Cameras online', `${cOn} / ${data.cameras.length}`)}</div>
      ${open.length ? html`<h2 class="section">Alerts</h2><div class="stack">${open.map(a => html`<div class="notice ${ALERT_ICON[a.severity]}">${icon('alert')}<div class="grow"><b>${ALERT_LABEL[a.kind] || a.kind}</b> · ${clock(a.created_at)}<div>${a.message}</div></div><button class="btn small" data-ack="${a.id}">Acknowledge</button></div>`)}</div>` : ''}
      <h2 class="section">Inside now</h2>
      ${data.inside.length ? html`<div class="table-wrap"><table><thead><tr><th>Booking</th><th>Court</th><th>Slot</th><th class="num">People inside</th><th></th></tr></thead><tbody>
        ${data.inside.map(b => html`<tr><td><b>${b.name || 'Player'}</b><div class="faint">${b.ref}</div></td><td>${b.court}</td><td>${fmtTime(b.startTime)} – ${fmtTime(b.endTime)}</td><td class="num"><b>${b.inside}</b></td><td>${b.overdue ? html`<span class="tag warn">Past end time</span>` : html`<span class="tag good">In slot</span>`}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted">Nobody is inside right now.</p>`}
      <div class="grid-2 section"><div><h2>Cameras</h2>${data.cameras.length ? html`<div class="list">${data.cameras.map(c => html`<div class="list-item"><span class="machine-ico" aria-hidden="true">📷</span><div class="grow"><div class="title">${c.name}</div>
          <div class="faint">${c.location || 'No location'}${c.people != null ? ` · ${plural(c.people, 'person', 'people')} in view` : ''}</div></div>${devStatus(c.status)}
          ${c.streamUrl ? html`<a class="btn small" href="${c.streamUrl}" target="_blank" rel="noopener noreferrer">${icon('ext')}Live view</a>` : ''}</div>`)}</div>` : html`<p class="muted">No cameras registered yet.</p>`}</div>
        <div><h2>Gates</h2>${data.points.length ? html`<div class="list">${data.points.map(p => html`<div class="list-item"><span class="machine-ico" aria-hidden="true">🚪</span><div class="grow"><div class="title">${p.name}</div><div class="faint">${titleCase(p.kind)}${p.location ? ' · ' + p.location : ''}</div></div>${p.active ? devStatus(p.status) : html`<span class="tag">Off</span>`}</div>`)}</div>` : html`<p class="muted">No gates registered yet.</p>`}</div></div>
      <h2 class="section">Recent activity</h2>
      ${data.events.length ? html`<div class="timeline">${groupEvents(data.events).slice(0, 14).map(e => html`<div class="tl ${e.ok ? '' : 'bad'}"><time>${clock(e.at)}</time><span>${icon(e.type === 'gate' ? 'qr' : 'camera')}${e.text}${e.n > 1 ? html` <b class="tag">×${e.n}</b>` : ''}</span></div>`)}</div>` : html`<p class="muted">No activity yet.</p>`}
      ${isManager && data.points.length + data.cameras.length ? html`<details class="card section" ${simOpen ? raw('open') : ''}><summary><b>Try it without hardware</b> <span class="faint">(demo mode)</span></summary>
        <p class="faint">Sends exactly what a real gate or camera would. Use a booking reference from the Bookings tab; entry opens 15 minutes before the slot.</p>
        <form id="sim" class="row" style="align-items:flex-end"><div class="field" style="margin:0"><label for="sim-gate">Gate</label><select id="sim-gate">${data.points.map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
          <div class="field" style="margin:0"><label for="sim-ref">Booking reference</label><input id="sim-ref" placeholder="TCXXXXXXXX" autocomplete="off" style="text-transform:uppercase"></div>
          <button class="btn primary" type="submit" data-dir="in">Scan in</button><button class="btn" type="submit" data-dir="out">Scan out</button></form>
        ${data.cameras.length ? html`<form id="simc" class="row" style="align-items:flex-end;margin-top:12px"><div class="field" style="margin:0"><label for="simc-cam">Camera</label><select id="simc-cam">${data.cameras.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select></div>
          <div class="field" style="margin:0"><label for="simc-kind">Event</label><select id="simc-kind"><option value="people_count">People count</option><option value="unknown_person">Unknown person</option><option value="motion">Motion</option><option value="tamper">Tampering</option></select></div>
          <div class="field" style="margin:0"><label for="simc-n">People</label><input id="simc-n" type="number" min="0" value="10" style="width:90px"></div><button class="btn" type="submit">Send event</button></form>` : ''}</details>` : ''}`);
  }

  async function drawReport(days = 7) {
    mount(body(), skeleton('card', 2));
    const r = await api(`${base}/report?days=${days}`), maxHeat = Math.max(1, ...r.heat.flat()), maxCam = Math.max(1, ...r.camera.peakByHour);
    mount(body(), html`
      <div class="row between"><h2 style="margin:0">Last ${days} days</h2><select id="days" aria-label="Period" style="width:auto">${[7, 14, 30].map(d => html`<option value="${d}" ${d === days ? 'selected' : ''}>${d} days</option>`)}</select></div>
      <div class="kpis section">${kpi('Entries', r.entries, `${r.exits} exits`)}${kpi('Attendance', r.attendanceRate == null ? '—' : r.attendanceRate + '%', `${r.attended} of ${r.bookingsFinished} paid bookings`)}
        ${kpi('Time on site', r.avgDwellPercent == null ? '—' : r.avgDwellPercent + '%', 'of the booked time')}${kpi('Peak on site', r.peakOccupancy, 'people at once')}
        ${kpi('Overstays', r.overstays)}${kpi('No-shows', r.noShows)}${kpi('Refused entries', r.denied)}${kpi('Camera events', Object.values(r.camera.byKind).reduce((a, b) => a + b, 0))}</div>
      <div class="card section"><h2>When people arrive</h2><p class="faint">Entries by weekday and hour. Darker means busier, useful for staffing the gate and planning cleaning between peaks.</p>
        <div style="overflow-x:auto"><div class="heat" role="table" aria-label="Entries by weekday and hour"><span></span>${Array.from({ length: 24 }, (_, h) => html`<span style="text-align:center">${h % 3 === 0 ? h : ''}</span>`)}
          ${WEEKDAYS.map((d, wd) => html`<span role="rowheader">${d}</span>${r.heat[wd].map((n, h) => html`<span class="c" role="cell" data-l="${n ? Math.min(5, Math.ceil(n / maxHeat * 5)) : 0}" title="${d} ${h}:00 — ${plural(n, 'entry', 'entries')}"></span>`)}`)}</div></div>
        <div class="heat-legend">Fewer ${[0, 1, 2, 3, 4, 5].map(l => html`<i style="background:var(--seq-${l})"></i>`)} More</div></div>
      <div class="card"><h2>Busiest moment each day</h2>${r.dailyPeak.length ? barChart(r.dailyPeak.map(d => ({ label: fmtDate(d.date), short: d.date.slice(8), value: d.peak })), { format: v => `${Math.round(v)} people`, label: 'Peak people on site per day' }) : html`<p class="muted">No gate data in this period.</p>`}</div>
      <div class="grid-2"><div class="card"><h2>Refused entries</h2>${r.deniedReasons.length ? html`<div class="list">${r.deniedReasons.map(d => html`<div class="row between"><span>${REASON[d.reason] || d.label}</span><b>${d.n}</b></div>`)}</div>` : html`<p class="muted">None. Everyone who scanned was let in.</p>`}</div>
        <div class="card"><h2>Alerts raised</h2>${Object.keys(r.alertsByKind).length ? html`<div class="list">${Object.entries(r.alertsByKind).map(([k, n]) => html`<div class="row between"><span>${ALERT_LABEL[k] || k}</span><b>${n}</b></div>`)}</div>` : html`<p class="muted">No alerts in this period.</p>`}</div></div>
      <div class="card"><h2>Most people seen by cameras, by hour</h2>${r.camera.peakByHour.some(Boolean) ? barChart(r.camera.peakByHour.map((v, h) => ({ label: `${h}:00`, short: h % 3 === 0 ? String(h) : '', value: v })), { format: v => `${Math.round(v)} people`, label: 'Peak people per hour' }) : html`<p class="muted">No camera head counts yet.</p>`}<span class="sr-only">${maxCam}</span></div>`);
    $('#days', body()).onchange = e => drawReport(Number(e.target.value));
  }

  function keySheet(title, key, deviceId, kind) {
    const isCam = kind === 'camera', path = isCam ? `/api/device/camera/${deviceId}/event` : `/api/device/access/${deviceId}/scan`;
    sheet({ title, body: html`<div class="notice warn">${icon('info')}<div>Copy this key now. It is shown only once and cannot be recovered.</div></div><p><code class="keybox">${key}</code></p>
      <p class="muted">The device sends it in the <code>x-device-key</code> header:</p><pre class="keybox" style="white-space:pre-wrap">POST ${path}
${isCam ? '{ "kind": "people_count", "people": 12 }' : '{ "credential": "TCXXXXXXXX", "direction": "in" }'}</pre>
      <p class="faint">${isCam ? 'Kinds: motion, people_count, unknown_person, tamper.' : 'The response says granted or denied, so the gate can open or stay shut.'} Send a heartbeat to <code>/heartbeat</code> at least every 2 minutes.</p>`, foot: html`<button class="btn primary" data-close>Done</button>` });
  }
  function drawDevices() {
    mount(body(), html`<div class="row between"><h2 style="margin:0">Gates and doors</h2><button class="btn primary" data-add="point">${icon('plus')}Add gate</button></div>
      ${data.points.length ? html`<div class="list" style="margin-top:10px">${data.points.map(p => html`<div class="list-item"><span class="machine-ico" aria-hidden="true">🚪</span><div class="grow"><div class="title">${p.name}</div><div class="faint">${titleCase(p.kind)}${p.location ? ' · ' + p.location : ''}</div></div>${devStatus(p.status)}
        <button class="btn small" data-toggle="point:${p.id}">${p.active ? 'Turn off' : 'Turn on'}</button><button class="btn small ghost" data-newkey="point:${p.id}">New key</button><button class="btn small danger" data-delete="point:${p.id}">Delete</button></div>`)}</div>` : html`<p class="muted">Add the gates or doors where people scan their booking QR code.</p>`}
      <div class="row between section"><h2 style="margin:0">Cameras</h2><button class="btn primary" data-add="camera">${icon('plus')}Add camera</button></div>
      ${data.cameras.length ? html`<div class="list" style="margin-top:10px">${data.cameras.map(c => html`<div class="list-item"><span class="machine-ico" aria-hidden="true">📷</span><div class="grow"><div class="title">${c.name}</div><div class="faint">${c.location || 'No location'}${c.source === 'webcam' ? ' · this computer\'s webcam (test)' : c.streamUrl ? ' · live link set' : ''}</div></div>${devStatus(c.status)}
        <button class="btn small" data-toggle="camera:${c.id}">${c.active ? 'Turn off' : 'Turn on'}</button>${c.source === 'webcam' ? '' : html`<button class="btn small ghost" data-newkey="camera:${c.id}">New key</button>`}<button class="btn small danger" data-delete="camera:${c.id}">Delete</button></div>`)}</div>` : html`<p class="muted">Cameras report events and head counts; add a stream link to open the live view from here.</p>`}`);
  }

  shell(); drawLive();
  on(pane, 'click', '[data-view]', async (_e, b) => {
    view = b.dataset.view; $$('[data-view]', pane).forEach(x => x.setAttribute('aria-pressed', x === b));
    try { if (view === 'live') { await refresh(); drawLive(); } else if (view === 'report') await drawReport(); else drawDevices(); } catch (e) { mount(body(), errorView(e)); }
  });
  on(pane, 'click', '[data-ack]', async (_e, b) => { try { await api(`${base}/alerts/${b.dataset.ack}/ack`, { method: 'POST' }); await refresh(); drawLive(); } catch (e) { toast(e.message, 'bad'); } });
  on(pane, 'submit', '#sim', async (e, f) => {
    e.preventDefault();
    try {
      const r = await api(`${base}/simulate`, { method: 'POST', body: { type: 'scan', deviceId: $('#sim-gate', f).value, credential: $('#sim-ref', f).value, direction: e.submitter?.dataset.dir || 'in' } });
      toast(`${r.result === 'granted' ? '✔' : '✖'} ${r.message}${r.result === 'granted' ? ` (${r.inside} inside)` : ''}`, r.result === 'granted' ? '' : 'bad'); await refresh(); drawLive();
    } catch (err) { toast(err.message, 'bad'); }
  });
  on(pane, 'submit', '#simc', async (e, f) => {
    e.preventDefault();
    try { await api(`${base}/simulate`, { method: 'POST', body: { type: 'camera', deviceId: $('#simc-cam', f).value, kind: $('#simc-kind', f).value, people: Number($('#simc-n', f).value) } }); toast('Camera event sent'); await refresh(); drawLive(); }
    catch (err) { toast(err.message, 'bad'); }
  });
  on(pane, 'click', '[data-toggle]', async (_e, b) => {
    const [kind, did] = b.dataset.toggle.split(':'), item = (kind === 'point' ? data.points : data.cameras).find(x => x.id === did);
    try { await api(`${base}/${kind === 'point' ? 'points' : 'cameras'}/${did}`, { method: 'PATCH', body: { active: !item.active } }); await refresh(); drawDevices(); } catch (e) { toast(e.message, 'bad'); }
  });
  on(pane, 'click', '[data-newkey]', async (_e, b) => {
    const [kind, did] = b.dataset.newkey.split(':');
    if (!(await confirmDialog('The old key stops working immediately. Update the device with the new one.', { title: 'Create a new key?', confirmLabel: 'Create key' }))) return;
    try { const r = await api(`${base}/${kind === 'point' ? 'points' : 'cameras'}/${did}/key`, { method: 'POST' }); keySheet('Device key', r.key, did, kind); } catch (e) { toast(e.message, 'bad'); }
  });
  on(pane, 'click', '[data-delete]', async (_e, b) => {
    const [kind, did] = b.dataset.delete.split(':'), item = (kind === 'point' ? data.points : data.cameras).find(x => x.id === did);
    if (!(await confirmDialog(kind === 'camera' ? 'The camera and the events it reported are removed. Past alerts stay in the history.' : 'The gate is removed. A gate with scan history cannot be deleted: turn it off instead.', { title: `Delete "${item.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api(`${base}/${kind === 'point' ? 'points' : 'cameras'}/${did}`, { method: 'DELETE' }); toast('Deleted'); await refresh(); drawDevices(); } catch (e) { toast(e.message, 'bad'); }
  });
  on(pane, 'click', '[data-add]', (_e, b) => {
    const cam = b.dataset.add === 'camera';
    sheet({ title: cam ? 'Add a camera' : 'Add a gate', body: html`<form id="df"><div class="field"><label for="d-name">Name</label><input id="d-name" name="name" required maxlength="60" placeholder="${cam ? 'Parking camera' : 'Main gate'}"></div>
        ${cam ? '' : html`<div class="field"><label for="d-kind">Type</label><select id="d-kind" name="kind"><option value="gate">Gate or turnstile</option><option value="door">Door</option><option value="court">Court entrance</option></select></div>`}
        <div class="field"><label for="d-loc">Where is it?</label><input id="d-loc" name="location" maxlength="100"></div>
        ${cam ? html`<div class="field"><label for="d-url">Live view link (optional)</label><input id="d-url" name="streamUrl" type="url" placeholder="https://..."></div>
        <div class="field"><label for="d-mode">How to show it</label><select id="d-mode" name="viewMode"><option value="image">Live image or MJPEG stream (shows on the Surveillance wall)</option><option value="page">Web page of the camera (embedded)</option><option value="link">Open in its own window</option><option value="webcam">This computer's webcam (for testing)</option></select><div class="hint">Cameras that only offer RTSP need a small converter to a web stream.</div></div>` : ''}<p class="form-error" id="d-err" role="alert"></p></form>`,
      foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="d-go">Create</button>`,
      onMount: (el, close) => { $('#d-go', el).onclick = e => busy(e.currentTarget, async () => {
        try { const r = await api(`${base}/${cam ? 'cameras' : 'points'}`, { method: 'POST', body: deviceBody($('#df', el), cam) }); close(); keySheet(cam ? 'Camera key' : 'Gate key', r.key, r.id, cam ? 'camera' : 'point'); await refresh(); drawDevices(); }
        catch (err) { $('#d-err', el).textContent = err.message; }
      }); } });
  });
}

// ---- Questions from players ----------------------------------------------------------------------------------------
async function questionsPane(ctx) {
  const { vid, pane } = ctx, list = await api(`/owner/venues/${vid}/questions`);
  const open = list.filter(q => !q.answered), done = list.filter(q => q.answered);
  mount(pane, html`<p class="muted">Public questions about this venue. Answers show on your venue page under your venue's name, and the player is notified.</p>
    <h2>Waiting for an answer ${open.length ? html`<span class="tag warn">${open.length}</span>` : ''}</h2>
    ${open.length ? html`<div class="stack">${open.map(q => questionCard(q))}</div>` : empty('chat', 'No open questions', 'You are all caught up.')}
    ${done.length ? html`<h2 class="section">Answered</h2><div class="stack">${done.map(q => questionCard(q))}</div>` : ''}`);
  for (const q of open) $(`[data-q="${q.id}"]`, pane)?.append(answerForm(q, () => repaint(ctx, questionsPane)));
}

// ---- Coaches ----------------------------------------------------------------------------------------------------------
async function coachesPane(ctx) {
  const { vid, pane } = ctx, base = `/owner/venues/${vid}/coaches`;
  const [list, meta] = await Promise.all([api(base), state.meta ? state.meta : api('/meta').then(m => (state.meta = m))]);
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const summary = c => { const by = {}; for (const a of c.availability) (by[a.weekday] ||= []).push(`${fmtTime(a.start)}–${fmtTime(a.end)}`); return Object.entries(by).map(([d, w]) => `${DAY[d]} ${w.join(', ')}`).join(' · ') || 'No availability'; };
  mount(pane, html`<div class="row between"><p class="muted" style="margin:0">Coaches players can book one-to-one. Their slots, ratings and comments appear on their profile.</p><button class="btn primary" id="new">${icon('plus')}Add coach</button></div>
    <div class="section">${list.length ? html`<div class="list">${list.map(c => html`<div class="card" data-coach="${c.id}"><div class="row between"><div><h3 style="margin:0">${c.name} ${c.active ? '' : html`<span class="tag">Hidden</span>`}</h3>
      <div class="faint">${c.scope === 'all' ? 'All games' : titleCase(c.specialty)} · ${money(c.price)} per ${c.sessionMinutes} min · ${c.rating ? '★ ' + c.rating + ` (${c.reviews})` : 'no ratings yet'} · ♥ ${c.likes}</div><div class="faint">${summary(c)}</div></div>
      <div class="row"><button class="btn small" data-reviews="${c.id}">Comments</button><button class="btn small" data-edit="${c.id}">Edit</button></div></div></div>`)}</div>` : empty('users', 'No coaches yet', 'Add a coach and set when they are available.')}</div>`);

  const windowRow = (w = { weekday: 1, start: '17:00', end: '20:00' }) => html`<div class="row nowrap win"><select aria-label="Day" name="wd">${DAY.map((d, i) => html`<option value="${i}" ${i === w.weekday ? 'selected' : ''}>${d}</option>`)}</select>
    <input type="time" name="ws" aria-label="From" value="${w.start}" required><span>to</span><input type="time" name="we" aria-label="To" value="${w.end}" required><button type="button" class="btn small ghost" data-rm aria-label="Remove window">${icon('x')}</button></div>`;
  const editor = (c = null) => sheet({
    title: c ? `Edit ${c.name}` : 'Add a coach', wide: true,
    body: html`<form id="cf"><div class="grid-2"><div class="field"><label for="c-name">Name</label><input id="c-name" name="name" required maxlength="60" value="${c?.name || ''}"></div>
      <div class="field"><label for="c-spec">Specialty</label><select id="c-spec" name="specialty">${meta.coachSpecialties.map(s => html`<option value="${s}" ${c?.specialty === s ? 'selected' : ''}>${titleCase(s)}</option>`)}</select></div>
      <div class="field"><label for="c-scope">Coaches</label><select id="c-scope" name="scope"><option value="game" ${c?.scope !== 'all' ? 'selected' : ''}>One game (the specialty)</option><option value="all" ${c?.scope === 'all' ? 'selected' : ''}>All games (common coach)</option></select><div class="hint">Common coaches can be added to a slot for any game.</div></div>
      <div class="field"><label for="c-price">Price per session (₹)</label><input id="c-price" name="price" type="number" min="0" required value="${c ? c.price / 100 : ''}"></div>
      <div class="field"><label for="c-min">Session length (minutes)</label><input id="c-min" name="sessionMinutes" type="number" min="15" max="240" step="15" required value="${c?.sessionMinutes || 60}"></div>
      <div class="field"><label for="c-years">Years of experience</label><input id="c-years" name="experienceYears" type="number" min="0" max="60" value="${c?.experienceYears ?? 3}"></div>
      <div class="field"><label for="c-lang">Languages</label><input id="c-lang" name="languages" maxlength="100" value="${c ? c.languages.join(', ') : 'English'}"></div></div>
      <div class="field"><label for="c-bio">About the coach</label><textarea id="c-bio" name="bio" maxlength="800">${c?.bio || ''}</textarea></div>
      <div class="field"><span class="label">Weekly availability</span><div id="wins" class="stack">${(c?.availability.length ? c.availability : [undefined]).map(w => windowRow(w))}</div>
        <button type="button" class="btn small" id="addwin" style="margin-top:8px">${icon('plus')}Add a time window</button><div class="hint">Sessions are cut from these windows, one after another.</div></div>
      ${c ? html`<label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}>Visible to players</label>` : ''}<p class="form-error" id="c-err" role="alert"></p></form>`,
    foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="c-go">Save</button>`,
    onMount: (el, close) => {
      $('#addwin', el).onclick = () => $('#wins', el).insertAdjacentHTML('beforeend', windowRow().toString());
      on(el, 'click', '[data-rm]', (_e, b) => { if ($$('.win', el).length > 1) b.closest('.win').remove(); });
      $('#c-go', el).onclick = e => busy(e.currentTarget, async () => {
        const f = $('#cf', el), fd = new FormData(f);
        const body = Object.fromEntries([...fd.entries()].filter(([k]) => !['wd', 'ws', 'we', 'active'].includes(k)));
        body.availability = $$('.win', el).map(w => ({ weekday: Number($('[name=wd]', w).value), start: $('[name=ws]', w).value, end: $('[name=we]', w).value }));
        if (c) body.active = !!$('[name=active]', el).checked;
        try { await api(c ? `${base}/${c.id}` : base, { method: c ? 'PATCH' : 'POST', body }); close(); toast('Saved'); repaint(ctx, coachesPane); }
        catch (err) { $('#c-err', el).textContent = err.message; }
      });
    },
  });
  $('#new', pane).onclick = () => editor();
  on(pane, 'click', '[data-edit]', (_e, b) => editor(list.find(c => c.id === b.dataset.edit)));
  on(pane, 'click', '[data-reviews]', (_e, b) => {
    const c = list.find(x => x.id === b.dataset.reviews);
    sheet({ title: `Comments for ${c.name}`, body: c.reviewList.length ? html`<div class="stack">${c.reviewList.map(r => html`<div class="review"><div class="row between"><b>${r.name}</b><span>${stars(r.rating)}</span></div>${r.comment ? html`<p style="margin:4px 0">${r.comment}</p>` : ''}
        ${r.reply ? html`<div class="owner-reply"><b>Your reply</b><br>${r.reply}</div>` : html`<form class="row nowrap" data-reply="${r.id}" style="margin-top:6px"><input placeholder="Reply publicly" maxlength="500" required style="flex:1"><button class="btn small primary">Reply</button></form>`}</div>`)}</div>` : html`<p class="muted">No comments yet.</p>`,
      onMount: el => on(el, 'submit', '[data-reply]', async (e, f) => {
        e.preventDefault();
        try { await api(`${base}/${c.id}/reviews/${f.dataset.reply}/reply`, { method: 'POST', body: { reply: $('input', f).value } }); toast('Reply posted'); el.closest('dialog')?.close(); repaint(ctx, coachesPane); } catch (err) { toast(err.message, 'bad'); }
      }) });
  });
}

// ---- Photos and videos ----------------------------------------------------------------------------------------------
async function mediaPane(ctx) {
  const { vid, venue, pane } = ctx, base = `/owner/venues/${vid}/media`;
  const items = await api(base), games = [...new Set(venue.courts.flatMap(c => c.sports))];
  mount(pane, html`<p class="muted">Photos and videos shown on each game's page and in Learn. Pick a game, or leave it as "All games" to show on every page.</p>
    <form class="card" id="up" style="margin-bottom:14px"><div class="grid-2">
      <div class="field"><label for="m-game">Show on</label><select id="m-game" name="sport"><option value="">All games</option>${games.map(g => html`<option value="${g}">${titleCase(g)}</option>`)}</select></div>
      <div class="field"><label for="m-cap">Caption (optional)</label><input id="m-cap" name="caption" maxlength="140" placeholder="Evening practice under the lights"></div></div>
      <div class="row"><label class="btn" for="m-file" style="margin:0">${icon('plus')}Choose photo or video</label><input id="m-file" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" class="sr-only"><span class="faint" id="m-name">Photos up to 3 MB, videos up to 25 MB (MP4 or WebM)</span></div>
      <div class="field" style="margin-top:12px"><label for="m-yt">Or a YouTube link</label><div class="row nowrap"><input id="m-yt" type="url" placeholder="https://www.youtube.com/watch?v=..." style="flex:1"><button type="button" class="btn" id="m-yt-go">Add link</button></div></div>
      <p class="form-error" id="m-err" role="alert"></p><button class="btn primary" id="m-go" disabled>Upload</button></form>
    ${items.length ? html`<div class="media-admin">${items.map(m => html`<div class="card media-card" data-id="${m.id}">
      <div class="thumb">${m.kind === 'image' ? html`<img src="${m.url}" alt="" loading="lazy">` : m.kind === 'video' ? html`<video src="${m.url}#t=0.2" preload="metadata" muted></video>` : html`<div class="yt">▶ YouTube</div>`}</div>
      <div class="body"><span class="tag ${m.sport ? 'good' : ''}">${m.sport ? titleCase(m.sport) : 'All games'}</span> <span class="tag">${titleCase(m.kind)}</span><div class="faint">${m.caption || 'No caption'}</div>
        <div class="row" style="margin-top:6px"><button class="btn small" data-edit="${m.id}">Edit</button><button class="btn small danger" data-del="${m.id}">Delete</button></div></div></div>`)}</div>` : empty('camera', 'No photos or videos yet', 'Upload your first one above.')}`);

  let file = null;
  $('#m-file', pane).onchange = e => {
    file = e.target.files[0] || null; $('#m-err', pane).textContent = '';
    const limit = file?.type.startsWith('video/') ? 25 : 3;
    if (file && file.size > limit * 1024 * 1024) { $('#m-err', pane).textContent = `That file is too large (max ${limit} MB).`; file = null; }
    $('#m-name', pane).textContent = file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : 'Photos up to 3 MB, videos up to 25 MB (MP4 or WebM)';
    $('#m-go', pane).disabled = !file;
  };
  const send = async body => {
    const f = Object.fromEntries(new FormData($('#up', pane)).entries());
    await api(base, { method: 'POST', body: { sport: f.sport, caption: f.caption, ...body } });
    toast('Added'); repaint(ctx, mediaPane);
  };
  $('#up', pane).onsubmit = e => { e.preventDefault(); };
  $('#m-go', pane).onclick = e => busy(e.currentTarget, async () => {
    try { const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); await send({ dataUrl }); }
    catch (err) { $('#m-err', pane).textContent = err.message; }
  });
  $('#m-yt-go', pane).onclick = e => busy(e.currentTarget, async () => {
    try { await send({ youtubeUrl: $('#m-yt', pane).value }); } catch (err) { $('#m-err', pane).textContent = err.message; }
  });
  on(pane, 'click', '[data-del]', async (_e, b) => {
    if (!(await confirmDialog('It disappears from the app straight away.', { title: 'Delete this item?', confirmLabel: 'Delete', danger: true }))) return;
    try { await api(`${base}/${b.dataset.del}`, { method: 'DELETE' }); toast('Deleted'); repaint(ctx, mediaPane); } catch (e) { toast(e.message, 'bad'); }
  });
  on(pane, 'click', '[data-edit]', (_e, b) => {
    const m = items.find(x => x.id === b.dataset.edit);
    sheet({ title: 'Edit', body: html`<form id="ef"><div class="field"><label for="e-game">Show on</label><select id="e-game" name="sport"><option value="">All games</option>${games.map(g => html`<option value="${g}" ${m.sport === g ? 'selected' : ''}>${titleCase(g)}</option>`)}</select></div>
        <div class="field"><label for="e-cap">Caption</label><input id="e-cap" name="caption" maxlength="140" value="${m.caption}"></div></form>`, foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="e-go">Save</button>`,
      onMount: (el, close) => { $('#e-go', el).onclick = ev => busy(ev.currentTarget, async () => { await api(`${base}/${m.id}`, { method: 'PATCH', body: Object.fromEntries(new FormData($('#ef', el)).entries()) }); close(); toast('Saved'); repaint(ctx, mediaPane); }); } });
  });
}

// ---- Surveillance wall ---------------------------------------------------------------------------------------------
async function surveillancePane(ctx) {
  const { vid, pane } = ctx, base = `/owner/venues/${vid}/access`;
  let data = await api(base), timer, snap;
  const stops = [], canManage = can(ctx.role, 'manager');
  const stream = u => /\.(svg|mjpe?g)(\?|$)|mjpeg/i.test(u);           // streams and animated feeds are left alone; snapshots are reloaded
  const tile = c => {
    const live = c.status === 'online';
    const view = c.source === 'webcam' ? html`<video class="webcam" autoplay muted playsinline aria-label="${c.name} live view"></video><div class="cam-off webcam-note" hidden></div>`
      : c.viewMode === 'image' && c.streamUrl ? html`<img src="${c.streamUrl}" alt="${c.name} live view" ${stream(c.streamUrl) ? '' : raw('data-snap')}>`
      : c.viewMode === 'page' && c.streamUrl ? html`<iframe src="${c.streamUrl}" title="${c.name} live view" loading="lazy" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe>`
      : html`<div class="cam-off">${c.streamUrl ? html`<div>${icon('camera')}<p>This camera opens in its own window</p><a class="btn small" href="${c.streamUrl}" target="_blank" rel="noopener noreferrer">${icon('ext')}Open live view</a></div>` : html`<div>${icon('camera')}<p>No stream link set. Add one under Access & security, Devices.</p></div>`}</div>`;
    return html`<div class="cam-tile ${live ? '' : 'offline'}" data-cam="${c.id}">${view}${live || c.source === 'webcam' ? '' : html`<div class="cam-off">Camera offline</div>`}
      <div class="cam-bar"><span>${c.name}${c.location ? html` <span style="opacity:.7">· ${c.location}</span>` : ''}</span><span class="row nowrap" style="gap:6px"><span class="row nowrap cam-meta" style="gap:6px">${c.source === 'webcam' ? html`<span class="tag info">Test webcam</span>` : ''}${c.people != null ? html`<span class="tag">${icon('users')}${c.people}</span>` : ''}${devStatus(c.status)}</span>${canManage ? html`<button class="icon-btn cam-del" data-del-cam="${c.id}" aria-label="Delete ${c.name}" title="Delete camera">${icon('trash')}</button>` : ''}</span></div>
      ${c.viewMode !== 'link' && c.streamUrl ? html`<button class="cam-zoom" data-zoom="${c.id}" aria-label="Enlarge ${c.name}"></button>` : ''}</div>`;
  };
  const alertsHtml = () => data.alerts.length ? html`<div class="stack">${data.alerts.slice(0, 6).map(a => html`<div class="notice ${ALERT_ICON[a.severity]}">${icon('alert')}<div class="grow"><b>${ALERT_LABEL[a.kind] || a.kind}</b> · ${clock(a.created_at)}<div>${a.message}</div></div><button class="btn small" data-ack="${a.id}">Acknowledge</button></div>`)}</div>` : html`<p class="muted">No open alerts.</p>`;
  mount(pane, html`<div class="kpis">${kpi('Cameras online', `${data.cameras.filter(c => c.status === 'online').length} / ${data.cameras.length}`)}${kpi('People inside', data.insideTotal, `${plural(data.inside.length, 'booking')}`)}${kpi('Open alerts', data.alerts.length)}</div>
    ${canManage && !data.cameras.some(c => c.source === 'webcam') ? html`<div class="row" style="margin-top:12px"><button class="btn" id="add-webcam">${icon('camera')}Add this computer's webcam as a test camera</button><span class="faint">Shows your own webcam here and reports motion like a real camera. The picture stays in your browser.</span></div>` : ''}
    <div class="section">${data.cameras.length ? html`<div class="cam-wall" id="wall">${data.cameras.map(tile)}</div>` : empty('camera', 'No cameras yet', 'Add cameras under Access & security, then Devices, or use your webcam as a test camera above.')}</div>
    <h2 class="section">Alerts</h2><div id="alerts">${alertsHtml()}</div>`);

  // Snapshot cameras refresh every few seconds; everything else is left running.
  snap = setInterval(() => $$('img[data-snap]', pane).forEach(i => { const u = new URL(i.src, location.href); u.searchParams.set('t', Date.now()); i.src = u.toString(); }), 3000);
  timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      data = await api(base);
      $('#alerts', pane).innerHTML = alertsHtml().toString();
      for (const c of data.cameras) {
        const el = $(`[data-cam="${c.id}"]`, pane); if (!el) continue;
        el.classList.toggle('offline', c.status !== 'online');
        $('.cam-meta', el).innerHTML = `${c.source === 'webcam' ? '<span class="tag info">Test webcam</span>' : ''}${c.people != null ? `<span class="tag">${c.people} in view</span>` : ''}${devStatus(c.status)}`;
      }
    } catch { /* keep the last picture */ }
  }, 8000);
  onLeave(() => { clearInterval(timer); clearInterval(snap); stops.forEach(f => f()); });
  for (const c of data.cameras.filter(x => x.source === 'webcam' && x.active)) startWebcam($(`[data-cam="${c.id}"]`, pane), c, base, stops);
  $('#add-webcam', pane)?.addEventListener('click', e => busy(e.currentTarget, async () => {
    await api(`${base}/cameras`, { method: 'POST', body: { name: 'My webcam', location: 'This computer', source: 'webcam', viewMode: 'link' } });
    toast('Webcam added. Allow the camera when your browser asks.'); repaint(ctx, surveillancePane);
  }));
  on(pane, 'click', '[data-del-cam]', async (_e, b) => {
    const c = data.cameras.find(x => x.id === b.dataset.delCam);
    if (!(await confirmDialog('The camera and the events it reported are removed. Past alerts stay in the history.', { title: `Delete "${c.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api(`${base}/cameras/${c.id}`, { method: 'DELETE' }); toast('Camera deleted'); repaint(ctx, surveillancePane); } catch (e) { toast(e.message, 'bad'); }
  });

  on(pane, 'click', '[data-zoom]', (_e, b) => {
    const c = data.cameras.find(x => x.id === b.dataset.zoom);
    sheet({ title: c.name, wide: true, body: c.viewMode === 'page' ? html`<div class="cam-tile" style="aspect-ratio:16/9"><iframe src="${c.streamUrl}" title="${c.name}" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer"></iframe></div>` : html`<div class="cam-tile" style="aspect-ratio:16/9"><img src="${c.streamUrl}" alt="${c.name} live view"></div>` });
  });
  on(pane, 'click', '[data-ack]', async (_e, b) => { try { await api(`${base}/alerts/${b.dataset.ack}/ack`, { method: 'POST' }); data = await api(base); $('#alerts', pane).innerHTML = alertsHtml().toString(); } catch (e) { toast(e.message, 'bad'); } });
}

// ---- Refunds -------------------------------------------------------------------------------------------------------
async function refundsPane(ctx) {
  const { vid, pane } = ctx;
  const list = await api(`/owner/venues/${vid}/refunds`);
  const pending = list.filter(r => r.status === 'pending');
  mount(pane, html`
    <h2>Waiting for a decision</h2>
    ${pending.length ? html`<div class="list">${pending.map(r => html`<div class="card"><div class="row between"><b>${r.customer} · ${money(r.amount)}</b><span class="faint">${r.ref} · ${fmtDate(r.date)} ${fmtTime(r.start_time)}</span></div>
      <p style="margin:6px 0">${r.reason}</p><div class="faint">Requested ${fmtDateTime(r.created_at)}</div>
      <div class="row" style="margin-top:10px"><button class="btn primary small" data-approve="${r.id}">Approve refund</button><button class="btn small" data-reject="${r.id}">Decline</button></div></div>`)}</div>`
      : empty('wallet', 'No refund requests', 'Requests from players appear here. Policy refunds for cancellations happen automatically.')}
    <h2 class="section">History</h2>
    ${list.filter(r => r.status !== 'pending').length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Booking</th><th>Customer</th><th>Origin</th><th>Reason</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>
      ${list.filter(r => r.status !== 'pending').map(r => html`<tr><td>${fmtDateTime(r.created_at)}</td><td>${r.ref}</td><td>${r.customer}</td><td>${titleCase(r.origin)}</td><td style="white-space:normal;min-width:200px">${r.reason}${r.decision_note ? html`<div class="faint">${r.decision_note}</div>` : ''}</td>
        <td class="num">${money(r.amount)}</td><td><span class="tag ${r.status === 'processed' ? 'good' : 'bad'}">${titleCase(r.status)}</span></td></tr>`)}</tbody></table></div>` : html`<p class="faint">No refunds yet.</p>`}`);
  on(pane, 'click', '[data-approve]', async (_e, b) => { const note = await confirmDialog('The money goes back to the customer\'s original payment method.', { title: 'Approve refund?', confirmLabel: 'Approve', input: { label: 'Note to customer (optional)' } }); if (note !== null) { try { await api(`/owner/venues/${vid}/refunds/${b.dataset.approve}/approve`, { method: 'POST', body: { note } }); toast('Refund issued'); repaint(ctx, refundsPane); } catch (e) { toast(e.message, 'bad'); } } });
  on(pane, 'click', '[data-reject]', async (_e, b) => { const note = await confirmDialog('The customer can escalate to Thidal if they disagree.', { title: 'Decline refund?', confirmLabel: 'Decline', danger: true, input: { label: 'Reason (sent to the customer)', required: true } }); if (note) { try { await api(`/owner/venues/${vid}/refunds/${b.dataset.reject}/reject`, { method: 'POST', body: { note } }); toast('Request declined'); repaint(ctx, refundsPane); } catch (e) { toast(e.message, 'bad'); } } });
}

// ---- Reports ---------------------------------------------------------------------------------------------------------
// Single-series bar chart: one hue (validated reference blue), 4px rounded data-ends on a shared baseline, hover tooltip.
function barChart(points, { format = String, label }) {
  const W = 720, H = 220, pad = { l: 56, r: 8, t: 12, b: 26 };
  const max = Math.max(1, ...points.map(p => p.value));
  const nice = (() => { const m = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / m / 2) * 2 * m; })();
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, slot = iw / points.length, bw = Math.max(2, Math.min(28, slot - 2));
  const y = v => pad.t + ih - (v / nice) * ih;
  const every = Math.ceil(points.length / 10);
  return html`<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
    ${[0, 0.5, 1].map(f => html`<line class="gridline" x1="${pad.l}" x2="${W - pad.r}" y1="${y(nice * f)}" y2="${y(nice * f)}"></line><text class="axis" x="${pad.l - 6}" y="${y(nice * f) + 4}" text-anchor="end">${format(nice * f)}</text>`)}
    ${points.map((p, i) => {
      const x = pad.l + i * slot + (slot - bw) / 2, top = y(p.value), h = pad.t + ih - top, r = Math.min(4, bw / 2, h);
      const path = h <= 0 ? '' : `M${x},${pad.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${pad.t + ih} Z`;
      return html`<rect class="bar-hit" x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${ih}" data-tip="${p.label}: ${format(p.value)}"></rect><path class="bar" d="${path}"></path>
        ${i % every === 0 ? html`<text class="axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${p.short}</text>` : ''}`;
    })}</svg><div class="chart-tip" hidden></div></div>`;
}
function wireCharts(root) {
  on(root, 'mousemove', '.bar-hit', (e, r) => { const c = r.closest('.chart'), tip = $('.chart-tip', c), box = c.getBoundingClientRect(); tip.hidden = false; tip.textContent = r.dataset.tip; tip.style.left = `${e.clientX - box.left}px`; tip.style.top = `${e.clientY - box.top}px`; });
  root.addEventListener('mouseout', e => { if (e.target.classList?.contains('bar-hit')) $$('.chart-tip', root).forEach(t => { t.hidden = true; }); });
}
async function reportsPane(ctx) {
  const { vid, venue, pane } = ctx;
  const days = store.get('tc.reportDays', 30);
  const r = await api(`/owner/venues/${vid}/reports?from=${addDays(venue.today, -(days - 1))}&to=${venue.today}`);
  const t = r.totals;
  const maxHour = Math.max(1, ...r.hours.flat());
  const shortRupees = p => p >= 10000000 ? `₹${(p / 10000000).toFixed(1)}L` : p >= 100000 ? `₹${Math.round(p / 100000)}k` : `₹${Math.round(p / 100)}`;
  mount(pane, html`
    <div class="row between" style="margin-bottom:12px"><div class="chips wrap" role="group" aria-label="Period">${[7, 30, 90].map(d => html`<button class="chip" data-days="${d}" aria-pressed="${d === days}">Last ${d} days</button>`)}</div>
      <span class="faint">${fmtDate(r.from)} – ${fmtDate(r.to)}</span></div>
    <div class="kpis">
      ${kpi('Revenue', money(t.revenue), `${money(t.online)} online · ${money(t.offline)} desk`)}${kpi('Bookings', t.bookings, `${t.repeatCustomers} repeat customers`)}
      ${kpi('Occupancy', `${t.occupancy}%`, `${t.bookedSlots} of ${t.capacity} slots`)}${kpi('Revenue per available slot', money(t.revenuePerSlot))}
      ${kpi('Average booking', money(t.averageBooking))}${kpi('Cancellations', t.cancellations, `${t.cancellationRate}% · ${money(t.refunds)} refunded`)}</div>
    <div class="card section"><h2>Revenue per day</h2>${barChart(r.series.map(s => ({ label: fmtDate(s.date), short: s.date.slice(8), value: s.revenue })), { format: shortRupees, label: 'Revenue per day' })}</div>
    <div class="card"><h2>Occupancy per day</h2>${barChart(r.series.map(s => ({ label: fmtDate(s.date), short: s.date.slice(8), value: s.occupancy })), { format: v => `${Math.round(v)}%`, label: 'Occupancy per day' })}</div>
    <div class="card"><h2>When players book</h2><p class="faint">Booked slots by weekday and start hour. Darker means busier — useful for setting peak prices and off-peak offers.</p>
      <div style="overflow-x:auto"><div class="heat" role="table" aria-label="Booked slots by weekday and hour">
        <span></span>${Array.from({ length: 24 }, (_, h) => html`<span style="text-align:center">${h % 3 === 0 ? h : ''}</span>`)}
        ${WEEKDAYS.map((d, wd) => html`<span role="rowheader">${d}</span>${r.hours[wd].map((n, h) => html`<span class="c" role="cell" data-l="${n ? Math.min(5, Math.ceil(n / maxHour * 5)) : 0}" title="${d} ${h}:00 — ${plural(n, 'booking')}"><span class="sr-only">${d} ${h}:00 ${n}</span></span>`)}`)}
      </div></div>
      <div class="heat-legend">Fewer ${[0, 1, 2, 3, 4, 5].map(l => html`<i style="background:var(--seq-${l})"></i>`)} More</div></div>
    <div class="card"><h2>By court</h2><div class="table-wrap"><table><thead><tr><th>Court</th><th class="num">Bookings</th><th class="num">Booked slots</th><th class="num">Revenue</th></tr></thead><tbody>
      ${r.byCourt.map(c => html`<tr><td>${c.court}</td><td class="num">${c.bookings}</td><td class="num">${c.bookedSlots}</td><td class="num">${money(c.revenue)}</td></tr>`)}</tbody></table></div></div>
    <details class="card"><summary style="cursor:pointer;font-weight:700">Daily figures (table)</summary><div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Date</th><th class="num">Bookings</th><th class="num">Revenue</th><th class="num">Occupancy</th><th class="num">Cancellations</th></tr></thead><tbody>
      ${r.series.slice().reverse().map(s => html`<tr><td>${fmtDate(s.date)}</td><td class="num">${s.bookings}</td><td class="num">${money(s.revenue)}</td><td class="num">${s.occupancy}%</td><td class="num">${s.cancellations}</td></tr>`)}</tbody></table></div></details>`);
  wireCharts(pane);
  on(pane, 'click', '[data-days]', (_e, b) => { store.set('tc.reportDays', Number(b.dataset.days)); repaint(ctx, reportsPane); });
}

// ---- Staff, payouts, audit --------------------------------------------------------------------------------------------
async function staffPane(ctx) {
  const { vid, pane } = ctx;
  const list = await api(`/owner/venues/${vid}/staff`);
  mount(pane, html`<div class="grid-2" style="align-items:start"><div class="card"><h2>Team</h2><div class="list">${list.map(s => html`<div class="list-item"><div class="grow"><div class="title">${s.name || s.email || s.phone}</div><div class="faint">${s.email || s.phone || ''}</div></div>
      <span class="tag">${titleCase(s.role)}</span>${s.role !== 'owner' ? html`<button class="btn small ghost danger" data-remove="${s.id}" aria-label="Remove ${s.name || 'staff member'}">${icon('trash')}</button>` : ''}</div>`)}</div></div>
    <div class="card"><h2>Add someone</h2>
      <dl class="kv" style="font-size:14px;margin-bottom:12px"><dt>Front desk</dt><dd style="text-align:left;font-weight:400">Calendar, desk bookings, check-in, customers, messages</dd>
        <dt>Manager</dt><dd style="text-align:left;font-weight:400">Everything front desk can do, plus pricing, blocks, promo codes, refunds, reports and venue setup</dd>
        <dt>Owner</dt><dd style="text-align:left;font-weight:400">Everything, plus staff, payouts, business details and the audit log</dd></dl>
      <form id="sf"><div class="field"><label for="s-id">Their mobile number or email</label><input id="s-id" name="identifier" required></div>
        <div class="field"><label for="s-name">Name</label><input id="s-name" name="name"></div>
        <div class="field"><label for="s-role">Role</label><select id="s-role" name="role"><option value="front_desk">Front desk</option><option value="manager">Manager</option></select></div>
        <p class="form-error" id="s-err" role="alert"></p><button class="btn primary">Add to team</button></form>
      <p class="faint" style="margin-top:8px">They sign in with a one-time code sent to that number or email.</p></div></div>`);
  $('#sf', pane).onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => { try { await api(`/owner/venues/${vid}/staff`, { method: 'POST', body: formData(e.target) }); toast('Added to the team'); repaint(ctx, staffPane); } catch (err) { $('#s-err', pane).textContent = err.message; } }); };
  on(pane, 'click', '[data-remove]', async (_e, b) => { if (await confirmDialog('They lose access to this venue straight away.', { title: 'Remove from team?', confirmLabel: 'Remove', danger: true })) { await api(`/owner/venues/${vid}/staff/${b.dataset.remove}`, { method: 'DELETE' }); repaint(ctx, staffPane); } });
}

async function payoutsPane({ vid, pane }) {
  const p = await api(`/owner/venues/${vid}/payouts`);
  mount(pane, html`<div class="kpis">${kpi('Not yet settled', money(p.unsettled.gross - p.unsettled.refunds), `Online takings${p.settledThrough ? ` after ${fmtDate(p.settledThrough)}` : ''}, before commission`)}
      ${kpi('Paid out to date', money(p.payouts.filter(x => x.status === 'paid').reduce((a, x) => a + x.net, 0)))}
      ${kpi('Payout account', p.account.bank ? `•••• ${p.account.last4}` : 'Not set', `${p.account.holder} · ${p.account.bank}`)}</div>
    <p class="faint section">Thidal settles online payments for each closed period, minus refunds and the platform commission. Cash and UPI taken at your desk stay with you and are not part of payouts.</p>
    ${p.payouts.length ? html`<div class="table-wrap"><table><thead><tr><th>Period</th><th class="num">Gross</th><th class="num">Refunds</th><th class="num">Commission</th><th class="num">Net payout</th><th>Status</th><th>Reference</th></tr></thead><tbody>
      ${p.payouts.map(x => html`<tr><td>${fmtDate(x.period_start)} – ${fmtDate(x.period_end)}</td><td class="num">${money(x.gross)}</td><td class="num">−${money(x.refunds)}</td><td class="num">−${money(x.commission)}</td><td class="num"><b>${money(x.net)}</b></td>
        <td><span class="tag ${x.status === 'paid' ? 'good' : 'warn'}">${titleCase(x.status)}</span></td><td>${x.reference || '—'}</td></tr>`)}</tbody></table></div>` : empty('cash', 'No payouts yet', 'Your first settlement appears after your first week of online bookings.')}`);
}

async function auditPane({ vid, pane }) {
  const list = await api(`/owner/venues/${vid}/audit`);
  mount(pane, html`<p class="muted">Every booking, price, refund, staff and settings change at this venue, newest first.</p>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>
    ${list.map(a => html`<tr><td>${fmtDateTime(a.created_at)}</td><td>${a.actor || 'System'}</td><td>${a.action}</td><td style="white-space:normal;min-width:260px;font-size:12px;font-family:ui-monospace,monospace">${summarize(a.details)}</td></tr>`)}</tbody></table></div>`);
}
const summarize = d => Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 400);

// ---- Venue setup ------------------------------------------------------------------------------------------------------
async function settingsPane(ctx) {
  const { vid, pane } = ctx;
  const [v, meta] = await Promise.all([api(`/owner/venues/${vid}`), state.meta || api('/meta')]);
  state.meta = meta;
  const isOwner = can(v.role, 'owner');
  mount(pane, html`
    <form class="card" id="vf"><h2>Venue profile</h2>
      <div class="grid-2"><div class="field"><label for="v-name">Venue name</label><input id="v-name" name="name" value="${v.name}" required></div>
        <div class="field"><label for="v-phone">Public phone</label><input id="v-phone" name="phone" value="${v.phone}" type="tel"></div>
        <div class="field"><label for="v-addr">Address</label><input id="v-addr" name="address" value="${v.address}" required></div>
        <div class="field"><label for="v-city">City</label><input id="v-city" name="city" value="${v.city}" required></div>
        <div class="field"><label for="v-lat">Latitude</label><input id="v-lat" name="lat" value="${v.lat}" inputmode="decimal" required></div>
        <div class="field"><label for="v-lng">Longitude</label><input id="v-lng" name="lng" value="${v.lng}" inputmode="decimal" required><button type="button" class="btn small ghost" id="here" style="margin-top:4px">${icon('pin')}Use my location</button></div></div>
      <div class="field"><label for="v-desc">Description</label><textarea id="v-desc" name="description">${v.description}</textarea></div>
      <div class="field"><label for="v-rules">Rules (one per line)</label><textarea id="v-rules" name="rules">${v.rules}</textarea></div>
      <div class="grid-2"><div class="field"><label for="v-surface">Main surface</label><select id="v-surface" name="surface">${meta.surfaces.map(s => html`<option value="${s}" ${s === v.surface ? 'selected' : ''}>${titleCase(s)}</option>`)}</select></div>
        <div class="field"><label for="v-video">Video link (https)</label><input id="v-video" name="video_url" value="${v.video_url}" placeholder="https://youtube.com/…"></div></div>
      <label class="check"><input type="checkbox" name="indoor" ${v.indoor ? 'checked' : ''}>Indoor venue</label><label class="check"><input type="checkbox" name="lighting" ${v.lighting ? 'checked' : ''}>Floodlights for night games</label>
      <fieldset style="border:0;padding:0;margin:12px 0"><legend class="label">Amenities</legend><div class="grid-2" style="gap:0 12px">${meta.amenities.map(a => html`<label class="check"><input type="checkbox" name="amenity" value="${a}" ${v.amenities.includes(a) ? 'checked' : ''}>${titleCase(a)}</label>`)}</div></fieldset>
      <button class="btn primary">Save profile</button></form>
    <form class="card" id="hf"><h2>Hours and booking rules</h2>
      <div class="grid-2"><div class="field"><label for="h-open">Opens</label><input id="h-open" name="open_time" type="time" value="${v.open_time}" step="1800" required></div>
        <div class="field"><label for="h-close">Closes</label><input id="h-close" name="close_time" value="${v.close_time}" pattern="[0-2][0-9]:[0-5][0-9]" required><div class="hint">Use 24:00 for midnight.</div></div>
        <div class="field"><label for="h-slot">Slot length (minutes)</label><select id="h-slot" name="slot_minutes">${[30, 60, 90, 120].map(m => html`<option ${m === v.slot_minutes ? 'selected' : ''}>${m}</option>`)}</select></div>
        <div class="field"><label for="h-hold">Checkout hold (minutes)</label><input id="h-hold" name="hold_minutes" type="number" min="3" max="30" value="${v.hold_minutes}"><div class="hint">How long a slot is reserved while the customer pays.</div></div>
        <div class="field"><label for="h-window">Bookable days ahead</label><input id="h-window" name="booking_window_days" type="number" min="1" max="90" value="${v.booking_window_days}"></div></div>
      <h3>Cancellation policy</h3>
      <div class="grid-2"><div class="field"><label for="h-full">Full refund if cancelled at least (hours before)</label><input id="h-full" name="cancel_full_hours" type="number" min="0" value="${v.cancel_full_hours}"></div>
        <div class="field"><label for="h-part">Partial refund if cancelled at least (hours before)</label><input id="h-part" name="cancel_partial_hours" type="number" min="0" value="${v.cancel_partial_hours}"></div>
        <div class="field"><label for="h-pct">Partial refund %</label><input id="h-pct" name="cancel_partial_percent" type="number" min="0" max="100" value="${v.cancel_partial_percent}"></div></div>
      <p class="faint" id="policy-preview">${policyText({ fullHours: v.cancel_full_hours, partialHours: v.cancel_partial_hours, partialPercent: v.cancel_partial_percent })}</p>
      <p class="faint">Changes apply to new bookings. Existing bookings keep the policy shown when they paid.</p>
      <button class="btn primary">Save hours and rules</button></form>
    <div class="card"><h2>Photos</h2><div class="photo-grid">${v.photos.map(p => html`<figure><img src="${p}" alt="Venue photo"><button class="btn small" data-photo="${p}" aria-label="Remove photo">${icon('trash')}</button></figure>`)}</div>
      <label class="btn" style="margin-top:12px">${icon('camera')}Add photo<input type="file" id="photo" accept="image/png,image/jpeg,image/webp" class="sr-only"></label><span class="faint"> PNG, JPEG or WebP up to 3 MB.</span></div>
    <div class="card"><div class="row between"><h2 style="margin:0">Courts and turfs</h2><button class="btn small" id="add-court">${icon('plus')}Add court</button></div>
      <div class="list section">${v.courts.map(c => html`<div class="list-item"><div class="grow"><div class="title">${c.name} ${c.active ? '' : html`<span class="tag">Inactive</span>`}</div>
        <div class="faint">${c.sports.map(sportLabel).join(', ')} · ${titleCase(c.surface)} · ${c.indoor ? 'Indoor' : 'Outdoor'} · ${money(c.base_price)}/slot</div></div><button class="btn small" data-court="${c.id}">Edit</button></div>`)}</div></div>
    ${isOwner ? html`<form class="card" id="bf"><h2>Business and payouts</h2><p class="muted">Used for invoices and settlements. Only the owner can see or change these.</p>
      <div class="grid-2"><div class="field"><label for="b-name">Registered business name</label><input id="b-name" name="business_name" value="${v.business_name}"></div>
        <div class="field"><label for="b-tax">GSTIN / tax ID</label><input id="b-tax" name="tax_id" value="${v.tax_id}"></div>
        <div class="field"><label for="b-holder">Account holder</label><input id="b-holder" name="payout_holder" value="${v.payout_holder}"></div>
        <div class="field"><label for="b-bank">Bank</label><input id="b-bank" name="payout_bank" value="${v.payout_bank}"></div>
        <div class="field"><label for="b-last4">Account number — last 4 digits</label><input id="b-last4" name="payout_last4" value="${v.payout_last4}" inputmode="numeric" maxlength="4"><div class="hint">Full bank details are collected securely by our payment partner during verification, not stored here.</div></div></div>
      <button class="btn primary">Save business details</button></form>` : ''}`);
  const save = async (btn, body) => busy(btn, async () => { await api(`/owner/venues/${vid}`, { method: 'PATCH', body }); toast('Saved'); });
  $('#vf', pane).onsubmit = e => { e.preventDefault(); const f = formData(e.target);
    delete f.amenity;
    save(e.submitter, { ...f, lat: Number(f.lat), lng: Number(f.lng), indoor: !!f.indoor, lighting: !!f.lighting, amenities: $$('[name=amenity]:checked', e.target).map(i => i.value) }); };
  $('#hf', pane).onsubmit = e => { e.preventDefault(); const f = formData(e.target); for (const k of ['slot_minutes', 'hold_minutes', 'booking_window_days', 'cancel_full_hours', 'cancel_partial_hours', 'cancel_partial_percent']) f[k] = Number(f[k]); save(e.submitter, f); };
  $('#hf', pane).oninput = () => { const f = formData($('#hf', pane)); $('#policy-preview', pane).textContent = policyText({ fullHours: +f.cancel_full_hours, partialHours: +f.cancel_partial_hours, partialPercent: +f.cancel_partial_percent }); };
  $('#bf', pane)?.addEventListener('submit', e => { e.preventDefault(); save(e.submitter, formData(e.target)); });
  $('#here', pane).onclick = () => navigator.geolocation?.getCurrentPosition(p => { $('#v-lat', pane).value = p.coords.latitude.toFixed(5); $('#v-lng', pane).value = p.coords.longitude.toFixed(5); }, () => toast('Location permission denied', 'bad'));
  $('#photo', pane).onchange = e => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 3 * 1024 * 1024) return toast('Images must be 3 MB or smaller', 'bad');
    const reader = new FileReader();
    reader.onload = async () => { try { await api(`/owner/venues/${vid}/photos`, { method: 'POST', body: { dataUrl: reader.result } }); toast('Photo added'); repaint(ctx, settingsPane); } catch (err) { toast(err.message, 'bad'); } };
    reader.readAsDataURL(file);
  };
  on(pane, 'click', '[data-photo]', async (_e, b) => { if (await confirmDialog('Remove this photo from your venue page?', { confirmLabel: 'Remove', danger: true })) { await api(`/owner/venues/${vid}/photos`, { method: 'DELETE', body: { url: b.dataset.photo } }); repaint(ctx, settingsPane); } });
  const courtSheet = c => sheet({
    title: c ? `Edit ${c.name}` : 'Add a court',
    body: html`<form id="ctf"><div class="field"><label for="ct-name">Name</label><input id="ct-name" name="name" value="${c?.name || ''}" required placeholder="e.g. Pitch D (5-a-side)"></div>
      <fieldset class="field" style="border:0;padding:0"><legend class="label">Sports</legend><div class="chips wrap">${meta.sports.map(s => html`<label class="chip ${c?.sports.includes(s) ? 'on' : ''}"><input type="checkbox" class="sr-only" name="sport" value="${s}" ${c?.sports.includes(s) ? 'checked' : ''}>${sportLabel(s)}</label>`)}</div></fieldset>
      <div class="grid-2"><div class="field"><label for="ct-surface">Surface</label><select id="ct-surface" name="surface">${meta.surfaces.map(s => html`<option value="${s}" ${s === (c?.surface || v.surface) ? 'selected' : ''}>${titleCase(s)}</option>`)}</select></div>
        <div class="field"><label for="ct-price">Base price per slot (₹)</label><input id="ct-price" name="basePrice" type="number" min="0" step="10" value="${c ? c.base_price / 100 : ''}" required inputmode="decimal"></div></div>
      <label class="check"><input type="checkbox" name="indoor" ${(c ? c.indoor : v.indoor) ? 'checked' : ''}>Indoor</label>
      ${c ? html`<label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}>Taking bookings</label>` : ''}<p class="form-error" id="ct-err" role="alert"></p></form>`,
    foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="ct-go">Save</button>`,
    onMount: (el, close) => {
      on(el, 'change', '.chip input', (_e, i) => i.closest('label').classList.toggle('on', i.checked));
      $('#ct-go', el).onclick = e => busy(e.currentTarget, async () => {
        const form = $('#ctf', el), f = formData(form);
        const body = { name: f.name, sports: $$('[name=sport]:checked', form).map(i => i.value), surface: f.surface, basePrice: f.basePrice, indoor: !!f.indoor, ...(c ? { active: !!f.active } : {}) };
        try { await api(c ? `/owner/venues/${vid}/courts/${c.id}` : `/owner/venues/${vid}/courts`, { method: c ? 'PATCH' : 'POST', body }); close(); toast('Court saved'); repaint(ctx, settingsPane); }
        catch (err) { $('#ct-err', el).textContent = err.message; }
      });
    },
  });
  $('#add-court', pane).onclick = () => courtSheet(null);
  on(pane, 'click', '[data-court]', (_e, b) => courtSheet(v.courts.find(c => c.id === b.dataset.court)));
}

const PANES = { store: storePane, surveillance: surveillancePane, media: mediaPane, coaches: coachesPane, questions: questionsPane, access: accessPane, vending: vendingPane, sessions: sessionsPane, overview: overviewPane, calendar: calendarPane, bookings: bookingsPane, checkin: checkinPane, customers: customersPane, support: supportPane, reviews: reviewsPane,
  pricing: pricingPane, coupons: couponsPane, refunds: refundsPane, reports: reportsPane, settings: settingsPane, staff: staffPane, payouts: payoutsPane, audit: auditPane };

// ---- Onboarding wizard ----------------------------------------------------------------------------------------------
export async function ownerNew(main) {
  const meta = state.meta || (state.meta = await api('/meta'));
  const d = store.get('tc.onboard', { step: 0, business: {}, venue: { open_time: '06:00', close_time: '23:00', amenities: [] }, courts: [{ name: '', sports: [], basePrice: '' }] });
  const STEPS = ['Business', 'Venue', 'Courts', 'Review'];
  const save = () => store.set('tc.onboard', d);
  const draw = () => {
    mount(main, html`<div style="max-width:720px;margin:0 auto">
      <h1>List your venue on Thidal</h1>
      <ol class="steps">${STEPS.map((s, i) => html`<li class="${i < d.step ? 'done' : i === d.step ? 'current' : ''}" ${i === d.step ? raw('aria-current="step"') : ''}>${s}</li>`)}</ol>
      <form class="card" id="wf" novalidate>${[businessStep, venueStep, courtsStep, reviewStep][d.step]()}
        <p class="form-error" id="werr" role="alert"></p>
        <div class="row between section">${d.step ? html`<button type="button" class="btn" id="back">Back</button>` : html`<span></span>`}
          <button class="btn primary">${d.step === 3 ? 'Submit for verification' : 'Continue'}</button></div></form>
      <p class="faint" style="text-align:center">Your progress is saved on this device.</p></div>`);
    wireWeekdays(main);
  };
  const businessStep = () => html`<h2>Business and payout details</h2><p class="muted">We pay your online takings to this account. Full bank details are verified securely by our payment partner.</p>
    <div class="grid-2"><div class="field"><label for="w-bn">Registered business name</label><input id="w-bn" name="business_name" value="${d.business.business_name || ''}" required></div>
      <div class="field"><label for="w-tax">GSTIN / tax ID (optional)</label><input id="w-tax" name="tax_id" value="${d.business.tax_id || ''}"></div>
      <div class="field"><label for="w-holder">Account holder name</label><input id="w-holder" name="payout_holder" value="${d.business.payout_holder || ''}" required></div>
      <div class="field"><label for="w-bank">Bank</label><input id="w-bank" name="payout_bank" value="${d.business.payout_bank || ''}" required></div>
      <div class="field"><label for="w-l4">Account number — last 4 digits</label><input id="w-l4" name="payout_last4" value="${d.business.payout_last4 || ''}" inputmode="numeric" maxlength="4" required></div></div>`;
  const venueStep = () => html`<h2>About the venue</h2>
    <div class="grid-2"><div class="field"><label for="w-name">Venue name</label><input id="w-name" name="name" value="${d.venue.name || ''}" required></div>
      <div class="field"><label for="w-phone">Public phone</label><input id="w-phone" name="phone" type="tel" value="${d.venue.phone || ''}"></div>
      <div class="field"><label for="w-addr">Address</label><input id="w-addr" name="address" value="${d.venue.address || ''}" required></div>
      <div class="field"><label for="w-city">City</label><input id="w-city" name="city" value="${d.venue.city || ''}" required></div>
      <div class="field"><label for="w-lat">Latitude</label><input id="w-lat" name="lat" value="${d.venue.lat ?? ''}" inputmode="decimal" required></div>
      <div class="field"><label for="w-lng">Longitude</label><input id="w-lng" name="lng" value="${d.venue.lng ?? ''}" inputmode="decimal" required></div></div>
    <button type="button" class="btn small" id="w-here">${icon('pin')}I'm at the venue — use my location</button>
    <div class="field section"><label for="w-desc">Description</label><textarea id="w-desc" name="description" placeholder="Surface, size, what makes it great">${d.venue.description || ''}</textarea></div>
    <div class="grid-2"><div class="field"><label for="w-open">Opens</label><input id="w-open" name="open_time" type="time" value="${d.venue.open_time}"></div>
      <div class="field"><label for="w-close">Closes</label><input id="w-close" name="close_time" value="${d.venue.close_time}" pattern="[0-2][0-9]:[0-5][0-9]"></div>
      <div class="field"><label for="w-surface">Main surface</label><select id="w-surface" name="surface">${meta.surfaces.map(s => html`<option value="${s}" ${s === d.venue.surface ? 'selected' : ''}>${titleCase(s)}</option>`)}</select></div></div>
    <label class="check"><input type="checkbox" name="indoor" ${d.venue.indoor ? 'checked' : ''}>Indoor venue</label><label class="check"><input type="checkbox" name="lighting" ${d.venue.lighting !== false ? 'checked' : ''}>Floodlights</label>
    <fieldset style="border:0;padding:0;margin-top:12px"><legend class="label">Amenities</legend><div class="grid-2" style="gap:0 12px">${meta.amenities.map(a => html`<label class="check"><input type="checkbox" name="amenity" value="${a}" ${d.venue.amenities.includes(a) ? 'checked' : ''}>${titleCase(a)}</label>`)}</div></fieldset>`;
  const courtsStep = () => html`<h2>Courts and turfs</h2><p class="muted">Add each bookable pitch or court. You can set peak pricing after verification.</p>
    ${d.courts.map((c, i) => html`<fieldset class="card" style="margin-bottom:12px"><legend class="label">Court ${i + 1}</legend>
      <div class="grid-2"><div class="field"><label for="c${i}-n">Name</label><input id="c${i}-n" data-c="${i}" data-k="name" value="${c.name}" placeholder="e.g. Pitch A (5-a-side)"></div>
        <div class="field"><label for="c${i}-p">Price per hour (₹)</label><input id="c${i}-p" data-c="${i}" data-k="basePrice" type="number" min="0" step="50" value="${c.basePrice}" inputmode="decimal"></div></div>
      <div class="chips wrap">${meta.sports.map(s => html`<label class="chip ${c.sports.includes(s) ? 'on' : ''}"><input type="checkbox" class="sr-only" data-c="${i}" data-sport="${s}" ${c.sports.includes(s) ? 'checked' : ''}>${sportLabel(s)}</label>`)}</div>
      ${d.courts.length > 1 ? html`<button type="button" class="btn small ghost danger" data-rm="${i}" style="margin-top:8px">Remove</button>` : ''}</fieldset>`)}
    <button type="button" class="btn small" id="add">${icon('plus')}Add another court</button>`;
  const reviewStep = () => html`<h2>Check and submit</h2>
    <dl class="kv"><dt>Business</dt><dd>${d.business.business_name}</dd><dt>Payout</dt><dd>${d.business.payout_bank} •••• ${d.business.payout_last4}</dd>
      <dt>Venue</dt><dd>${d.venue.name}</dd><dt>Address</dt><dd>${d.venue.address}, ${d.venue.city}</dd><dt>Hours</dt><dd>${fmtTime(d.venue.open_time)} – ${fmtTime(d.venue.close_time)}</dd>
      <dt>Courts</dt><dd>${d.courts.map(c => `${c.name} (₹${c.basePrice})`).join(', ')}</dd></dl>
    <div class="notice section">${icon('info')}<div>Thidal verifies new venues, usually within one working day. Once approved, your venue becomes searchable and bookable. The platform commission is deducted from online payments at settlement.</div></div>`;
  const collect = () => {
    const f = $('#wf', main);
    if (d.step === 0) d.business = formData(f);
    if (d.step === 1) { const x = formData(f); d.venue = { ...x, lat: x.lat === '' ? '' : Number(x.lat), lng: x.lng === '' ? '' : Number(x.lng), indoor: !!x.indoor, lighting: !!x.lighting, amenities: $$('[name=amenity]:checked', f).map(i => i.value) }; delete d.venue.amenity; }
    if (d.step === 2) $$('[data-c]', f).forEach(i => { const c = d.courts[i.dataset.c]; if (i.dataset.sport) { c.sports = c.sports.filter(s => s !== i.dataset.sport); if (i.checked) c.sports.push(i.dataset.sport); } else c[i.dataset.k] = i.value; });
    save();
  };
  const validate = () => {
    const missing = $$('#wf [required]', main).find(i => !i.value.trim());
    if (missing) { missing.setAttribute('aria-invalid', 'true'); missing.focus(); return `${$(`label[for=${missing.id}]`, main)?.textContent || 'A field'} is required`; }
    if (d.step === 0 && !/^\d{4}$/.test(d.business.payout_last4)) return 'Enter only the last 4 digits of the account number';
    if (d.step === 1 && (!Number.isFinite(d.venue.lat) || !Number.isFinite(d.venue.lng))) return 'Enter the venue location (latitude and longitude)';
    if (d.step === 2 && d.courts.some(c => !c.name.trim() || !c.sports.length || c.basePrice === '')) return 'Give every court a name, at least one sport and a price';
    return '';
  };
  on(main, 'submit', '#wf', async e => {
    e.preventDefault(); collect();
    const err = validate(); if (err) { $('#werr', main).textContent = err; return; }
    if (d.step < 3) { d.step++; save(); draw(); window.scrollTo(0, 0); return; }
    await busy(e.submitter, async () => {
      try {
        const r = await api('/owner/venues', { method: 'POST', body: { ...d.business, ...d.venue, courts: d.courts.map(c => ({ ...c, basePrice: Number(c.basePrice), surface: d.venue.surface, indoor: d.venue.indoor })) } });
        store.del('tc.onboard'); setMe(r.user); toast('Submitted! We will verify your venue shortly.'); go(`#/owner/${r.venue.id}`);
      } catch (err2) { $('#werr', main).textContent = err2.message; }
    });
  });
  on(main, 'click', '#back', () => { collect(); d.step--; save(); draw(); });
  on(main, 'click', '#add', () => { collect(); d.courts.push({ name: '', sports: [], basePrice: '' }); save(); draw(); });
  on(main, 'click', '[data-rm]', (_e, b) => { collect(); d.courts.splice(Number(b.dataset.rm), 1); save(); draw(); });
  on(main, 'change', '.chip input', (_e, i) => i.closest('label').classList.toggle('on', i.checked));
  on(main, 'click', '#w-here', () => navigator.geolocation?.getCurrentPosition(p => { $('#w-lat', main).value = p.coords.latitude.toFixed(5); $('#w-lng', main).value = p.coords.longitude.toFixed(5); }, () => toast('Location permission denied', 'bad')));
  draw();
}
