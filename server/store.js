// Shop and rentals at the front desk. Players buy or hire items in the app, pay through the same signed-webhook path as
// bookings, and collect at the desk with a 6-digit code. Stock is reserved by held and paid-but-uncollected purchases;
// a rental unit is counted against every day it is booked (and for as long as it is still out), so the same unit is
// never hired twice. A rental's deposit is refunded when staff mark it returned, less anything kept for damage.
import { all, id, now, one, parseJson, run, transaction } from './db.js';
import { config } from './config.js';
import { randomCode } from './security.js';
import { HttpError, bad, conflict, notFound } from './validate.js';
import { notify } from './notify.js';
import { audit } from './audit.js';
import { publishUser } from './events.js';
import { createIntent, refundPayment } from './payments.js';
import { addDays, daysBetween, venueToday } from './time.js';

export const CATEGORIES = ['accessories', 'equipment', 'clothing', 'footwear', 'books', 'nutrition'];
const HOLD_MS = 10 * 60 * 1000, MAX_QTY = 5, MAX_LINES = 10, MAX_HELD = 2, MAX_RENT_DAYS = 7, RENT_AHEAD_DAYS = 14;
const money = p => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0 })}`;
const niceDate = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const LIVE_PURCHASE = "(o.status='paid' OR (o.status='held' AND o.hold_expires_at>=?))";

// ---- Availability -------------------------------------------------------------------------------------------------
function reservedForSale(venueId) {
  const out = {};
  for (const o of all(`SELECT o.items FROM store_orders o WHERE o.venue_id=? AND o.kind='purchase' AND ${LIVE_PURCHASE}`, venueId, Date.now()))
    for (const l of parseJson(o.items, [])) out[l.itemId] = (out[l.itemId] || 0) + l.qty;
  return out;
}
// Units of each item already hired on any day of [start, end], plus units still out (overdue ones included).
function rentedBetween(venueId, start, end, ignoreOrderId = null) {
  const out = {};
  const rows = all(`SELECT o.items FROM store_orders o WHERE o.venue_id=? AND o.kind='rental' AND o.id IS NOT ?
    AND (o.status='out' OR ((o.status='paid' OR (o.status='held' AND o.hold_expires_at>=?)) AND o.start_date<=? AND o.end_date>=?))`, venueId, ignoreOrderId, Date.now(), end, start);
  for (const o of rows) for (const l of parseJson(o.items, [])) out[l.itemId] = (out[l.itemId] || 0) + l.qty;
  return out;
}

export function itemView(i, { reserved = {}, rented = null, staff = false } = {}) {
  const view = {
    id: i.id, category: i.category, name: i.name, description: i.description, emoji: i.emoji, sport: i.sport, sizes: parseJson(i.sizes, []),
    forSale: i.sale_price != null, salePrice: i.sale_price, inStock: i.sale_price != null ? Math.max(0, i.stock - (reserved[i.id] || 0)) : 0,
    forRent: i.rent_price != null, rentPrice: i.rent_price, rentUnit: i.rent_unit, deposit: i.deposit,
    rentFree: i.rent_price != null && rented ? Math.max(0, i.rent_stock - (rented[i.id] || 0)) : null,
  };
  if (staff) Object.assign(view, { stock: i.stock, rentStock: i.rent_stock, active: !!i.active });
  return view;
}

export function catalogue(venueId, { mode = null, category = null, date = null, staff = false } = {}) {
  let rows = all(`SELECT * FROM store_items WHERE venue_id=? ${staff ? '' : 'AND active=1'} ORDER BY category, name`, venueId);
  if (mode === 'buy') rows = rows.filter(r => r.sale_price != null);
  if (mode === 'rent') rows = rows.filter(r => r.rent_price != null);
  if (category) rows = rows.filter(r => r.category === category);
  const venue = one('SELECT * FROM venues WHERE id=?', venueId);
  const day = date || venueToday(venue);
  const reserved = reservedForSale(venueId), rented = rentedBetween(venueId, day, day);
  return rows.map(r => itemView(r, { reserved, rented, staff }));
}

// ---- Orders ---------------------------------------------------------------------------------------------------------
function newRef() { for (;;) { const ref = 'SO' + randomCode(7); if (!one('SELECT 1 FROM store_orders WHERE ref=?', ref)) return ref; } }
function newPickupCode(venueId) {
  for (;;) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!one("SELECT 1 FROM store_orders WHERE venue_id=? AND pickup_code=? AND status IN ('paid','out')", venueId, code)) return code;
  }
}

export function orderView(o, { staff = false } = {}) {
  const venue = one('SELECT id,name,slug,address,city,phone FROM venues WHERE id=?', o.venue_id);
  const p = one('SELECT amount, refunded, status FROM store_payments WHERE order_id=? ORDER BY created_at DESC', o.id);
  const today = venueToday(one('SELECT timezone FROM venues WHERE id=?', o.venue_id));
  return {
    id: o.id, ref: o.ref, kind: o.kind, status: o.status, items: parseJson(o.items, []), subtotal: o.subtotal, deposit: o.deposit, amount: o.amount,
    startDate: o.start_date, endDate: o.end_date, overdue: o.status === 'out' && o.end_date < today,
    pickupCode: ['paid', 'out'].includes(o.status) ? o.pickup_code : '', holdExpiresAt: o.status === 'held' ? o.hold_expires_at : null,
    depositKept: o.deposit_kept, returnNote: o.return_note, createdAt: o.created_at, paidAt: o.paid_at, handedAt: o.handed_at, returnedAt: o.returned_at,
    payment: p ? { amount: p.amount, refunded: p.refunded, status: p.status } : null, venue,
    ...(staff ? { customer: one('SELECT name, phone FROM users WHERE id=?', o.customer_id) } : {}),
  };
}

export function createStoreOrder(user, { venueId, kind, items: rawItems, startDate, days }) {
  if (!['purchase', 'rental'].includes(kind)) bad('Choose buy or rent');
  if (!Array.isArray(rawItems) || !rawItems.length) bad('Your cart is empty');
  if (rawItems.length > MAX_LINES) bad(`Up to ${MAX_LINES} different items per order`);
  return transaction(() => {
    sweepStore();
    const venue = one("SELECT * FROM venues WHERE id=? AND status='active'", venueId);
    if (!venue) notFound('This venue is not taking orders right now');
    if (one("SELECT COUNT(*) AS n FROM store_orders WHERE customer_id=? AND status='held'", user.id).n >= MAX_HELD) throw new HttpError(429, 'Finish or cancel your open orders first.');
    let start = null, end = null, nDays = 1;
    if (kind === 'rental') {
      const today = venueToday(venue);
      start = String(startDate || today);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) bad('Pick a rental date');
      const ahead = daysBetween(today, start);
      if (ahead < 0) bad('Rental date has passed');
      if (ahead > RENT_AHEAD_DAYS) bad(`Rentals can be booked up to ${RENT_AHEAD_DAYS} days ahead`);
      nDays = Number(days || 1);
      if (!Number.isInteger(nDays) || nDays < 1 || nDays > MAX_RENT_DAYS) bad(`Hire for 1 to ${MAX_RENT_DAYS} days`);
      end = addDays(start, nDays - 1);
    }
    const reserved = kind === 'purchase' ? reservedForSale(venue.id) : null, rented = kind === 'rental' ? rentedBetween(venue.id, start, end) : null;
    const want = new Map(), lines = [];
    for (const r of rawItems) {
      const qty = Number(r?.qty ?? 1);
      if (typeof r?.itemId !== 'string' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) bad(`You can take 1 to ${MAX_QTY} of each item`);
      const item = one('SELECT * FROM store_items WHERE id=? AND venue_id=? AND active=1', r.itemId, venue.id);
      if (!item) bad('One of those items is not available here');
      const sizes = parseJson(item.sizes, []);
      const size = sizes.length ? String(r.size || '') : '';
      if (sizes.length && !sizes.includes(size)) bad(`Pick a size for ${item.name}`);
      want.set(item.id, (want.get(item.id) || 0) + qty);
      if (kind === 'purchase') {
        if (item.sale_price == null) bad(`${item.name} is not for sale`);
        if (item.stock - (reserved[item.id] || 0) < want.get(item.id)) conflict(`Sorry, only ${Math.max(0, item.stock - (reserved[item.id] || 0))} ${item.name} left`, 'out_of_stock');
        lines.push({ itemId: item.id, name: item.name, emoji: item.emoji, size, qty, price: item.sale_price });
      } else {
        if (item.rent_price == null) bad(`${item.name} is not for hire`);
        if (item.rent_unit === 'game' && nDays > 1) bad(`${item.name} is hired per game, for one day at a time`);
        if (item.rent_stock - (rented[item.id] || 0) < want.get(item.id)) conflict(`Sorry, ${item.name} is fully hired out for those dates`, 'not_available');
        lines.push({ itemId: item.id, name: item.name, emoji: item.emoji, size, qty, price: item.rent_price * nDays, unit: item.rent_unit, days: nDays, deposit: item.deposit });
      }
    }
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0), deposit = lines.reduce((s, l) => s + (l.deposit || 0) * l.qty, 0);
    const oid = id(), ts = now();
    run(`INSERT INTO store_orders (id,ref,venue_id,customer_id,kind,status,items,subtotal,deposit,amount,start_date,end_date,hold_expires_at,created_at,updated_at)
         VALUES (?,?,?,?,?,'held',?,?,?,?,?,?,?,?,?)`, oid, newRef(), venue.id, user.id, kind, JSON.stringify(lines), subtotal, deposit, subtotal + deposit, start, end, Date.now() + HOLD_MS, ts, ts);
    audit(user.id, `store.${kind}_held`, 'store_order', oid, { venueId: venue.id, amount: subtotal + deposit });
    return orderView(one('SELECT * FROM store_orders WHERE id=?', oid));
  });
}

export function startStorePayment(user, orderId) {
  return transaction(() => {
    const o = one('SELECT * FROM store_orders WHERE id=? AND customer_id=?', orderId, user.id);
    if (!o) notFound('Order not found');
    if (o.status !== 'held' || o.hold_expires_at < Date.now()) conflict(o.status === 'held' || o.status === 'expired' ? 'This order has expired. Please order again.' : 'This order is already paid', 'order_expired');
    const open = one("SELECT * FROM store_payments WHERE order_id=? AND status='requires_payment'", o.id);
    if (open) return { intentId: open.intent_id, checkoutUrl: `#/pay/${open.intent_id}`, amount: open.amount };
    const intent = createIntent(o);
    run("INSERT INTO store_payments (id,order_id,provider,intent_id,amount,currency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'requires_payment',?,?)",
      id(), o.id, config.paymentProvider, intent.intentId, o.amount, config.currency, now(), now());
    return { intentId: intent.intentId, checkoutUrl: intent.checkoutUrl, amount: o.amount };
  });
}

