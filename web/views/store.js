// Shop and Rent at Thidal: browse by category, add to a cart, pay in the app and collect at the front desk with a code.
// Rentals are booked for a date (per game, or per day for take-home items) and carry a refundable deposit.
import {
  $, $$, addDays, api, busy, confirmDialog, dayLabel, empty, errorView, fmtDate, fmtDateTime, go, html, icon, money, mount, on, onLeave, plural, raw, sheet, skeleton, state, store, titleCase, toast, todayIn, uid,
} from '../lib.js';
import { getSite } from './turf.js';
import { qrSvg } from '../qr.js';

const CAT = { accessories: ['🎒', 'Accessories'], equipment: ['🏏', 'Equipment'], clothing: ['👕', 'Clothing'], footwear: ['👟', 'Footwear'], books: ['📚', 'Books'], nutrition: ['🍫', 'Nutrition'] };
const cartKey = mode => `tc.cart.${mode}`;
const loadCart = mode => store.get(cartKey(mode), { lines: [], date: null, days: 1 });
const saveCart = (mode, c) => store.set(cartKey(mode), c);
const priceLabel = (i, mode) => mode === 'buy' ? money(i.salePrice) : `${money(i.rentPrice)} / ${i.rentUnit}`;

export async function storeView(main, _p, query, mode = 'buy') {
  mount(main, html`${skeleton('block', 1)}${skeleton('card', 3)}`);
  const site = await getSite(), v = site.venue, today = todayIn(v.timezone);
  let cart = loadCart(mode), category = query.get('category') || '', data;
  if (mode === 'rent' && (!cart.date || cart.date < today)) cart.date = today;
  const rent = mode === 'rent';

  mount(main, html`
    <section class="store-head">
      <span class="eyebrow">At Thidal · ${v.name}</span>
      <h1>${rent ? 'Rent gear for your game' : 'Shop the front desk'}</h1>
      <p class="muted">${rent ? 'Boots, racquets and kits ready at the desk. Pay online, collect with a code, and get your deposit back when you return it.' : 'Accessories, clothing, books and more. Pay online and collect at the front desk with a code. No queue.'}</p>
      <div class="seg labelled store-mode" role="group" aria-label="Shop or rent">
        <a href="#/shop" ${!rent ? raw('aria-current="page"') : ''}>${icon('bag')}<span>Buy</span></a>
        <a href="#/rent" ${rent ? raw('aria-current="page"') : ''}>${icon('key')}<span>Rent</span></a>
      </div>
    </section>
    ${rent ? html`<div class="date-strip" role="group" aria-label="Rental date">${Array.from({ length: 8 }, (_, i) => addDays(today, i)).map(d => html`
      <button class="date-pill" data-date="${d}" aria-pressed="${d === cart.date}"><span>${d === today ? 'Today' : fmtDate(d).split(',')[0]}</span><b>${Number(d.slice(8))}</b><span>${fmtDate(d).split(' ')[2] || ''}</span></button>`)}</div>` : ''}
    <div class="cats" id="cats" role="group" aria-label="Category"></div>
    <div id="mine"></div>
    <div id="grid" class="product-grid" aria-live="polite"></div>
    <div id="cartbar"></div>`);

  async function load() {
    const qs = new URLSearchParams({ venueId: v.id, mode }); if (rent) qs.set('date', cart.date);
    try { data = await api(`/store/items?${qs}`); } catch (e) { mount($('#grid', main), errorView(e)); $('[data-retry]', main).onclick = load; return; }
    draw();
  }
  function draw() {
    const counts = Object.fromEntries(data.categories.map(c => [c, data.items.filter(i => i.category === c).length]));
    mount($('#cats', main), html`<button class="cat" data-cat="" aria-pressed="${!category}"><span class="cat-ico" aria-hidden="true">🏟️</span>All<small>${data.items.length}</small></button>
      ${data.categories.filter(c => counts[c]).map(c => html`<button class="cat" data-cat="${c}" aria-pressed="${category === c}"><span class="cat-ico" aria-hidden="true">${CAT[c][0]}</span>${CAT[c][1]}<small>${counts[c]}</small></button>`)}`);
    const items = data.items.filter(i => !category || i.category === category);
    mount($('#grid', main), items.length ? items.map(i => {
      const left = rent ? i.rentFree : i.inStock, inCart = cart.lines.filter(l => l.itemId === i.id).reduce((a, l) => a + l.qty, 0);
      return html`<article class="product">
        <div class="p-art" aria-hidden="true">${i.emoji || CAT[i.category][0]}</div>
        ${i.sport ? html`<span class="tag p-sport">${titleCase(i.sport)}</span>` : ''}
        <h3>${i.name}</h3><p class="muted">${i.description}</p>
        <div class="p-price"><b class="mono">${priceLabel(i, mode)}</b>${rent && i.deposit ? html`<span class="faint">+ ${money(i.deposit)} deposit, refunded on return</span>` : ''}</div>
        <div class="p-foot">
          ${i.sizes.length ? html`<label class="sr-only" for="sz-${i.id}">Size for ${i.name}</label><select id="sz-${i.id}" class="p-size"><option value="">Size</option>${i.sizes.map(s => html`<option>${s}</option>`)}</select>` : html`<span class="faint">${left > 0 ? (rent ? `${left} free ${dayLabel(cart.date, today).toLowerCase() === 'today' ? 'today' : 'that day'}` : `${left} in stock`) : ''}</span>`}
          ${left > 0 ? html`<button class="btn small primary" data-add="${i.id}">${inCart ? `Add (${inCart})` : 'Add'}</button>` : html`<span class="tag warn">${rent ? 'All hired out' : 'Sold out'}</span>`}
        </div></article>`;
    }) : empty('bag', 'Nothing here yet', rent ? 'No gear for hire in this category.' : 'Nothing for sale in this category.'));
    drawBar();
  }
  function totals() {
    const lines = cart.lines.map(l => ({ ...l, item: data?.items.find(i => i.id === l.itemId) })).filter(l => l.item);
    const days = rent && lines.every(l => l.item.rentUnit === 'day') ? cart.days : 1;
    const sub = lines.reduce((a, l) => a + (rent ? l.item.rentPrice * days : l.item.salePrice) * l.qty, 0);
    const dep = rent ? lines.reduce((a, l) => a + l.item.deposit * l.qty, 0) : 0;
    return { lines, days, sub, dep, count: lines.reduce((a, l) => a + l.qty, 0) };
  }
  function drawBar() {
    const t = totals();
    mount($('#cartbar', main), t.count ? html`<button class="cart-bar" id="open-cart"><span><b>${plural(t.count, 'item')}</b> · <span class="mono">${money(t.sub + t.dep)}</span></span><span>View ${rent ? 'hire' : 'cart'} →</span></button>` : '');
  }
  function add(itemId) {
    const i = data.items.find(x => x.id === itemId), size = $(`#sz-${itemId}`, main)?.value || '';
    if (i.sizes.length && !size) { toast(`Pick a size for ${i.name}`, 'bad'); $(`#sz-${itemId}`, main).focus(); return; }
    const line = cart.lines.find(l => l.itemId === itemId && l.size === size);
    const left = rent ? i.rentFree : i.inStock, have = cart.lines.filter(l => l.itemId === itemId).reduce((a, l) => a + l.qty, 0);
    if (have >= Math.min(left, 5)) { toast(left <= have ? `Only ${left} available` : 'Up to 5 of each item', 'bad'); return; }
    if (line) line.qty++; else cart.lines.push({ itemId, size, qty: 1 });
    saveCart(mode, cart); draw(); toast(`Added ${i.name}${size ? ` (${size})` : ''}`);
  }
  function openCart() {
    const s = sheet({ title: rent ? 'Your hire' : 'Your cart', body: '', foot: '' });
    const body = $('.sheet-body', s.el);
    const render = () => {
      const t = totals();
      if (!t.count) { s.close(); return; }
      const dayItems = t.lines.some(l => l.item.rentUnit === 'day'), gameItems = t.lines.some(l => l.item.rentUnit === 'game');
      mount(body, html`<div class="list">${t.lines.map((l, n) => html`<div class="list-item"><span class="p-art small" aria-hidden="true">${l.item.emoji || CAT[l.item.category][0]}</span>
          <div class="grow"><div class="title">${l.item.name}</div><div class="faint">${l.size ? `Size ${l.size} · ` : ''}${priceLabel(l.item, mode)}${rent && l.item.deposit ? ` · ${money(l.item.deposit)} deposit` : ''}</div></div>
          <div class="qty" role="group" aria-label="Quantity of ${l.item.name}"><button class="icon-btn" data-dec="${n}" aria-label="One fewer">−</button><span class="mono">${l.qty}</span><button class="icon-btn" data-inc="${n}" aria-label="One more">+</button></div></div>`)}</div>
        ${rent ? html`<div class="field section"><span class="label">When</span><div class="row"><b>${fmtDate(cart.date)}</b>
          ${dayItems && !gameItems ? html`<label class="sr-only" for="days">Days</label><select id="days" style="width:auto">${[1, 2, 3, 4, 5, 6, 7].map(d => html`<option value="${d}" ${d === cart.days ? 'selected' : ''}>${plural(d, 'day')}</option>`)}</select>`
            : html`<span class="faint">${gameItems && dayItems ? 'Per-game items are hired for one day' : 'For your game that day'}</span>`}</div></div>` : ''}
        <div class="price-lines section"><div class="line"><span>${rent ? `Hire${t.days > 1 ? ` (${t.days} days)` : ''}` : 'Items'}</span><span class="mono">${money(t.sub)}</span></div>
          ${rent ? html`<div class="line"><span>Refundable deposit</span><span class="mono">${money(t.dep)}</span></div>` : ''}
          <div class="line total"><span>Pay now</span><span class="mono">${money(t.sub + t.dep)}</span></div>
          <div class="faint">${rent ? 'Collect at the front desk with your code. The deposit comes back to your payment method when you return the gear.' : 'Collect at the front desk with your code. Final price, no extra fees.'}</div></div>
        <p class="form-error" id="cart-err" role="alert"></p>
        <button class="btn accent block" id="checkout" style="min-height:50px">Pay ${money(t.sub + t.dep)}</button>`);
    };
    on(body, 'click', '[data-inc],[data-dec]', (_e, b) => {
      const n = Number(b.dataset.inc ?? b.dataset.dec), l = cart.lines[n];
      if (b.dataset.inc !== undefined) { const i = data.items.find(x => x.id === l.itemId), left = rent ? i.rentFree : i.inStock; if (cart.lines.filter(x => x.itemId === l.itemId).reduce((a, x) => a + x.qty, 0) < Math.min(left, 5)) l.qty++; }
      else if (--l.qty <= 0) cart.lines.splice(n, 1);
      saveCart(mode, cart); render(); draw();
    });
    on(body, 'change', '#days', (_e, sel) => { cart.days = Number(sel.value); saveCart(mode, cart); render(); drawBar(); });
    on(body, 'click', '#checkout', (_e, b) => {
      if (!state.token) { s.close(); toast('Sign in to pay — your cart is saved'); return go(`#/login?next=${encodeURIComponent(location.hash)}`); }
      busy(b, async () => {
        const t = totals();
        try {
          const o = await api('/store/orders', { method: 'POST', idempotencyKey: uid(), body: { venueId: v.id, kind: rent ? 'rental' : 'purchase', startDate: cart.date, days: t.days, items: t.lines.map(l => ({ itemId: l.itemId, size: l.size, qty: l.qty })) } });
          const pay = await api(`/store/orders/${o.id}/pay`, { method: 'POST' });
          cart = { lines: [], date: cart.date, days: 1 }; saveCart(mode, cart); s.close(); go(pay.checkoutUrl);
        } catch (e) { $('#cart-err', body).textContent = e.message; if (e.status === 409) load(); }
      });
    });
    render();
  }

  on(main, 'click', '[data-cat]', (_e, b) => { category = b.dataset.cat; draw(); });
  on(main, 'click', '[data-add]', (_e, b) => add(b.dataset.add));
  on(main, 'click', '#open-cart', openCart);
  on(main, 'click', '[data-date]', (_e, b) => { cart.date = b.dataset.date; saveCart(mode, cart); $$('[data-date]', main).forEach(x => x.setAttribute('aria-pressed', x === b)); load(); });
  await load();
  if (state.token) api('/store/orders/mine').then(list => {
    const open = list.filter(o => ['paid', 'out'].includes(o.status) && (rent ? o.kind === 'rental' : o.kind === 'purchase'));
    if (!open.length) return;
    mount($('#mine', main), html`<div class="list" style="margin-bottom:14px">${open.map(o => html`<a class="list-item" href="#/shop/order/${o.id}"><span class="p-art small" aria-hidden="true">${o.items[0]?.emoji || '🛍️'}</span>
      <div class="grow"><div class="title">${o.items.map(i => `${i.qty}× ${i.name}`).join(', ')}</div><div class="faint">${o.kind === 'rental' ? `${o.status === 'out' ? (o.overdue ? 'Overdue — please return' : `Out until ${fmtDate(o.endDate)}`) : `Collect on ${fmtDate(o.startDate)}`}` : 'Ready to collect'}</div></div>
      ${o.status === 'paid' ? html`<span class="tag good mono">${o.pickupCode}</span>` : html`<span class="tag ${o.overdue ? 'bad' : 'warn'}">${o.overdue ? 'Overdue' : 'Out'}</span>`}</a>`)}</div>`);
  }).catch(() => {});
}

