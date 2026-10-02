// Platform admin: venue verification and suspension, support and disputes, payouts, review moderation and audit log.
import { $, api, busy, confirmDialog, empty, errorView, fmtDate, fmtDateTime, go, html, icon, money, mount, on, raw, skeleton, state, titleCase, toast, todayIn, addDays } from '../lib.js';
import { ticketList } from './support.js';

const TABS = [['overview', 'Overview', 'home'], ['venues', 'Venues', 'building'], ['support', 'Support & disputes', 'chat'], ['payouts', 'Payouts', 'cash'], ['audit', 'Audit log', 'shield']];
const kpi = (k, v, s = '') => html`<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div>${s ? html`<div class="s">${s}</div>` : ''}</div>`;
function repaint(ctx, fn) { const n = ctx.pane.cloneNode(false); ctx.pane.replaceWith(n); ctx.pane = n; return fn(ctx); }

export async function adminConsole(main, { tab = 'overview' }) {
  if (state.me?.role !== 'admin') return mount(main, empty('shield', 'Admins only', 'This area is for TurfConnect staff.', html`<a class="btn" href="#/">Back to TurfConnect</a>`));
  if (!TABS.some(t => t[0] === tab)) return go('#/admin', { replace: true });
  mount(main, html`<div class="console-head"><h1 style="margin:0">TurfConnect admin</h1></div>
    <div class="console"><nav class="console-nav" aria-label="Admin sections">${TABS.map(([k, l, ic]) => html`<a href="#/admin/${k}" ${k === tab ? raw('aria-current="page"') : ''}>${icon(ic)}${l}</a>`)}</nav><section id="pane"></section></div>`);
  const ctx = { pane: $('#pane', main) };
  mount(ctx.pane, skeleton('card', 3));
  try { await PANES[tab](ctx); } catch (e) { mount(ctx.pane, errorView(e)); $('[data-retry]', ctx.pane).onclick = () => adminConsole(main, { tab }); }
}

async function overview({ pane }) {
  const o = await api('/admin/overview');
  const failRate = o.paymentAttempts30d ? Math.round(o.failedPayments30d / o.paymentAttempts30d * 1000) / 10 : 0;
  mount(pane, html`<div class="kpis">
    ${kpi('Live venues', o.venues.active || 0, `${o.venues.pending || 0} awaiting verification · ${o.venues.suspended || 0} suspended`)}
    ${kpi('Paid bookings (30 days)', o.bookings30d)}${kpi('Net payments (30 days)', money(o.gmv30d), `${o.commissionPercent}% commission`)}
    ${kpi('Payment failure rate', `${failRate}%`, `${o.failedPayments30d} of ${o.paymentAttempts30d} attempts`)}${kpi('Abandoned checkouts', o.abandoned30d, 'Holds that expired, 30 days')}
    ${kpi('Open disputes', o.openDisputes, `${o.openTickets} open conversations`)}${kpi('Pending payouts', o.pendingPayouts.n, money(o.pendingPayouts.amount))}${kpi('Users', o.users)}</div>
    <div class="row section"><a class="btn primary" href="#/admin/venues">${icon('building')}Review venues</a><a class="btn" href="#/admin/support">${icon('chat')}Disputes</a><a class="btn" href="#/admin/payouts">${icon('cash')}Payouts</a></div>`);
}

async function venues(ctx) {
  const { pane } = ctx;
  const list = await api('/admin/venues');
  const tag = s => html`<span class="tag ${{ active: 'good', pending: 'warn', suspended: 'bad', rejected: 'bad' }[s]}">${titleCase(s)}</span>`;
  mount(pane, list.length ? html`<div class="list">${list.map(v => html`<div class="card"><div class="row between" style="align-items:flex-start">
      <div class="row nowrap" style="align-items:flex-start"><img src="${v.photos[0] || '/img/venue-1.svg'}" alt="" width="72" height="54" style="width:72px;height:54px;object-fit:cover;border-radius:8px">
        <div><h3 style="margin:0">${v.name} ${tag(v.status)}</h3><div class="faint">${v.address}, ${v.city} · ${v.courts} courts · ${v.bookings} bookings</div>
        <div class="faint">Owner ${v.owner} · ${v.owner_email || v.owner_phone || ''} · ${v.business_name}${v.tax_id ? ` · GSTIN ${v.tax_id}` : ''} · Payout ${v.payout_bank} •••• ${v.payout_last4}</div>
        ${v.status_note ? html`<div class="faint">Note: ${v.status_note}</div>` : ''}</div></div>
      <div class="row">${v.status !== 'active' ? html`<button class="btn primary small" data-status="active" data-id="${v.id}">${v.status === 'pending' ? 'Approve' : 'Reactivate'}</button>` : ''}
        ${v.status === 'active' ? html`<button class="btn danger small" data-status="suspended" data-id="${v.id}">Suspend</button>` : ''}
        ${v.status === 'pending' ? html`<button class="btn small" data-status="rejected" data-id="${v.id}">Request changes</button>` : ''}
        <a class="btn small ghost" href="#/owner/${v.id}">Open dashboard</a></div></div></div>`)}</div>` : empty('building', 'No venues yet', ''));
  on(pane, 'click', '[data-status]', async (_e, b) => {
    const status = b.dataset.status;
    const note = await confirmDialog(status === 'active' ? 'The venue becomes searchable and bookable straight away.' : status === 'suspended' ? 'New bookings stop immediately. Existing bookings stay valid.' : 'The owner is told what to fix.',
      { title: status === 'active' ? 'Approve venue?' : status === 'suspended' ? 'Suspend venue?' : 'Request changes?', confirmLabel: status === 'active' ? 'Approve' : status === 'suspended' ? 'Suspend' : 'Send', danger: status === 'suspended',
        input: { label: status === 'active' ? 'Note to owner (optional)' : 'Reason (shared with the owner)', required: status !== 'active' } });
    if (note === null) return;
    try { await api(`/admin/venues/${b.dataset.id}/status`, { method: 'POST', body: { status, note } }); toast('Venue updated'); repaint(ctx, venues); } catch (e) { toast(e.message, 'bad'); }
  });
}

