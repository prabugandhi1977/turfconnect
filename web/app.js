import { sheet, $, $$, api, busy, clearSession, confirmDialog, currentPath, empty, fmtDateTime, go, html, icon, liveStream, mount, resolveRoute, route, session, setMe, setSession, skeleton, state, store, toast, titleCase, fmtTime, SPORT_ICON } from './lib.js';
import { wellnessView, sessionDetailView } from './views/wellness.js';
import { vendingListView, machineView, orderView } from './views/vending.js';
import { coachesView, coachProfileView } from './views/coaches.js';
import { initChat } from './chat.js';
import { blogListView, blogPostView, questionsView, questionDetailView } from './views/community.js';
import { homeView, gameView, getSite } from './views/turf.js';
import { galleryView } from './views/gallery.js';
import { venueView, checkoutView, payView, bookingView, bookingsView, invoiceView } from './views/customer.js';
import { supportListView, supportNewView, supportThreadView } from './views/support.js';
import { ownerHome, ownerNew, ownerConsole } from './views/owner.js';
import { adminConsole } from './views/admin.js';

// ---- Theme -----------------------------------------------------------------------------------------------------
function applyTheme(t = store.get('tc.theme', 'system')) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
}
applyTheme();

// ---- Shell -----------------------------------------------------------------------------------------------------
// Grouped sidebar on desktop (a drawer behind the menu button on phones) and a five-tab bar on phones.
const isGame = p => p.startsWith('/game') || p.startsWith('/venue');
const GROUPS = site => [
  ['Play & book', [
    ['#/', 'home', 'Overview', p => p === '/'],
    ...(site?.games || []).map(g => [`#/game/${g.sport}`, null, titleCase(g.sport), p => p === `/game/${g.sport}`, g.courts, SPORT_ICON[g.sport] || '🎯']),
    ['#/bookings', 'ticket', 'My bookings', p => /^\/(bookings|booking|checkout|pay|invoice)/.test(p)],
  ]],
  ['Train & wellness', [
    ['#/wellness', 'bulb', 'Wellness classes', p => p.startsWith('/wellness') || p.startsWith('/session')],
    ['#/coaches', 'users', 'Coaches', p => p.startsWith('/coach')],
  ]],
  ['At the turf', [
    ['#/vending', 'cup', 'Snacks & coffee', p => p.startsWith('/vending') || p.startsWith('/order')],
    ['#/gallery', 'image', 'Photos & videos', p => p.startsWith('/gallery')],
    ['#/blog', 'book', 'Learn & Q&A', p => p.startsWith('/blog') || p.startsWith('/questions')],
  ]],
  ['Account', [
    ['#/notifications', 'bell', 'Notifications', p => p.startsWith('/notifications'), unread || null],
    ['#/support', 'chat', 'Help', p => p.startsWith('/support')],
    ['#/profile', 'user', 'Profile', p => p.startsWith('/profile') || p.startsWith('/login')],
  ]],
  ...((state.me?.venues?.length || state.me?.role === 'owner' || state.me?.role === 'admin') ? [['For business', [
    ...(state.me.venues?.length || state.me.role === 'owner' ? [['#/owner', 'building', 'Venue dashboard', p => p.startsWith('/owner')]] : []),
    ...(state.me.role === 'admin' ? [['#/admin', 'shield', 'Platform admin', p => p.startsWith('/admin')]] : []),
  ]]] : []),
];
const TABS = [['#/', 'home', 'Home', p => p === '/' || isGame(p)], ['#/wellness', 'bulb', 'Wellness', p => p.startsWith('/wellness') || p.startsWith('/session')],
  ['#/coaches', 'users', 'Coaches', p => p.startsWith('/coach')], ['#/bookings', 'ticket', 'Bookings', p => /^\/(bookings|booking|checkout|pay|invoice)/.test(p)],
  ['#/profile', 'user', 'Account', p => /^\/(profile|login|notifications|support)/.test(p)]];

let unread = 0, site = null;
getSite().then(s => { site = s; renderShell(); }).catch(() => {});
const themeNow = () => store.get('tc.theme', 'system');
const closedGroups = () => store.get('tc.side.closed', []);

