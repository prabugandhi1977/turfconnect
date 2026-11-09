// Shared front-end helpers: safe HTML templating, API client, session, formatting, dialogs and feedback states.

// ---- Templating: interpolations are escaped unless wrapped in raw()/html``. -------------------------------------
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v).replace(/[&<>"']/g, c => ESC[c]);
const render = v => v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('') : esc(v);
export function html(strings, ...values) { let out = ''; strings.forEach((s, i) => { out += s; if (i < values.length) out += render(values[i]); }); return new Raw(out); }
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function mount(el, view) { el.innerHTML = render(view); return el; }
export function on(root, event, selector, fn) { root.addEventListener(event, e => { const t = e.target.closest(selector); if (t && root.contains(t)) fn(e, t); }); }

// ---- Storage that tolerates private mode / blocked storage. -----------------------------------------------------
export const store = {
  get(k, fallback = null, area = localStorage) { try { const v = area.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v, area = localStorage) { try { area.setItem(k, JSON.stringify(v)); } catch {} },
  del(k, area = localStorage) { try { area.removeItem(k); } catch {} },
};
export const session = { get: (k, f) => store.get(k, f, sessionStorage), set: (k, v) => store.set(k, v, sessionStorage), del: k => store.del(k, sessionStorage) };

// ---- Session and API ---------------------------------------------------------------------------------------------
export const state = { token: store.get('tc.token'), me: store.get('tc.me'), meta: null };
export function setSession(token, me) { state.token = token; state.me = me; store.set('tc.token', token); store.set('tc.me', me); window.dispatchEvent(new Event('session')); }
export function setMe(me) { state.me = me; store.set('tc.me', me); window.dispatchEvent(new Event('session')); }
export function clearSession() { state.token = null; state.me = null; store.del('tc.token'); store.del('tc.me'); window.dispatchEvent(new Event('session')); }

export class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
export async function api(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  let res;
  try { res = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new ApiError(navigator.onLine ? 'Could not reach Thidal. Check your connection and try again.' : 'You are offline. Reconnect to continue.', 0, 'network'); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) { clearSession(); }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.code);
  return data;
}
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

// ---- Formatting -------------------------------------------------------------------------------------------------
export const money = p => p == null ? '—' : '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
export const rupees = p => (p / 100).toString();
const dateFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const longFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const fmtDate = d => dateFmt.format(new Date(d + 'T00:00:00Z'));
export const fmtLongDate = d => longFmt.format(new Date(d + 'T00:00:00Z'));
export const fmtDateTime = iso => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
export function fmtTime(t) { const [h, m] = t.split(':').map(Number); const hh = h % 12 || 12; return `${hh}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 || h === 24 ? 'am' : 'pm'}`; }
export const fmtRange = (a, b) => `${fmtTime(a)} – ${fmtTime(b)}`;
// "Today" in India, where the venues are. Venue pages use the venue's own date from the API.
export function todayIn(tz = 'Asia/Kolkata') { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const onDay = (d, today = todayIn()) => { const l = dayLabel(d, today); return l === 'Today' || l === 'Tomorrow' ? l.toLowerCase() : 'on ' + l; };
export function dayLabel(d, today = todayIn()) { return d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : fmtDate(d); }
export const titleCase = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
export const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
export const SPORT_ICON = { football: '⚽', cricket: '🏏', badminton: '🏸', tennis: '🎾', pickleball: '🏓', basketball: '🏀', volleyball: '🏐', futsal: '⚽', swimming: '🏊' };
export const sportLabel = s => `${SPORT_ICON[s] || ''} ${titleCase(s)}`.trim();
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const weekdaysLabel = w => w === '0123456' ? 'Every day' : w === '12345' ? 'Weekdays' : w === '06' ? 'Weekends' : [...w].map(d => WEEKDAYS[d]).join(', ');
export function policyText(p) {
  const parts = [`Free cancellation up to ${p.fullHours} hours before the game (full refund).`];
  if (p.partialPercent > 0 && p.partialHours < p.fullHours) parts.push(`${p.partialPercent}% refund between ${p.fullHours} and ${p.partialHours} hours before.`);
  parts.push(`No refund within ${p.partialPercent > 0 ? p.partialHours : p.fullHours} hours of the start.`);
  return parts.join(' ');
}

// ---- Icons (inline, stroke-based) ----------------------------------------------------------------------------------
const P = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>', ticket: '<path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 1 0 4v2h18v-2a2 2 0 0 1 0-4 2 2 0 0 0 0-4V6H3z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  home: '<path d="m3 11 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>', chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M16 3.1a4 4 0 0 1 0 7.8M22 21a7 7 0 0 0-4-6.3"/>', tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  wallet: '<path d="M20 7H5a2 2 0 0 1 0-4h13v4M3 5v14a2 2 0 0 0 2 2h15V7"/><circle cx="16" cy="14" r="1.5"/>', shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  chevron: '<path d="m15 18-6-6 6-6"/>', bag: '<path d="M6 7h12l1 14H5zM9 7V5a3 3 0 0 1 6 0v2"/>', key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l2 2M14 9l2 2"/>', monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  sparkle: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>', image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  cup: '<path d="M17 8h1a4 4 0 0 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 1v3M10 1v3M14 1v3"/>',
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', back: '<path d="M15 18l-6-6 6-6"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  filter: '<path d="M3 5h18M6 12h12M10 19h4"/>', qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>', alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/>', map: '<path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/>', download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>', gift: '<rect x="3" y="8" width="18" height="13" rx="1"/><path d="M12 8v13M3 12h18M12 8S10 3 7.5 3a2.5 2.5 0 0 0 0 5M12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>', camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>', building: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>', copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z"/>',
};
export const icon = (name, label) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${P[name] || ''}</svg>`);
export const stars = r => html`<span class="rating">${icon('star')}${r ?? 'New'}</span>`;

// ---- Feedback ---------------------------------------------------------------------------------------------------
export function toast(message, kind = '') {
  const box = $('#toasts'); const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = message; box.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3500);
}
export const skeleton = (kind = 'card', n = 3) => raw(Array.from({ length: n }, () => `<div class="skeleton sk-${kind}"></div>`).join(''));
export const empty = (ic, title, body, action = '') => html`<div class="empty"><div class="icon">${icon(ic)}</div><h3>${title}</h3><p>${body}</p>${action}</div>`;
export function errorView(err, retryLabel = 'Try again') {
  const offline = err?.code === 'network';
  return html`<div class="empty" role="alert"><div class="icon">${icon(offline ? 'refresh' : 'alert')}</div><h3>${offline ? 'Connection problem' : 'Something went wrong'}</h3>
    <p>${err?.message || 'Please try again.'}</p><button class="btn" data-retry>${retryLabel}</button></div>`;
}
export async function busy(button, fn) {
  if (!button || button.classList.contains('loading')) return;
  button.classList.add('loading'); button.setAttribute('aria-busy', 'true');
  try { return await fn(); }
  catch (e) { toast(e.message, 'bad'); }
  finally { button.classList.remove('loading'); button.removeAttribute('aria-busy'); }
}

// ---- Dialogs (native <dialog>: focus trap, Esc to close) --------------------------------------------------------
export function sheet({ title, body, foot = '', onMount, onClose, wide = false }) {
  const d = document.createElement('dialog');
  d.className = 'sheet'; if (wide) d.style.width = 'min(100vw, 760px)';
  d.setAttribute('aria-labelledby', 'sheet-title');
  mount(d, html`<div class="sheet-head"><h2 id="sheet-title">${title}</h2><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-body">${body}</div>${foot ? html`<div class="sheet-foot">${foot}</div>` : ''}`);
  document.body.append(d);
  const close = () => { if (d.open) d.close(); };
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) close(); });
  d.showModal();
  onMount?.(d, close);
  return { el: d, close };
}
export function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Confirm', danger = false, input = null } = {}) {
  return new Promise(resolve => {
    let done = false;
    const { el, close } = sheet({
      title,
      body: html`<p>${message}</p>${input ? html`<div class="field"><label for="confirm-input">${input.label}</label>
        ${input.multiline ? html`<textarea id="confirm-input" placeholder="${input.placeholder || ''}"></textarea>` : html`<input id="confirm-input" type="${input.type || 'text'}" placeholder="${input.placeholder || ''}" value="${input.value ?? ''}">`}
        ${input.hint ? html`<div class="hint">${input.hint}</div>` : ''}</div>` : ''}`,
      foot: html`<button class="btn" data-close>Back</button><button class="btn ${danger ? 'danger solid' : 'primary'}" data-ok>${confirmLabel}</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    $('[data-ok]', el).addEventListener('click', () => {
      const v = input ? $('#confirm-input', el).value.trim() : true;
      if (input?.required && !v) { $('#confirm-input', el).setAttribute('aria-invalid', 'true'); $('#confirm-input', el).focus(); return; }
      done = true; resolve(v); close();
    });
  });
}

// ---- Router -----------------------------------------------------------------------------------------------------
const routes = [];
let cleanup = [];
export const route = (pattern, view, opts = {}) => routes.push({ re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/?]+)') + '$'), view, ...opts });
export const onLeave = fn => cleanup.push(fn);
export const go = (hash, { replace = false } = {}) => { if (replace) history.replaceState(null, '', hash); else if (location.hash !== hash) { location.hash = hash; return; } resolveRoute(); };
export function currentPath() { const h = location.hash.slice(1) || '/'; const [path, qs] = h.split('?'); return { path, query: new URLSearchParams(qs || '') }; }
export async function resolveRoute() {
  for (const fn of cleanup) try { fn(); } catch {}
  cleanup = [];
  const { path, query } = currentPath();
  const r = routes.find(r => r.re.test(path)) || routes.find(r => r.fallback);
  const params = r.re.exec(path)?.groups || {};
  const shell = $('#app');
  if (r.auth && !state.token) return go(`#/login?next=${encodeURIComponent(location.hash || '#/')}`, { replace: true });
  window.dispatchEvent(new CustomEvent('route', { detail: { path, r } }));
  shell.className = r.wide ? 'wide' : '';
  // Each view renders into a fresh container, so listeners a view attaches never leak into the next one.
  const main = document.createElement('div');
  shell.replaceChildren(main);
  document.title = r.title ? `${r.title} · Thidal` : 'Thidal · திடல் — Play. Train. Belong.';
  try { await r.view(main, params, query); }
  catch (e) { console.error(e); mount(main, errorView(e)); $('[data-retry]', main)?.addEventListener('click', resolveRoute); }
  if (!r.keepScroll) window.scrollTo(0, 0);
  const h = $('h1', main); if (h && !shell.contains(document.activeElement)) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
}

// Live updates over server-sent events. The user channel needs a short-lived ticket (EventSource sends no headers).
export async function liveStream({ venueId = null, user = false, handlers }) {
  let url = '/api/stream?';
  if (venueId) url += `venue=${encodeURIComponent(venueId)}&`;
  if (user && state.token) { try { url += `ticket=${encodeURIComponent((await api('/me/stream-ticket', { method: 'POST' })).ticket)}`; } catch { if (!venueId) return () => {}; } }
  if (!('EventSource' in window)) return () => {};
  const es = new EventSource(url);
  for (const [event, fn] of Object.entries(handlers)) es.addEventListener(event, e => { try { fn(JSON.parse(e.data)); } catch {} });
  return () => es.close();
}

export function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const mapsUrl = v => `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}`;
