// Snacks and coffee machines: see which machines are working, pre-order and pay in the app, then enter the pickup code at the machine.
import {
  $, $$, api, busy, empty, errorView, fmtDateTime, go, html, icon, money, mount, on, onLeave, plural, skeleton, state, titleCase, toast,
} from '../lib.js';

export const MACHINE_ICON = { snacks: '🍿', coffee: '☕', combo: '🥤' };
const CAT_ICON = { snack: '🍪', coffee: '☕', drink: '🥤' };
const STATUS = {
  online: ['good', 'Working'], fault: ['bad', 'Out of order'], offline: ['warn', 'Offline'],
};
export const statusPill = s => html`<span class="tag ${STATUS[s][0]}">${STATUS[s][1]}</span>`;

function machineCard(m) {
  return html`<a class="card machine-card ${m.status}" href="#/vending/${m.id}">
    <div class="machine-ico" aria-hidden="true">${MACHINE_ICON[m.kind]}</div>
    <div class="grow"><div class="row between nowrap"><h3 style="margin:0">${m.name}</h3>${statusPill(m.status)}</div>
      <div class="muted" style="font-size:14px">${m.venue.name}${m.location ? ' · ' + m.location : ''}</div>
      <div class="faint">${m.status !== 'online' ? 'Ordering is paused until it is back.' : m.soldOut ? `${plural(m.soldOut, 'item')} sold out` : m.lowStock ? `${plural(m.lowStock, 'item')} running low` : 'Fully stocked'}</div></div></a>`;
}

export async function vendingListView(main) {
  mount(main, html`<section class="hero"><p class="eyebrow">Snacks &amp; coffee</p><h1>Order ahead, <em>grab and go.</em></h1>
    <p class="muted">Pre-order from a machine at your venue, pay in the app and collect with a code. No queue, no coins.</p></section>
    <div id="orders"></div><h2 style="font-size:1rem;margin:16px 0 10px">Machines</h2><div id="machines">${skeleton('card', 3)}</div>`);
  const list = await api('/vending/machines').catch(e => { mount($('#machines', main), errorView(e)); throw e; });
  mount($('#machines', main), list.length ? html`<div class="grid-3">${list.map(machineCard)}</div>` : empty('bulb', 'No machines yet', 'Venues are adding snack and coffee machines. Check back soon.'));
  if (state.token) {
    api('/vending/orders/mine').then(mine => {
      const open = mine.filter(o => o.status === 'paid' || o.status === 'held');
      if (!open.length) return;
      mount($('#orders', main), html`<h2 style="font-size:1rem;margin:16px 0 10px">Your open orders</h2><div class="list">${open.map(o => html`
        <a class="list-item" href="#/order/${o.id}"><div class="grow"><div class="title">${o.machine.name}</div><div class="faint">${o.items.map(i => `${i.qty}× ${i.name}`).join(', ')}</div></div>
        ${o.status === 'paid' ? html`<span class="tag good">Ready: code ${o.pickupCode}</span>` : html`<span class="tag warn">Awaiting payment</span>`}</a>`)}</div>`);
    }).catch(() => {});
  }
}