function openStatus(v) {
  // Open/closed from the venue's hours in its own time zone.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: v.timezone || 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const mins = +parts.hour * 60 + +parts.minute, [oh, om] = v.openTime.split(':').map(Number), [ch, cm] = v.closeTime.split(':').map(Number);
  const open = mins >= oh * 60 + om && mins < ch * 60 + cm;
  return { open, label: open ? `Open now · until ${fmtTime(v.closeTime)}` : `Closed · opens ${fmtTime(v.openTime)}`, date: `${parts.weekday} ${parts.day} ${parts.month}` };
}

function renderShell(path = currentPath().path) {
  const closed = closedGroups();
  mount($('#side'), html`
    <div class="side-brand"><a class="brand" href="#/" data-go><span class="logo-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M12 6v12"/><circle cx="12" cy="12" r="2.4"/></svg></span>
      <span class="logo-text">Thidal <span class="ta" lang="ta">திடல்</span></span></a><p>Play. Train. Belong.</p>
      <button type="button" class="icon-btn side-close" data-close-side aria-label="Close menu">${icon('x')}</button></div>
    <nav class="side-nav" aria-label="Sections">${GROUPS(site).map(([title, items]) => html`<div class="side-group" ${closed.includes(title) ? html`data-closed` : ''}>
      <button type="button" class="side-h" data-group="${title}" aria-expanded="${!closed.includes(title)}">${title}${icon('chevron')}</button>
      <ul>${items.map(([href, ic, label, match, count, emoji]) => html`<li><a href="${href}" data-go ${match(path) ? html`aria-current="page"` : ''}>
        ${emoji ? html`<span class="side-em" aria-hidden="true">${emoji}</span>` : icon(ic)}<span class="lb">${label}</span>${count ? html`<span class="cnt">${count}</span>` : ''}</a></li>`)}</ul></div>`)}</nav>
    <div class="side-foot"><span class="eyebrow">Theme</span><div class="seg" role="group" aria-label="Colour theme">${[['system', 'monitor', 'Match device'], ['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']].map(([k, ic, l]) => html`
      <button type="button" data-theme-set="${k}" aria-pressed="${themeNow() === k}" title="${l}" aria-label="${l}">${icon(ic)}</button>`)}</div></div>`);
  mount($('#nav'), html`${TABS.map(([href, ic, label, match]) => html`<a href="${href}" ${match(path) ? html`aria-current="page"` : ''}>${icon(ic)}<span>${label}</span></a>`)}`);
  renderStatus();
  mountActions(state.me);
}
// Top bar: open/closed pill, date and location of the turf (refreshed every minute).
function renderStatus() {
  const v = site?.venue;
  if (!v) return;
  const s = openStatus(v);
  mount($('#status'), html`<span class="live ${s.open ? 'on' : ''}"><i aria-hidden="true"></i>${s.label}</span><span class="st-date mono">${s.date}</span>
    <span class="st-where"><small>${v.name}</small><b>${v.address.split(',').slice(-2).join(',').trim() || v.city}</b></span>`);
}
function mountActions(me) {
  // Desktop top bar carries a labelled theme switch, as on Vayal; phones use the one in the drawer.
  mount($('#topbar-actions'), html`
    <div class="seg labelled top-theme" role="group" aria-label="Colour theme">${[['light', 'sun', 'Light'], ['dark', 'moon', 'Dark'], ['system', 'monitor', 'Auto']].map(([k, ic, l]) => html`
      <button type="button" data-theme-set="${k}" aria-pressed="${themeNow() === k}">${icon(ic)}<span>${l}</span></button>`)}</div>
    ${me ? html`<a class="icon-btn" href="#/notifications" aria-label="Notifications${unread ? `, ${unread} unread` : ''}">${icon('bell')}${unread ? html`<span class="badge-dot">${unread > 9 ? '9+' : unread}</span>` : ''}</a>
      <a class="avatar-btn" href="#/profile" aria-label="Your account">${(me.name || me.email || '?').trim()[0].toUpperCase()}</a>`
      : html`<a class="btn small" href="#/login">Sign in</a>`}`);
}
$('#topbar-actions').addEventListener('click', e => {
  const th = e.target.closest('[data-theme-set]');
  if (th) { store.set('tc.theme', th.dataset.themeSet); applyTheme(); renderShell(); }
});
// Sidebar interactions are wired once; the sidebar's contents are re-rendered on every route change.
const sideEl = () => $('#side');
function setDrawer(open) {
  sideEl().classList.toggle('open', open); document.body.classList.toggle('drawer-open', open);
  $('#menu-btn').setAttribute('aria-expanded', open);
  if (open) sideEl().querySelector('a,button')?.focus(); else if (document.activeElement && sideEl().contains(document.activeElement)) $('#menu-btn').focus();
}
$('#menu-btn').onclick = () => setDrawer(!sideEl().classList.contains('open'));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sideEl().classList.contains('open')) setDrawer(false); });
document.addEventListener('click', e => { if (document.body.classList.contains('drawer-open') && !sideEl().contains(e.target) && !e.target.closest('#menu-btn')) setDrawer(false); });
sideEl().addEventListener('click', e => {
  if (e.target.closest('[data-go],[data-close-side]')) setDrawer(false);
  const g = e.target.closest('[data-group]');
  if (g) { const t = g.dataset.group, c = closedGroups(); store.set('tc.side.closed', c.includes(t) ? c.filter(x => x !== t) : [...c, t]); renderShell(); }
  const th = e.target.closest('[data-theme-set]');
  if (th) { store.set('tc.theme', th.dataset.themeSet); applyTheme(); renderShell(); }
});
setInterval(() => { if (!document.hidden) renderStatus(); }, 60000);
window.addEventListener('route', e => renderShell(e.detail.path));
window.addEventListener('session', () => { renderShell(); startUserStream(); });

