// Help: support chat with a venue or TurfConnect, and disputes that escalate to platform admins.
import { $, api, busy, confirmDialog, sheet, empty, fmtDate, fmtDateTime, fmtRange, go, html, icon, mount, onLeave, skeleton, state, toast } from '../lib.js';

const statusTag = t => html`<span class="tag ${t.status === 'open' ? 'warn' : 'good'}">${t.status === 'open' ? 'Open' : 'Resolved'}</span>`;
export const ticketList = list => list.length ? html`<div class="list">${list.map(t => html`
  <a class="list-item" href="#/support/${t.id}"><div class="grow"><div class="title">${t.subject}</div>
    <div class="faint">${t.kind === 'dispute' ? 'Dispute · ' : ''}${t.venue || 'TurfConnect'}${t.customer && state.me?.id !== t.user_id ? ` · from ${t.customer}` : ''} · ${fmtDateTime(t.updated_at)}</div>
    ${t.last ? html`<div class="muted" style="font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.last.body}</div>` : ''}</div>${statusTag(t)}</a>`)}</div>`
  : empty('chat', 'No conversations', 'Questions about a booking or a venue? Start a conversation.');

export async function supportListView(main) {
  mount(main, skeleton('card', 3));
  const list = await api('/support/tickets');
  mount(main, html`<div class="row between"><h1 style="margin:0">Help</h1><a class="btn primary" href="#/support/new">${icon('plus')}New conversation</a></div>
    <div class="section grid-2">
      <div class="card"><h3>${icon('ticket')} Cancel or change a booking</h3><p class="muted">Open the booking from <a href="#/bookings">My bookings</a> to cancel it. The refund follows the venue's policy shown at checkout.</p></div>
      <div class="card"><h3>${icon('wallet')} Refunds</h3><p class="muted">Refunds go back to your original payment method in 5–7 working days. If a venue declines a refund you think you're owed, raise a dispute and our team will review it.</p></div>
    </div>
    <h2 class="section">Your conversations</h2>${ticketList(list)}`);
}

export async function supportNewView(main, _p, query) {
  mount(main, skeleton('card', 1));
  const bookings = [...await api('/bookings/mine?scope=upcoming'), ...await api('/bookings/mine?scope=past')].filter(b => b.status !== 'expired' && b.status !== 'failed');
  const pre = query.get('booking');
  mount(main, html`<h1>How can we help?</h1>
    <form class="card" id="f" style="max-width:640px">
      <div class="field"><label for="bk">Booking (optional)</label><select id="bk"><option value="">Not about a specific booking</option>
        ${bookings.map(b => html`<option value="${b.id}" ${b.id === pre ? 'selected' : ''}>${b.venue.name} · ${fmtDate(b.date)} ${fmtRange(b.startTime, b.endTime)} · ${b.ref}</option>`)}</select>
        <div class="hint">Linking a booking sends your message to that venue's team.</div></div>
      <fieldset class="field" style="border:0;padding:0" id="kind-f"><legend class="label">Type</legend>
        <label class="check"><input type="radio" name="kind" value="support" checked>Question or problem — the venue or TurfConnect will reply</label>
        <label class="check"><input type="radio" name="kind" value="dispute">Dispute — escalate to TurfConnect to review a refund or charge</label></fieldset>
      <div class="field"><label for="subj">Subject</label><input id="subj" maxlength="120" required></div>
      <div class="field"><label for="msg">Message</label><textarea id="msg" maxlength="2000" required></textarea></div>
      <p class="form-error" id="err" role="alert"></p>
      <button class="btn primary">Send</button></form>`);
  $('#f', main).onsubmit = e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      try {
        const t = await api('/support/tickets', { method: 'POST', body: { bookingId: $('#bk', main).value || undefined, kind: $('input[name=kind]:checked', main).value, subject: $('#subj', main).value, message: $('#msg', main).value } });
        toast('Message sent'); go(`#/support/${t.id}`);
      } catch (err) { $('#err', main).textContent = err.message; }
    });
  };
}