export function cancelStoreOrder(user, orderId) {
  const o = one('SELECT * FROM store_orders WHERE id=? AND customer_id=?', orderId, user.id);
  if (!o) notFound('Order not found');
  if (o.status !== 'held') conflict('Only unpaid orders can be cancelled here. Ask the desk to refund a paid order.');
  run("UPDATE store_orders SET status='cancelled', hold_expires_at=NULL, updated_at=? WHERE id=?", now(), o.id);
  run("UPDATE store_payments SET status='cancelled', updated_at=? WHERE order_id=? AND status='requires_payment'", now(), o.id);
  return orderView(one('SELECT * FROM store_orders WHERE id=?', o.id));
}

export function sweepStore() {
  const stale = all("SELECT id FROM store_orders WHERE status='held' AND hold_expires_at<?", Date.now());
  for (const o of stale) {
    run("UPDATE store_orders SET status='expired', hold_expires_at=NULL, updated_at=? WHERE id=?", now(), o.id);
    run("UPDATE store_payments SET status='cancelled', updated_at=? WHERE order_id=? AND status='requires_payment'", now(), o.id);
  }
  return stale.length;
}

// Called from the verified payment webhook. { ok: false } means the stock or rental units went while the player paid.
export function confirmStorePaid(orderId) {
  const o = one('SELECT * FROM store_orders WHERE id=?', orderId);
  if (['paid', 'collected', 'out', 'returned'].includes(o.status)) return { ok: true, already: true };
  if (o.status !== 'held') {
    const lines = parseJson(o.items, []);
    if (o.kind === 'purchase') {
      const reserved = reservedForSale(o.venue_id);
      for (const l of lines) { const i = one('SELECT stock FROM store_items WHERE id=?', l.itemId); if (!i || i.stock - (reserved[l.itemId] || 0) < l.qty) return { ok: false }; }
    } else {
      const rented = rentedBetween(o.venue_id, o.start_date, o.end_date, o.id);
      for (const l of lines) { const i = one('SELECT rent_stock FROM store_items WHERE id=?', l.itemId); if (!i || i.rent_stock - (rented[l.itemId] || 0) < l.qty) return { ok: false }; }
    }
  }
  const code = newPickupCode(o.venue_id);
  run("UPDATE store_orders SET status='paid', pickup_code=?, paid_at=?, hold_expires_at=NULL, updated_at=? WHERE id=?", code, now(), now(), o.id);
  const what = o.kind === 'rental' ? `Collect your hire at the front desk on ${niceDate(o.start_date)}` : 'Collect your order at the front desk';
  notify(o.customer_id, { kind: 'store_paid', title: o.kind === 'rental' ? 'Rental confirmed' : 'Order paid', body: `${what} with code ${code}. Ref ${o.ref}.`, link: `#/shop/order/${o.id}`, channels: ['inapp'] });
  audit(null, `store.${o.kind}_paid`, 'store_order', o.id, { venueId: o.venue_id, amount: o.amount });
  return { ok: true };
}