async function refreshUnread() {
  if (!state.token) { unread = 0; return renderShell(); }
  try { unread = (await api('/me/notifications')).filter(n => !n.read_at).length; } catch { unread = 0; }
  renderShell();
}

// In-app notifications arrive live; when the tab is hidden and the user allowed it, show a system notification.
let stopUser = () => {};
async function startUserStream() {
  stopUser(); stopUser = () => {};
  if (!state.token) return;
  refreshUnread();
  stopUser = await liveStream({ user: true, handlers: {
    notification: n => {
      unread++; renderShell();
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        const sys = new Notification(n.title, { body: n.body, icon: '/icon-192.png', tag: n.id });
        sys.onclick = () => { window.focus(); if (n.link) location.hash = n.link; };
      } else toast(`${n.title} — ${n.body}`);
    },
    booking: b => window.dispatchEvent(new CustomEvent('booking-update', { detail: b })),
    support: s => window.dispatchEvent(new CustomEvent('support-update', { detail: s })),
  } });
}

// ---- Sign in (phone or email OTP) -----------------------------------------------------------------------------
const DEMO = [['player@turfconnect.test', 'Player', 'Book and manage games'], ['owner@turfconnect.test', 'Venue owner', 'Kickoff Arena + 4 more'],
  ['manager@turfconnect.test', 'Venue manager', 'Kickoff Arena'], ['desk@turfconnect.test', 'Front desk', 'Check-ins, walk-ins'], ['admin@turfconnect.test', 'Platform admin', 'Verify venues, disputes']];