export async function supportThreadView(main, { id }) {
  mount(main, skeleton('card', 2));
  let t;
  // Re-render only when something changed, so a background refresh never wipes a half-typed reply.
  const load = async () => {
    const next = await api(`/support/tickets/${id}`);
    const changed = !t || next.messages.length !== t.messages.length || next.status !== t.status;
    t = next; if (changed) draw();
  };
  const draw = () => {
    const canResolve = t.status === 'open' && (t.access === 'admin' || (t.access === 'venue' && t.kind === 'support') || t.access === 'customer');
    mount(main, html`
      <a class="btn ghost small" href="${t.access === 'admin' ? '#/admin/support' : t.access === 'venue' ? `#/owner/${t.venue_id}/support` : '#/support'}" style="margin-left:-8px">${icon('back')}Back</a>
      <div class="row between"><h1 style="margin:0">${t.subject}</h1>${statusTag(t)}</div>
      <p class="faint">${t.kind === 'dispute' ? 'Dispute · reviewed by TurfConnect' : t.venue ? `With ${t.venue}` : 'With TurfConnect support'}${t.booking ? ` · Booking ${t.booking.ref} (${fmtDate(t.booking.date)} ${fmtRange(t.booking.start_time, t.booking.end_time)})` : ''}</p>
      ${t.access === 'customer' && t.booking ? html`<a class="btn small" href="#/booking/${t.booking.id}">View booking</a>` : ''}
      <div class="thread section" aria-live="polite">${t.messages.map(m => html`<div class="bubble ${m.mine ? 'mine' : ''}"><div class="who">${m.mine ? 'You' : m.side === 'customer' ? m.name : `${m.name} · ${m.side}`}</div>
        <div style="white-space:pre-wrap">${m.body}</div><div class="faint">${fmtDateTime(m.created_at)}</div></div>`)}</div>
      ${t.status === 'open' ? html`<form id="reply" class="section row nowrap" style="align-items:flex-end"><div style="flex:1"><label for="body" class="sr-only">Reply</label><textarea id="body" placeholder="Write a reply…" style="min-height:52px" required></textarea></div>
        <button class="btn primary">Send</button></form>` : html`<div class="notice good section">${icon('check')}<div><b>Resolved.</b> ${t.resolution}</div></div>`}
      ${canResolve ? html`<div class="section row"><button class="btn small" id="resolve">${t.access === 'customer' ? 'Mark as solved' : 'Resolve'}</button></div>` : ''}`);
    const rf = $('#reply', main);
    if (rf) rf.onsubmit = e => { e.preventDefault(); busy(e.submitter, async () => { await api(`/support/tickets/${id}/messages`, { method: 'POST', body: { body: $('#body', main).value } }); $('#body', main).value = ''; await load(); }); };
    $('#resolve', main)?.addEventListener('click', async () => {
      if (t.access === 'customer') {
        if (await confirmDialog('Close this conversation?', { confirmLabel: 'Mark as solved' })) {
          try { await api(`/support/tickets/${id}/resolve`, { method: 'POST', body: { resolution: 'Solved — closed by customer' } }); load(); } catch (e) { toast(e.message, 'bad'); }
        }
        return;
      }
      sheet({
        title: t.kind === 'dispute' ? 'Resolve dispute' : 'Resolve conversation',
        body: html`<div class="field"><label for="res">Resolution (sent to the customer)</label><textarea id="res" required></textarea></div>
          ${t.access === 'admin' && t.booking ? html`<div class="field"><label for="amt">Refund amount (₹, optional)</label><input id="amt" type="number" min="0" step="1" inputmode="decimal">
            <div class="hint">Booking ${t.booking.ref} was ₹${t.booking.amount / 100}. The refund goes back to the original payment method.</div></div>` : ''}
          <p class="form-error" id="rerr" role="alert"></p>`,
        foot: html`<button class="btn" data-close>Back</button><button class="btn primary" id="do">Resolve</button>`,
        onMount: (el, close) => { $('#do', el).onclick = e => busy(e.currentTarget, async () => {
          try { await api(`/support/tickets/${id}/resolve`, { method: 'POST', body: { resolution: $('#res', el).value, refundAmount: $('#amt', el)?.value || undefined } }); close(); toast('Resolved'); load(); }
          catch (err) { $('#rerr', el).textContent = err.message; }
        }); },
      });
    });
  };
  await load();
  const onUpdate = e => { if (e.detail.ticketId === id) load(); };
  window.addEventListener('support-update', onUpdate);
  const poll = setInterval(() => !document.hidden && load().catch(() => {}), 15000);
  onLeave(() => { window.removeEventListener('support-update', onUpdate); clearInterval(poll); });
}