export function failStorePayment(orderId) {
  const o = one('SELECT * FROM store_orders WHERE id=?', orderId);
  if (o.status === 'held') run("UPDATE store_orders SET status='failed', hold_expires_at=NULL, updated_at=? WHERE id=?", now(), o.id);
}

function paymentOf(o) {
  const p = one("SELECT * FROM store_payments WHERE order_id=? AND status IN ('succeeded','partially_refunded')", o.id);
  if (!p) bad('This order has no online payment to refund');
  return p;
}
function refundAmount(p, amount) {
  const { ref } = refundPayment(p, amount);
  const refunded = p.refunded + amount;
  run('UPDATE store_payments SET refunded=?, status=?, updated_at=? WHERE id=?', refunded, refunded >= p.amount ? 'refunded' : 'partially_refunded', now(), p.id);
  return ref;
}

// Full refund before handover (staff decision, or automatic when stock vanished during payment).
export function refundStoreOrder(o, { actorId = null, reason = '' } = {}) {
  if (!['paid'].includes(o.status)) conflict(o.status === 'held' ? 'This order is not paid yet' : 'Only paid orders that have not been handed over can be refunded');
  const p = paymentOf(o), amount = p.amount - p.refunded;
  const providerRef = refundAmount(p, amount);
  run("UPDATE store_orders SET status='refunded', updated_at=? WHERE id=?", now(), o.id);
  notify(o.customer_id, { kind: 'store_refund', title: 'Order refunded', body: `${money(amount)} for ${o.ref} is on its way back to your payment method. ${reason}`.trim(), link: `#/shop/order/${o.id}`, channels: ['inapp', 'email'] });
  audit(actorId, 'store.refunded', 'store_order', o.id, { venueId: o.venue_id, amount, reason, providerRef });
  publishUser(o.customer_id, 'order', { id: o.id, status: 'refunded' });
}