async function loginView(main, _p, query) {
  const next = query.get('next') || '#/';
  if (state.token) return go(next, { replace: true });
  const meta = state.meta || (state.meta = await api('/meta').catch(() => ({})));
  const draft = session.get('tc.login', {});
  let step = 'identify', identifier = draft.identifier || '', devCode = null;
  const draw = () => mount(main, html`<div style="max-width:440px;margin:0 auto">
    <h1>${step === 'identify' ? 'Sign in or create an account' : step === 'code' ? 'Enter your code' : 'One last thing'}</h1>
    ${step === 'identify' ? html`
      <p class="muted">We'll send a one-time code. No password needed.</p>
      <form id="f" class="card" novalidate>
        <div class="field"><label for="ident">Mobile number or email</label>
          <input id="ident" name="identifier" inputmode="email" autocomplete="username" placeholder="98765 43210 or you@example.com" value="${identifier}" required></div>
        <details ${draft.referral ? 'open' : ''}><summary class="faint" style="cursor:pointer;margin-bottom:8px">Have a referral code?</summary>
          <div class="field"><label for="ref">Referral code</label><input id="ref" name="referral" autocomplete="off" value="${draft.referral || ''}" style="text-transform:uppercase"></div></details>
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn primary block" type="submit">Send code</button>
      </form>
      ${meta.devOtp ? html`<div class="section"><h3>Demo accounts</h3><p class="faint">Demo mode is on: the code appears on screen instead of by SMS or email.</p>
        <div class="demo-accounts">${DEMO.map(([email, name, sub]) => html`<button type="button" data-demo="${email}">${name}<small>${sub}</small></button>`)}</div></div>` : ''}`
    : step === 'code' ? html`
      <p class="muted">Sent to <b>${identifier}</b>. <a href="#" id="change">Change</a></p>
      ${devCode ? html`<div class="notice" role="status">${icon('info')}<div>Demo mode: your code is <b style="font-size:1.1em;letter-spacing:.1em">${devCode}</b></div></div>` : ''}
      <form id="f" class="card" style="margin-top:12px" novalidate>
        <div class="field"><label for="code">6-digit code</label>
          <input id="code" class="otp-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required></div>
        <p class="form-error" id="err" role="alert"></p>
        <button class="btn primary block" type="submit">Verify and continue</button>
        <button class="btn ghost block" type="button" id="resend" style="margin-top:8px">Resend code</button>
      </form>`
    : html`<p class="muted">What should venues call you?</p>
      <form id="f" class="card" novalidate><div class="field"><label for="name">Your name</label><input id="name" autocomplete="name" required></div>
      <p class="form-error" id="err" role="alert"></p><button class="btn primary block" type="submit">Continue</button></form>`}
  </div>`);
  const fail = msg => { $('#err', main).textContent = msg; };
  const request = async btn => busy(btn, async () => {
    try { const r = await api('/auth/otp/request', { method: 'POST', body: { identifier } }); identifier = r.identifier; devCode = r.devCode || null; step = 'code'; draw(); wire(); $('#code', main)?.focus(); }
    catch (e) { fail(e.message); }
  });
  const wire = () => {
    const f = $('#f', main);
    $$('[data-demo]', main).forEach(b => { b.onclick = () => { identifier = b.dataset.demo; request(b); }; });
    $('#change', main)?.addEventListener('click', e => { e.preventDefault(); step = 'identify'; draw(); wire(); });
    $('#resend', main)?.addEventListener('click', e => request(e.currentTarget));
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = f.querySelector('[type=submit]');
      if (step === 'identify') {
        identifier = $('#ident', main).value.trim();
        if (!identifier) return fail('Enter your mobile number or email');
        session.set('tc.login', { identifier, referral: $('#ref', main).value.trim() });
        return request(btn);
      }
      if (step === 'code') {
        const code = $('#code', main).value.trim();
        if (!/^\d{6}$/.test(code)) return fail('Enter the 6-digit code');
        await busy(btn, async () => {
          try {
            const r = await api('/auth/otp/verify', { method: 'POST', body: { identifier, code, referralCode: session.get('tc.login', {}).referral || undefined } });
            setSession(r.token, r.user); session.del('tc.login');
            if (!r.user.name) { step = 'name'; draw(); wire(); $('#name', main).focus(); return; }
            toast(`Welcome back, ${r.user.name.split(' ')[0]}`); go(next);
          } catch (err) { fail(err.message); }
        });
        return;
      }
      const name = $('#name', main).value.trim();
      if (name.length < 2) return fail('Enter your name');
      await busy(btn, async () => { setMe(await api('/me', { method: 'PATCH', body: { name } })); toast('Welcome to Thidal!'); go(next); });
    });
  };
  draw(); wire();
}