export const shopView = (main, p, q) => storeView(main, p, q, 'buy');
export const rentView = (main, p, q) => storeView(main, p, q, 'rent');

export async function storeOrderView(main, { id }) {
  mount(main, skeleton('block', 1));
  let o = await api(`/store/orders/${encodeURIComponent(id)}`);
  const draw = () => {
    const rental = o.kind === 'rental';
    const t = { held: ['wait', 'clock', 'Finish your order'], paid: ['', 'check', rental ? 'Hire confirmed' : 'Ready to collect'], collected: ['', 'star', 'Collected — enjoy!'], out: ['', 'clock', o.overdue ? 'Please return your hire' : 'Enjoy your game'],
      returned: ['', 'check', 'Returned — thank you'], refunded: ['wait', 'wallet', 'Order refunded'], cancelled: ['bad', 'x', 'Order cancelled'], expired: ['bad', 'x', 'Order expired'], failed: ['bad', 'x', 'Payment did not go through'] }[o.status];
    mount(main, html`<div class="status-hero ${t[0]}"><div class="icon">${icon(t[1])}</div><h1>${t[2]}</h1>
        ${o.status === 'paid' ? html`<p class="muted">Show this code at the ${o.venue.name} front desk${rental ? ` on ${fmtDate(o.startDate)}` : ''}.</p>` : ''}
        ${o.status === 'out' ? html`<p class="muted">Return it to the front desk by the end of ${fmtDate(o.endDate)} to get your ${money(o.deposit)} deposit back.</p>` : ''}
        ${o.status === 'held' ? html`<a class="btn primary" href="${rental ? '#/rent' : '#/shop'}">Back to the ${rental ? 'rentals' : 'shop'}</a>` : ''}</div>
      ${o.status === 'paid' ? html`<div class="ticket"><div class="ticket-top"><div class="ticket-sport">${rental ? 'Rental' : 'Shop order'}</div><h2>${o.venue.name}</h2><div class="ticket-when">${rental ? `${fmtDate(o.startDate)}${o.endDate !== o.startDate ? ` – ${fmtDate(o.endDate)}` : ''}` : 'Front desk'}</div></div>
        <div class="ticket-tear" aria-hidden="true"></div><div class="ticket-bottom">${html`<div class="qr">${qrSvgSafe(o.pickupCode)}</div>`}<div class="pickup-code" aria-label="Pickup code ${o.pickupCode.split('').join(' ')}">${o.pickupCode}</div>
        <div class="faint">Ref ${o.ref}. Single use.</div></div></div>` : ''}
      <div class="card" style="margin-top:16px"><div class="list">${o.items.map(i => html`<div class="row between nowrap"><span>${i.emoji || ''} ${i.qty}× ${i.name}${i.size ? ` (${i.size})` : ''}${i.days > 1 ? ` · ${i.days} days` : ''}</span><span class="mono">${money(i.price * i.qty)}</span></div>`)}</div><hr>
        <div class="price-lines">${rental ? html`<div class="line"><span>Hire</span><span class="mono">${money(o.subtotal)}</span></div><div class="line"><span>Deposit</span><span class="mono">${money(o.deposit)}</span></div>` : ''}
          <div class="line total"><span>Paid</span><span class="mono">${money(o.amount)}</span></div>
          ${o.payment?.refunded ? html`<div class="line" style="color:var(--brand)"><span>Refunded</span><span class="mono">${money(o.payment.refunded)}</span></div>` : ''}
          ${o.depositKept ? html`<div class="line"><span>Deposit kept: ${o.returnNote}</span><span class="mono">${money(o.depositKept)}</span></div>` : ''}</div>
        <div class="faint" style="margin-top:6px">Order ${o.ref} · ${fmtDateTime(o.createdAt)}</div></div>
      <div class="row" style="margin-top:12px">${o.status === 'held' ? html`<button class="btn primary small" id="pay">Pay ${money(o.amount)}</button><button class="btn small" id="cancel">Cancel</button>` : html`<a class="btn small" href="${rental ? '#/rent' : '#/shop'}">${rental ? 'Hire more' : 'Shop more'}</a>`}
        <a class="btn small ghost" href="#/support/new">${icon('chat')}Get help</a></div>`);
    $('#pay', main)?.addEventListener('click', e => busy(e.currentTarget, async () => go((await api(`/store/orders/${o.id}/pay`, { method: 'POST' })).checkoutUrl)));
    $('#cancel', main)?.addEventListener('click', async () => { if (await confirmDialog('Cancel this unpaid order?', { confirmLabel: 'Cancel order', danger: true })) { o = await api(`/store/orders/${o.id}/cancel`, { method: 'POST' }); draw(); } });
  };
  draw();
  if (['held', 'paid', 'out'].includes(o.status)) {
    const timer = setInterval(async () => { try { const n = await api(`/store/orders/${id}`); if (n.status !== o.status) { o = n; draw(); } } catch {} }, 4000);
    onLeave(() => clearInterval(timer));
  }
}
// The pickup code is 6 digits, well within the QR encoder's limit; fall back to the code alone if it ever is not.
function qrSvgSafe(code) { try { return raw(qrSvg(code, 140)); } catch { return ''; } }
