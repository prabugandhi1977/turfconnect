// Snack and coffee vending machines: device telemetry (stock, temperature, faults), player pre-orders with payment, and
// pickup-code dispensing. Machines authenticate with a per-machine API key; players pay through the same signed-webhook
// path as bookings. Stock is "reserved" by held and paid-but-uncollected orders so two players can never order the last item.
import { createHash, randomBytes } from 'node:crypto';
import { all, id, now, one, parseJson, run, transaction } from './db.js';
import { config } from './config.js';
import { safeEqual, randomCode } from './security.js';
import { HttpError, bad, conflict, notFound } from './validate.js';
import { notify } from './notify.js';
import { audit } from './audit.js';
import { publishUser } from './events.js';
import { createIntent, refundPayment } from './payments.js';

export const ONLINE_WINDOW_MS = 3 * 60 * 1000;
const HOLD_MS = 5 * 60 * 1000, MAX_QTY = 4, MAX_TOTAL = 8, MAX_HELD = 2;
const money = p => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0 })}`;
const keyHash = key => createHash('sha256').update(key).digest('hex');
export function newMachineKey() { const key = 'vm_' + randomBytes(18).toString('hex'); return { key, hash: keyHash(key) }; }

export function machineAuth(machineId, key) {
  const m = one('SELECT * FROM vending_machines WHERE id=? AND active=1', machineId);
  if (!m || !key || !safeEqual(keyHash(String(key)), m.key_hash)) throw new HttpError(401, 'Invalid machine key');
  return m;
}

// ---- Machine state ------------------------------------------------------------------------------------------------
const openFaults = machineId => all('SELECT id,code,message,severity,opened_at FROM vending_faults WHERE machine_id=? AND resolved_at IS NULL ORDER BY opened_at', machineId);
export function machineStatus(m, faults = openFaults(m.id)) {
  if (!m.last_seen_at || Date.now() - m.last_seen_at > ONLINE_WINDOW_MS) return 'offline';
  return faults.some(f => f.severity === 'critical') ? 'fault' : 'online';
}
function reservedMap(machineId) {
  const rows = all("SELECT items FROM vending_orders WHERE machine_id=? AND (status='paid' OR (status='held' AND hold_expires_at>=?))", machineId, Date.now());
  const out = {};
  for (const r of rows) for (const it of parseJson(r.items, [])) out[it.itemId] = (out[it.itemId] || 0) + it.qty;
  return out;
}

export function machineView(m, { staff = false } = {}) {
  const faults = openFaults(m.id), reserved = reservedMap(m.id);
  const venue = one('SELECT id,name,slug,city FROM venues WHERE id=?', m.venue_id);
  const items = all('SELECT * FROM vending_items WHERE machine_id=? AND active=1 ORDER BY slot', m.id).map(i => ({
    id: i.id, slot: i.slot, name: i.name, category: i.category, price: i.price, available: Math.max(0, i.stock - (reserved[i.id] || 0)),
    low: i.stock <= i.low_at, ...(staff ? { stock: i.stock, capacity: i.capacity, lowAt: i.low_at } : {}),
  }));
  const view = {
    id: m.id, name: m.name, kind: m.kind, location: m.location, status: machineStatus(m, faults), lastSeenAt: m.last_seen_at, venue,
    items, lowStock: items.filter(i => i.low).length, soldOut: items.filter(i => i.available === 0).length,
  };
  if (staff) Object.assign(view, { temperature: m.temperature, doorOpen: !!m.door_open, active: !!m.active, faults });
  return view;
}

// ---- Alerts -------------------------------------------------------------------------------------------------------
function alertStaff(venueId, title, body) {
  const venue = one('SELECT owner_id FROM venues WHERE id=?', venueId);
  const managers = all("SELECT user_id FROM venue_staff WHERE venue_id=? AND role='manager'", venueId).map(r => r.user_id);
  for (const uid of new Set([venue?.owner_id, ...managers].filter(Boolean))) notify(uid, { kind: 'vending_alert', title, body, link: `#/owner/${venueId}/vending`, channels: ['inapp', 'email'] });
}