// ---- Profile ---------------------------------------------------------------------------------------------------
async function profileView(main) {
  mount(main, skeleton('card', 3));
  const [me, coupons] = await Promise.all([api('/me'), api('/me/coupons').catch(() => [])]);
  setMe(me);
  const theme = store.get('tc.theme', 'system');
  const shareText = `Book sports turfs on Thidal. Sign up with my code ${me.referralCode} and I get a reward after your first game.`;
  mount(main, html`
    <h1>${me.name || 'Your profile'}</h1>
    <div class="grid-2">
      <div class="card">
        <h2>Account</h2>
        <form id="name-form" class="field"><label for="pname">Name</label><div class="row nowrap"><input id="pname" value="${me.name}" autocomplete="name" required><button class="btn">Save</button></div></form>
        <dl class="kv"><dt>Mobile</dt><dd>${me.phone || '—'}</dd><dt>Email</dt><dd>${me.email || '—'}</dd></dl>
      </div>
      <div class="card">
        <h2>${icon('gift')} Invite friends</h2>
        <p class="muted">When a friend signs up with your code and plays their first paid game, you get a ₹100 promo code.</p>
        <div class="row"><span class="ref" style="font:800 20px ui-monospace,monospace;letter-spacing:.1em">${me.referralCode}</span>
          <button class="btn small" id="share">${icon('share')}Share</button></div>
      </div>
      <div class="card">
        <h2>${icon('tag')} Your promo codes</h2>
        ${coupons.length ? html`<div class="list">${coupons.map(c => html`<div class="list-item"><div class="grow"><div class="title">${c.code}</div><div class="faint">${c.description || (c.kind === 'percent' ? `${c.value}% off` : `₹${c.value / 100} off`)}${c.venue ? ` · ${c.venue}` : ''}</div></div></div>`)}</div>`
          : html`<p class="muted">No promo codes right now. Invite friends to earn one.</p>`}
      </div>
      <div class="card">
        <h2>Preferences</h2>
        <div class="field"><span class="label" id="theme-l">Theme</span><div class="chips wrap" role="group" aria-labelledby="theme-l">
          ${['system', 'light', 'dark'].map(t => html`<button class="chip" data-theme-opt="${t}" aria-pressed="${t === theme}">${t === 'system' ? 'Match device' : t[0].toUpperCase() + t.slice(1)}</button>`)}</div></div>
        ${'Notification' in window ? html`<div class="field"><span class="label">Alerts on this device</span>
          ${Notification.permission === 'granted' ? html`<p class="faint">On. You'll get booking alerts while Thidal is open in the background.</p>`
            : Notification.permission === 'denied' ? html`<p class="faint">Blocked in your browser settings.</p>` : html`<button class="btn small" id="notif">${icon('bell')}Turn on alerts</button>`}</div>` : ''}
      </div>
    </div>
    <div class="section card">
      <h2>${icon('building')} For venue owners</h2>
      ${me.venues.length ? html`<div class="list">${me.venues.map(v => html`<a class="list-item" href="#/owner/${v.id}"><div class="grow"><div class="title">${v.name}</div><div class="faint">${v.role.replace('_', ' ')} · ${v.status}</div></div>${icon('back')}</a>`)}</div>`
        : html`<p class="muted">Own a turf or court? List it on Thidal to take online bookings and payments.</p>`}
      <a class="btn" href="#/owner/new" style="margin-top:12px">${icon('plus')}List a venue</a>
    </div>
    <div class="section row">
      <button class="btn" id="logout">${icon('logout')}Sign out</button>
      <button class="btn ghost" id="logout-all">Sign out on all devices</button>
    </div>`);
  $('#name-form').addEventListener('submit', async e => { e.preventDefault(); await busy(e.submitter, async () => { setMe(await api('/me', { method: 'PATCH', body: { name: $('#pname').value } })); toast('Saved'); }); });
  $('#share').onclick = async () => {
    if (navigator.share) { try { await navigator.share({ title: 'Thidal', text: shareText, url: location.origin }); } catch {} }
    else { try { await navigator.clipboard.writeText(shareText + ' ' + location.origin); toast('Invite copied to clipboard'); } catch { toast(shareText); } }
  };
  $$('[data-theme-opt]', main).forEach(b => { b.onclick = () => { store.set('tc.theme', b.dataset.themeOpt); applyTheme(); profileView(main); renderShell('/profile'); }; });
  $('#notif')?.addEventListener('click', async () => { await Notification.requestPermission(); profileView(main); });
  $('#logout').onclick = () => { clearSession(); toast('Signed out'); go('#/'); };
  $('#logout-all').onclick = async () => { if (await confirmDialog('This signs you out on every phone and computer, including this one.', { confirmLabel: 'Sign out everywhere' })) { await api('/auth/logout-all', { method: 'POST' }).catch(() => {}); clearSession(); go('#/'); } };
}