// ---- Front desk -----------------------------------------------------------------------------------------------------
export function handOver(actor, venue, code) {
  const c = String(code || '').trim().toUpperCase();
  return transaction(() => {
    const o = /^\d{6}$/.test(c) ? one("SELECT * FROM store_orders WHERE venue_id=? AND pickup_code=? AND status='paid'", venue.id, c)
      : one("SELECT * FROM store_orders WHERE venue_id=? AND ref=?", venue.id, c);
    if (!o) notFound('No paid order with that code at this venue');
    if (o.status !== 'paid') conflict(`This order is ${o.status}`);
    if (o.kind === 'rental' && o.start_date > venueToday(venue)) conflict(`This hire starts on ${niceDate(o.start_date)}. Hand it over on the day.`);
    if (o.kind === 'purchase') for (const l of parseJson(o.items, [])) run('UPDATE store_items SET stock=MAX(0, stock-?) WHERE id=?', l.qty, l.itemId);
    run('UPDATE store_orders SET status=?, handed_at=?, updated_at=? WHERE id=?', o.kind === 'purchase' ? 'collected' : 'out', now(), now(), o.id);
    audit(actor.id, o.kind === 'purchase' ? 'store.collected' : 'store.handed_out', 'store_order', o.id, { venueId: venue.id, ref: o.ref });
    publishUser(o.customer_id, 'order', { id: o.id, status: o.kind === 'purchase' ? 'collected' : 'out' });
    return orderView(one('SELECT * FROM store_orders WHERE id=?', o.id), { staff: true });
  });
}