// ---- Device telemetry ---------------------------------------------------------------------------------------------
export function heartbeat(m, body) {
  const temp = body.temperature == null ? null : Number(body.temperature);
  if (temp != null && (!Number.isFinite(temp) || temp < -40 || temp > 100)) bad('temperature is out of range');
  const stock = body.stock && typeof body.stock === 'object' && !Array.isArray(body.stock) ? body.stock : {};
  const faults = Array.isArray(body.faults) ? body.faults.slice(0, 20) : [];
  for (const f of faults) {
    if (!f || typeof f.code !== 'string' || !f.code || f.code.length > 40) bad('Each fault needs a short code');
    if (f.severity && !['warning', 'critical'].includes(f.severity)) bad('Fault severity must be warning or critical');
  }
  return transaction(() => {
    run('UPDATE vending_machines SET last_seen_at=?, temperature=?, door_open=?, alerted_offline=0, updated_at=? WHERE id=?', Date.now(), temp, body.doorOpen ? 1 : 0, now(), m.id);
    const wasOffline = m.alerted_offline === 1;
    for (const [slot, raw] of Object.entries(stock)) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 1000) bad(`Stock for slot ${slot} must be a whole number`);
      const item = one('SELECT * FROM vending_items WHERE machine_id=? AND slot=?', m.id, slot);
      if (!item || item.stock === n) continue;
      run('UPDATE vending_items SET stock=? WHERE id=?', n, item.id);
      if (item.stock > item.low_at && n <= item.low_at) alertStaff(m.venue_id, `${m.name}: ${item.name} is ${n === 0 ? 'sold out' : 'running low'}`, `Slot ${item.slot} has ${n} left. Restock soon.`);
    }
    const reported = new Set();
    for (const f of faults) {
      reported.add(f.code);
      if (one('SELECT 1 FROM vending_faults WHERE machine_id=? AND code=? AND resolved_at IS NULL', m.id, f.code)) continue;
      const severity = f.severity || 'warning';
      run('INSERT INTO vending_faults (id,machine_id,code,message,severity,opened_at) VALUES (?,?,?,?,?,?)', id(), m.id, f.code, String(f.message || '').slice(0, 200), severity, Date.now());
      alertStaff(m.venue_id, `${m.name}: ${severity === 'critical' ? 'machine fault' : 'warning'}`, `${f.code}${f.message ? ': ' + String(f.message).slice(0, 120) : ''}`);
    }
    for (const f of openFaults(m.id)) if (!reported.has(f.code)) run('UPDATE vending_faults SET resolved_at=? WHERE id=?', Date.now(), f.id);
    if (wasOffline) alertStaff(m.venue_id, `${m.name} is back online`, 'The machine has reconnected.');
    return { ok: true, serverTime: Date.now() };
  });
}

// Called from the periodic sweep: expire unpaid holds and flag machines that stopped reporting.
export function sweepVending() {
  const stale = all("SELECT * FROM vending_orders WHERE status='held' AND hold_expires_at<?", Date.now());
  for (const o of stale) {
    run("UPDATE vending_orders SET status='expired', hold_expires_at=NULL, updated_at=? WHERE id=?", now(), o.id);
    run("UPDATE order_payments SET status='cancelled', updated_at=? WHERE order_id=? AND status='requires_payment'", now(), o.id);
  }
  for (const m of all('SELECT * FROM vending_machines WHERE active=1 AND last_seen_at IS NOT NULL AND alerted_offline=0 AND last_seen_at<?', Date.now() - ONLINE_WINDOW_MS)) {
    run('UPDATE vending_machines SET alerted_offline=1 WHERE id=?', m.id);
    alertStaff(m.venue_id, `${m.name} is offline`, 'No signal from the machine for over 3 minutes. Players cannot order from it until it reconnects.');
  }
  return stale.length;
}

// ---- Orders -------------------------------------------------------------------------------------------------------
function newRef() { for (;;) { const ref = 'VO' + randomCode(7); if (!one('SELECT 1 FROM vending_orders WHERE ref=?', ref)) return ref; } }
function newPickupCode(machineId) {
  for (;;) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!one("SELECT 1 FROM vending_orders WHERE machine_id=? AND pickup_code=? AND status='paid'", machineId, code)) return code;
  }
}

export function orderView(o, { forStaff = false } = {}) {
  const m = one('SELECT id,name,location,kind,venue_id FROM vending_machines WHERE id=?', o.machine_id);
  const venue = one('SELECT id,name,slug,address,city FROM venues WHERE id=?', o.venue_id);
  const paid = o.status === 'paid' || o.status === 'dispensed';
  return {
    id: o.id, ref: o.ref, status: o.status, amount: o.amount, items: parseJson(o.items, []), createdAt: o.created_at, paidAt: o.paid_at, dispensedAt: o.dispensed_at,
    holdExpiresAt: o.status === 'held' ? o.hold_expires_at : null, pickupCode: paid && o.status === 'paid' ? o.pickup_code : '', machine: { id: m.id, name: m.name, location: m.location, kind: m.kind }, venue,
    ...(forStaff ? { customerId: o.customer_id } : {}),
  };
}