async function notificationsView(main) {
  mount(main, skeleton('line', 6));
  const list = await api('/me/notifications');
  mount(main, html`<div class="row between"><h1>Notifications</h1></div>
    ${list.length ? html`<div class="list">${list.map(n => html`<a class="list-item" href="${n.link || '#/'}" style="${n.read_at ? '' : 'border-left:4px solid var(--brand)'}">
      <div class="grow"><div class="title">${n.title}</div><div class="muted" style="font-size:14px">${n.body}</div><div class="faint">${fmtDateTime(n.created_at)}</div></div></a>`)}</div>`
      : empty('bell', 'No notifications yet', 'Booking confirmations, reminders and refunds will show up here.')}`);
  if (list.some(n => !n.read_at)) { await api('/me/notifications/read', { method: 'POST' }).catch(() => {}); unread = 0; renderShell('/notifications'); }
}

// ---- Routes ----------------------------------------------------------------------------------------------------
route('/', homeView, { keepScroll: false, wide: true });
route('/game/:sport', gameView, { wide: true });
route('/gallery', galleryView, { title: 'Photos & videos' });
// Older links to the venue page land on the matching game, or the home page.
route('/venue/:slug', (main, _p, q) => go(q.get('sport') ? `#/game/${q.get('sport')}${q.get('date') ? '?date=' + q.get('date') : ''}` : '#/', { replace: true }));
route('/wellness', wellnessView, { keepScroll: false, title: 'Wellness classes' });
route('/session/:id', sessionDetailView);
route('/blog', blogListView, { title: 'Blog' });
route('/blog/:slug', blogPostView);
route('/questions', questionsView, { title: 'Questions & answers' });
route('/questions/:id', questionDetailView);
route('/coaches', coachesView, { title: 'Coaches' });
route('/coach/:id', coachProfileView);
route('/vending', vendingListView, { title: 'Snacks & coffee' });
route('/vending/:id', machineView);
route('/order/:id', orderView, { auth: true, title: 'Your order' });
route('/login', loginView, { title: 'Sign in' });
route('/checkout/:id', checkoutView, { auth: true, title: 'Checkout' });
route('/pay/:intent', payView, { auth: true, title: 'Payment' });
route('/booking/:id', bookingView, { auth: true, title: 'Booking' });
route('/bookings', bookingsView, { auth: true, title: 'My bookings' });
route('/invoice/:id', invoiceView, { auth: true, title: 'Invoice' });
route('/support', supportListView, { auth: true, title: 'Help' });
route('/support/new', supportNewView, { auth: true, title: 'Contact support' });
route('/support/:id', supportThreadView, { auth: true, title: 'Conversation' });
route('/profile', profileView, { auth: true, title: 'Profile' });
route('/notifications', notificationsView, { auth: true, title: 'Notifications' });
route('/owner', ownerHome, { auth: true, title: 'Venue dashboard' });
route('/owner/new', ownerNew, { auth: true, title: 'List your venue' });
route('/owner/:vid', ownerConsole, { auth: true, wide: true, title: 'Venue dashboard' });
route('/owner/:vid/:tab', ownerConsole, { auth: true, wide: true, title: 'Venue dashboard' });
route('/admin', adminConsole, { auth: true, wide: true, title: 'Admin' });
route('/admin/:tab', adminConsole, { auth: true, wide: true, title: 'Admin' });
route('/404', main => mount(main, empty('map', 'Page not found', 'That link does not lead anywhere.', html`<a class="btn primary" href="#/">Find a turf</a>`)), { fallback: true });

window.addEventListener('hashchange', resolveRoute);
initChat();
const syncOnline = () => { $('#offline').hidden = navigator.onLine; };
window.addEventListener('online', syncOnline); window.addEventListener('offline', syncOnline); syncOnline();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
renderShell();
startUserStream();
resolveRoute();