// Rental comes back: refund the deposit, less anything kept for damage or loss (with a note the player sees).
export function markReturned(actor, venue, orderId, { keep = 0, note = '' } = {}) {
  return transaction(() => {
    const o = one('SELECT * FROM store_orders WHERE id=? AND venue_id=?', orderId, venue.id);
    if (!o) notFound('Order not found');
    if (o.kind !== 'rental' || o.status !== 'out') conflict('Only hired items that are out can be returned');
    if (!Number.isInteger(keep) || keep < 0 || keep > o.deposit) bad(`You can keep between ₹0 and ${money(o.deposit)} of the deposit`);
    if (keep > 0 && !note.trim()) bad('Say why part of the deposit is kept');
    const back = o.deposit - keep;
    if (back > 0) refundAmount(paymentOf(o), back);
    run("UPDATE store_orders SET status='returned', returned_at=?, deposit_kept=?, return_note=?, updated_at=? WHERE id=?", now(), keep, note.trim(), now(), o.id);
    notify(o.customer_id, { kind: 'store_returned', title: 'Thanks for returning your hire', body: back ? `${money(back)} deposit is on its way back to your payment method.${keep ? ` ${money(keep)} kept: ${note.trim()}` : ''}` : `Deposit kept: ${note.trim()}`, link: `#/shop/order/${o.id}`, channels: ['inapp', 'email'] });
    audit(actor.id, 'store.returned', 'store_order', o.id, { venueId: venue.id, depositRefunded: back, kept: keep, note });
    publishUser(o.customer_id, 'order', { id: o.id, status: 'returned' });
    return orderView(one('SELECT * FROM store_orders WHERE id=?', o.id), { staff: true });
  });
}

export function storeSummary(venueId, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = all("SELECT kind, subtotal FROM store_orders WHERE venue_id=? AND paid_at>=? AND status NOT IN ('refunded')", venueId, since);
  return {
    days, sales: rows.filter(r => r.kind === 'purchase').reduce((s, r) => s + r.subtotal, 0), rentals: rows.filter(r => r.kind === 'rental').reduce((s, r) => s + r.subtotal, 0),
    out: one("SELECT COUNT(*) AS n FROM store_orders WHERE venue_id=? AND status='out'", venueId).n,
    toCollect: one("SELECT COUNT(*) AS n FROM store_orders WHERE venue_id=? AND status='paid'", venueId).n,
  };
}