export function createOrder(user, machineId, rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) bad('Choose at least one item');
  const wanted = new Map();
  for (const r of rawItems) {
    const qty = Number(r?.qty ?? 1);
    if (typeof r?.itemId !== 'string' || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) bad(`You can order 1 to ${MAX_QTY} of each item`);
    wanted.set(r.itemId, (wanted.get(r.itemId) || 0) + qty);
  }
  if ([...wanted.values()].reduce((a, b) => a + b, 0) > MAX_TOTAL) bad(`You can order up to ${MAX_TOTAL} items at once`);
  return transaction(() => {
    sweepVending();
    const m = one('SELECT * FROM vending_machines WHERE id=? AND active=1', machineId);
    const venue = m && one('SELECT status FROM venues WHERE id=?', m.venue_id);
    if (!m || venue?.status !== 'active') notFound('Machine not found');
    if (machineStatus(m) !== 'online') conflict('This machine is not available right now. Please try another or check back soon.', 'machine_unavailable');
    if (one("SELECT COUNT(*) AS n FROM vending_orders WHERE customer_id=? AND status='held'", user.id).n >= MAX_HELD) throw new HttpError(429, 'Finish or cancel your open orders first.');
    const reserved = reservedMap(m.id), lines = [];
    for (const [itemId, qty] of wanted) {
      const item = one('SELECT * FROM vending_items WHERE id=? AND machine_id=? AND active=1', itemId, m.id);
      if (!item) bad('One of those items is not sold by this machine');
      if (item.stock - (reserved[item.id] || 0) < qty) conflict(`Sorry, ${item.name} just sold out`, 'out_of_stock');
      lines.push({ itemId: item.id, slot: item.slot, name: item.name, qty, price: item.price });
    }
    const amount = lines.reduce((sum, l) => sum + l.price * l.qty, 0), oid = id(), ts = now();
    run('INSERT INTO vending_orders (id,ref,machine_id,venue_id,customer_id,status,amount,items,hold_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      oid, newRef(), m.id, m.venue_id, user.id, 'held', amount, JSON.stringify(lines), Date.now() + HOLD_MS, ts, ts);
    audit(user.id, 'vending.order_held', 'vending_order', oid, { venueId: m.venue_id, machineId: m.id, amount });
    return orderView(one('SELECT * FROM vending_orders WHERE id=?', oid));
  });
}

export function startOrderPayment(user, orderId) {
  return transaction(() => {
    const o = one('SELECT * FROM vending_orders WHERE id=? AND customer_id=?', orderId, user.id);
    if (!o) notFound('Order not found');
    if (o.status !== 'held' || o.hold_expires_at < Date.now()) conflict(o.status === 'paid' ? 'This order is already paid' : 'This order has expired. Please order again.', 'order_expired');
    const open = one("SELECT * FROM order_payments WHERE order_id=? AND status='requires_payment'", o.id);
    if (open) return { intentId: open.intent_id, checkoutUrl: `#/pay/${open.intent_id}`, amount: open.amount };
    const intent = createIntent(o);
    run("INSERT INTO order_payments (id,order_id,provider,intent_id,amount,currency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'requires_payment',?,?)",
      id(), o.id, config.paymentProvider, intent.intentId, o.amount, config.currency, now(), now());
    return { intentId: intent.intentId, checkoutUrl: intent.checkoutUrl, amount: o.amount };
  });
}

export function cancelOrder(user, orderId) {
  const o = one('SELECT * FROM vending_orders WHERE id=? AND customer_id=?', orderId, user.id);
  if (!o) notFound('Order not found');
  if (o.status !== 'held') conflict('Only unpaid orders can be cancelled here. Paid orders can be refunded by the venue.');
  run("UPDATE vending_orders SET status='cancelled', hold_expires_at=NULL, updated_at=? WHERE id=?", now(), o.id);
  run("UPDATE order_payments SET status='cancelled', updated_at=? WHERE order_id=? AND status='requires_payment'", now(), o.id);
  return orderView(one('SELECT * FROM vending_orders WHERE id=?', o.id));
}

// Called from the verified payment webhook. Returns { ok: false } when the stock is gone, so the caller can refund.
export function confirmOrderPaid(orderId) {
  const o = one('SELECT * FROM vending_orders WHERE id=?', orderId);
  if (o.status === 'paid' || o.status === 'dispensed') return { ok: true, already: true };
  if (o.status !== 'held') {
    const reserved = reservedMap(o.machine_id);
    for (const l of parseJson(o.items, [])) {
      const item = one('SELECT stock FROM vending_items WHERE id=?', l.itemId);
      if (!item || item.stock - (reserved[l.itemId] || 0) < l.qty) return { ok: false };
    }
  }
  const code = newPickupCode(o.machine_id);
  run("UPDATE vending_orders SET status='paid', pickup_code=?, paid_at=?, hold_expires_at=NULL, updated_at=? WHERE id=?", code, now(), now(), o.id);
  const m = one('SELECT name, location FROM vending_machines WHERE id=?', o.machine_id);
  notify(o.customer_id, { kind: 'order_paid', title: 'Order paid: collect at the machine', body: `Enter code ${code} at ${m.name}${m.location ? ' (' + m.location + ')' : ''}. Order ${o.ref}.`, link: `#/order/${o.id}`, channels: ['inapp'] });
  audit(null, 'vending.order_paid', 'vending_order', o.id, { venueId: o.venue_id, amount: o.amount });
  return { ok: true };
}