export async function machineView(main, { id }) {
  mount(main, html`<div class="skeleton sk-block"></div>${skeleton('line', 4)}`);
  const m = await api(`/vending/machines/${encodeURIComponent(id)}`);
  document.title = `${m.name} · Thidal`;
  const cart = new Map();                       // itemId -> qty
  const canOrder = m.status === 'online';
  const byId = Object.fromEntries(m.items.map(i => [i.id, i]));
  const cats = ['coffee', 'snack', 'drink'].filter(c => m.items.some(i => i.category === c));

  mount(main, html`
    <a href="#/vending" class="btn ghost small" style="margin-left:-8px">${icon('back')}All machines</a>
    <div class="machine-head"><div class="machine-ico big" aria-hidden="true">${MACHINE_ICON[m.kind]}</div>
      <div><h1 style="margin:0">${m.name}</h1><div class="muted">${m.venue.name}${m.location ? ' · ' + m.location : ''}</div><div style="margin-top:6px">${statusPill(m.status)}</div></div></div>
    ${canOrder ? '' : html`<div class="notice warn" style="margin:12px 0">${icon('info')}<div>${m.status === 'fault' ? 'This machine is out of order.' : 'This machine has not checked in recently.'} Ordering is paused. Try another machine or check back soon.</div></div>`}
    ${cats.map(c => html`<section class="section"><h2>${CAT_ICON[c]} ${titleCase(c === 'coffee' ? 'hot drinks' : c === 'snack' ? 'snacks' : 'cold drinks')}</h2>
      <div class="menu">${m.items.filter(i => i.category === c).map(i => html`
        <div class="menu-item ${i.available === 0 ? 'soldout' : ''}"><div class="grow"><div class="title">${i.name}</div>
          <div class="faint">${i.available === 0 ? 'Sold out' : i.available <= 3 ? `Only ${i.available} left` : 'Slot ' + i.slot}</div></div>
          <b class="price-tag">${money(i.price)}</b>
          <div class="stepper" data-item="${i.id}"><button type="button" data-dec aria-label="Remove one ${i.name}" ${canOrder && i.available ? '' : 'disabled'}>−</button><output aria-live="polite">0</output>
            <button type="button" data-inc aria-label="Add one ${i.name}" ${canOrder && i.available ? '' : 'disabled'}>+</button></div></div>`)}</div></section>`)}
    <div class="sticky-cta" id="cta" hidden></div>`);

  const total = () => [...cart].reduce((s, [k, q]) => s + byId[k].price * q, 0), count = () => [...cart.values()].reduce((a, b) => a + b, 0);
  function draw() {
    for (const el of $$('.stepper', main)) { const q = cart.get(el.dataset.item) || 0; $('output', el).textContent = q; el.classList.toggle('has', q > 0); }
    const cta = $('#cta', main);
    if (!count()) { cta.hidden = true; return; }
    cta.hidden = false;
    mount(cta, html`<div><div style="font-weight:800">${money(total())}</div><div class="faint">${plural(count(), 'item')}</div></div><button class="btn primary" id="pay">Pay and get code</button>`);
  }
  on(main, 'click', '[data-inc]', (_e, b) => {
    const id = b.closest('[data-item]').dataset.item, it = byId[id], q = cart.get(id) || 0;
    if (q >= Math.min(4, it.available)) return toast(it.available <= q ? `Only ${it.available} left` : 'Up to 4 of each item');
    if (count() >= 8) return toast('You can order up to 8 items at once');
    cart.set(id, q + 1); draw();
  });
  on(main, 'click', '[data-dec]', (_e, b) => { const id = b.closest('[data-item]').dataset.item, q = (cart.get(id) || 0) - 1; q > 0 ? cart.set(id, q) : cart.delete(id); draw(); });
  on(main, 'click', '#pay', (_e, b) => {
    if (!state.token) { toast('Sign in to order'); return go(`#/login?next=${encodeURIComponent('#/vending/' + m.id)}`); }
    return busy(b, async () => {
      const order = await api('/vending/orders', { method: 'POST', body: { machineId: m.id, items: [...cart].map(([itemId, qty]) => ({ itemId, qty })) } });
      const pay = await api(`/vending/orders/${order.id}/pay`, { method: 'POST' });
      go(pay.checkoutUrl);
    });
  });
}

export async function orderView(main, { id }, query) {
  mount(main, skeleton('block', 1));
  let o = await api(`/vending/orders/${encodeURIComponent(id)}`), timer;
  const draw = () => {
    const t = { held: ['wait', 'clock', 'Finish your order'], paid: ['', 'check', 'Ready to collect'], dispensed: ['', 'star', 'Enjoy!'], refunded: ['wait', 'wallet', 'Order refunded'],
      cancelled: ['bad', 'x', 'Order cancelled'], expired: ['bad', 'x', 'Order expired'], failed: ['bad', 'x', 'Payment did not go through'] }[o.status];
    mount(main, html`<div class="status-hero ${t[0]} ${query.get('paying') && o.status === 'paid' ? 'celebrate' : ''}"><div class="icon">${icon(t[1])}</div><h1>${t[2]}</h1>
      ${o.status === 'paid' ? html`<p class="muted">Enter this code on the machine keypad.</p>` : o.status === 'held' ? html`<a class="btn primary" href="#/vending/${o.machine.id}">Back to the menu</a>` : ''}</div>
      ${o.status === 'paid' ? html`<div class="ticket"><div class="ticket-top"><div class="ticket-sport">${o.machine.name}</div><h2>${o.machine.location || o.venue.name}</h2><div class="ticket-when">${o.venue.name}</div></div>
        <div class="ticket-tear" aria-hidden="true"></div><div class="ticket-bottom"><div class="pickup-code" aria-label="Pickup code ${o.pickupCode.split('').join(' ')}">${o.pickupCode}</div>
        <div class="faint">Single use. Valid only at ${o.machine.name}.</div></div></div>` : ''}
      <div class="card" style="margin-top:16px"><div class="list">${o.items.map(i => html`<div class="row between"><span>${i.qty}× ${i.name}</span><span>${money(i.price * i.qty)}</span></div>`)}</div>
        <hr><div class="row between"><b>Total</b><b>${money(o.amount)}</b></div><div class="faint" style="margin-top:6px">Order ${o.ref} · ${fmtDateTime(o.createdAt)}</div></div>
      <div class="row" style="margin-top:12px"><a class="btn small" href="#/vending/${o.machine.id}">Order more</a><a class="btn small ghost" href="#/support/new">${icon('chat')}Get help</a></div>`);
  };
  draw();
  // Poll while something can still change (payment confirming, waiting to be collected).
  if (['held', 'paid'].includes(o.status)) {
    timer = setInterval(async () => { try { const n = await api(`/vending/orders/${id}`); if (n.status !== o.status) { o = n; draw(); } } catch {} }, 4000);
    onLeave(() => clearInterval(timer));
  }
}