async function support({ pane }) {
  const list = await api('/support/tickets?view=admin');
  const disputes = list.filter(t => t.kind === 'dispute' && t.status === 'open');
  mount(pane, html`<h2>Open disputes</h2>${disputes.length ? ticketList(disputes) : html`<p class="faint">No open disputes.</p>`}
    <h2 class="section">All conversations</h2>${ticketList(list.filter(t => !disputes.includes(t)))}`);
}

async function payouts(ctx) {
  const { pane } = ctx;
  const list = await api('/admin/payouts');
  // Default to last full Monday–Sunday week.
  const today = todayIn(), dow = new Date(today + 'T00:00:00Z').getUTCDay() || 7;
  const end = addDays(today, -dow), start = addDays(end, -6);
  mount(pane, html`<form class="card" id="gen"><h2>Create settlements</h2><p class="muted">Creates one payout per venue for online payments on games in the period, minus refunds and commission. Periods already settled are skipped.</p>
      <div class="row"><div class="field"><label for="ps">From</label><input id="ps" type="date" value="${start}" required></div><div class="field"><label for="pe">To</label><input id="pe" type="date" value="${end}" required></div>
      <button class="btn primary" style="margin-top:12px">Create payouts</button></div></form>
    <div class="section">${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Venue</th><th>Period</th><th class="num">Gross</th><th class="num">Refunds</th><th class="num">Commission</th><th class="num">Net</th><th>Account</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(p => html`<tr><td>${p.venue}</td><td>${fmtDate(p.period_start)} – ${fmtDate(p.period_end)}</td><td class="num">${money(p.gross)}</td><td class="num">${money(p.refunds)}</td><td class="num">${money(p.commission)}</td><td class="num"><b>${money(p.net)}</b></td>
        <td>${p.payout_bank} •••• ${p.payout_last4}</td><td><span class="tag ${p.status === 'paid' ? 'good' : 'warn'}">${titleCase(p.status)}</span>${p.reference ? html`<div class="faint">${p.reference}</div>` : ''}</td>
        <td>${p.status === 'pending' ? html`<button class="btn small" data-paid="${p.id}">Mark paid</button>` : fmtDateTime(p.paid_at)}</td></tr>`)}</tbody></table></div>` : empty('cash', 'No payouts yet', 'Create settlements for a finished period.')}</div>`);
  $('#gen', pane).onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => { const r = await api('/admin/payouts/generate', { method: 'POST', body: { periodStart: $('#ps', pane).value, periodEnd: $('#pe', pane).value } }); toast(r.created.length ? `Created ${r.created.length} payouts` : 'Nothing new to settle for that period'); repaint(ctx, payouts); }); };
  on(pane, 'click', '[data-paid]', async (_e, b) => {
    const reference = await confirmDialog('Record the bank transfer for this payout. The owner is notified.', { title: 'Mark as paid', confirmLabel: 'Mark paid', input: { label: 'Transfer reference (UTR / NEFT)', required: true } });
    if (reference) { try { await api(`/admin/payouts/${b.dataset.paid}/paid`, { method: 'POST', body: { reference } }); toast('Payout marked as paid'); repaint(ctx, payouts); } catch (e) { toast(e.message, 'bad'); } }
  });
}

async function audit({ pane }) {
  const list = await api('/admin/audit');
  mount(pane, html`<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Venue</th><th>Action</th><th>Details</th></tr></thead><tbody>
    ${list.map(a => html`<tr><td>${fmtDateTime(a.created_at)}</td><td>${a.actor || 'System'}</td><td>${a.venue || '—'}</td><td>${a.action}</td>
      <td style="white-space:normal;min-width:260px;font-size:12px;font-family:ui-monospace,monospace">${Object.entries(a.details).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 300)}</td></tr>`)}</tbody></table></div>`);
}

const PANES = { overview, venues, support, payouts, audit };