export function failOrderPayment(orderId) {
  const o = one('SELECT * FROM vending_orders WHERE id=?', orderId);
  if (o.status === 'held') run("UPDATE vending_orders SET status='failed', hold_expires_at=NULL, updated_at=? WHERE id=?", now(), o.id);
}

export function refundOrder(o, { actorId = null, reason = '' } = {}) {
  const p = one("SELECT * FROM order_payments WHERE order_id=? AND status='succeeded'", o.id);
  if (!p) bad('This order has no online payment to refund');
  if (o.status === 'dispensed') conflict('This order was already collected');
  const { ref } = refundPayment(p, p.amount - p.refunded);
  run("UPDATE order_payments SET refunded=amount, status='refunded', updated_at=? WHERE id=?", now(), p.id);
  run("UPDATE vending_orders SET status='refunded', updated_at=? WHERE id=?", now(), o.id);
  notify(o.customer_id, { kind: 'order_refund', title: 'Order refunded', body: `${money(p.amount)} for order ${o.ref} is on its way back to your payment method. ${reason}`.trim(), link: `#/order/${o.id}`, channels: ['inapp', 'email'] });
  audit(actorId, 'vending.order_refunded', 'vending_order', o.id, { venueId: o.venue_id, amount: p.amount, reason, providerRef: ref });
  publishUser(o.customer_id, 'order', { id: o.id, status: 'refunded' });
}

// ---- Dispensing (machine presents the pickup code) ----------------------------------------------------------------
export function dispense(m, code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) bad('Pickup codes are 6 digits', 'bad_code');
  return transaction(() => {
    const o = one("SELECT * FROM vending_orders WHERE machine_id=? AND pickup_code=? AND status='paid'", m.id, c);
    if (!o) bad('That code is not valid or has already been used', 'bad_code');
    const lines = parseJson(o.items, []);
    for (const l of lines) {
      const item = one('SELECT * FROM vending_items WHERE id=?', l.itemId);
      if (!item) continue;
      const left = Math.max(0, item.stock - l.qty);
      run('UPDATE vending_items SET stock=? WHERE id=?', left, item.id);
      if (item.stock > item.low_at && left <= item.low_at) alertStaff(m.venue_id, `${m.name}: ${item.name} is ${left === 0 ? 'sold out' : 'running low'}`, `Slot ${item.slot} has ${left} left. Restock soon.`);
    }
    run("UPDATE vending_orders SET status='dispensed', dispensed_at=?, updated_at=? WHERE id=?", now(), now(), o.id);
    publishUser(o.customer_id, 'order', { id: o.id, status: 'dispensed' });
    audit(null, 'vending.dispensed', 'vending_order', o.id, { venueId: o.venue_id, machineId: m.id });
    return { ok: true, ref: o.ref, dispense: lines.map(l => ({ slot: l.slot, name: l.name, qty: l.qty })) };
  });
}

// ---- Demo simulator: keeps demo machines reporting (re-reports their open faults so they persist until resolved) --------
export function simulateMachines() {
  for (const m of all('SELECT * FROM vending_machines WHERE active=1 AND alerted_offline=0')) {
    const faults = openFaults(m.id).map(f => ({ code: f.code, message: f.message, severity: f.severity }));
    try { heartbeat(m, { temperature: m.kind === 'coffee' ? 82 + Math.round(Math.random() * 4) : 4 + Math.round(Math.random() * 20) / 10, doorOpen: false, stock: {}, faults }); }
    catch (e) { console.error('Vending simulator:', e.message); }
  }
}

// ---- Sales summary for the venue dashboard ------------------------------------------------------------------------
export function vendingSummary(venueId, days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const orders = all("SELECT items, amount, status, created_at FROM vending_orders WHERE venue_id=? AND created_at>=? AND status IN ('paid','dispensed')", venueId, since);
  const top = new Map();
  for (const o of orders) for (const l of parseJson(o.items, [])) top.set(l.name, (top.get(l.name) || 0) + l.qty);
  return { days, orders: orders.length, revenue: orders.reduce((s, o) => s + o.amount, 0), top: [...top].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty })) };
}
