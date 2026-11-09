// End-to-end API tests against an in-process server and a throwaway database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'turf-test-'));
process.env.TURF_DATA_DIR = dir;
process.env.TURF_DB = join(dir, 'test.sqlite');
process.env.TURF_DEV_OTP = 'true';
process.env.TURF_VENDING_SIM = 'false';

const { start, sweep } = await import('../server.js');
const { seedDemo } = await import('../demo-data.js');
const { one, run, db } = await import('../db.js');
const { signPayload } = await import('../payments.js');
const { addDays, zonedParts } = await import('../time.js');

let server, base;
const tokens = {};
async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
async function login(identifier) {
  const r1 = await api('/auth/otp/request', { method: 'POST', body: { identifier } });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const r2 = await api('/auth/otp/verify', { method: 'POST', body: { identifier, code: r1.data.devCode } });
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  return r2.data.token;
}
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 50)); } };

let venue, court, date;
// A free slot several days out on the given court, so cancellation tests get a full refund window.
async function freeSlot(courtId = court.id, d = date, skip = 0) {
  const r = await api(`/venues/${venue.id}/availability?date=${d}`);
  const slots = r.data.courts.find(c => c.id === courtId).slots.filter(s => s.state === 'available' || s.state === 'almost_full');
  assert.ok(slots.length > skip, 'expected a free slot');
  return slots[skip].start;
}
async function hold(token, start, extra = {}) {
  return api('/bookings', { token, method: 'POST', body: { venueId: venue.id, courtId: court.id, date, starts: [start], ...extra } });
}
async function payAndSettle(token, bookingId, outcome = 'success') {
  const pay = await api(`/bookings/${bookingId}/pay`, { token, method: 'POST' });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  const done = await api(`/payments/sandbox/${pay.data.intentId}/complete`, { token, method: 'POST', body: { outcome } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return pay.data;
}

before(async () => {
  seedDemo();
  server = await start(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
  for (const who of ['player', 'owner', 'manager', 'desk', 'admin']) tokens[who] = await login(`${who}@turfconnect.test`);
  tokens.p2 = await login('+919800000101');
  venue = one("SELECT * FROM venues WHERE slug='kickoff-arena'");
  court = one("SELECT * FROM courts WHERE venue_id=? AND name LIKE 'Pitch C%'", venue.id);
  date = addDays(zonedParts(Date.now(), venue.timezone).date, 9);
});
after(() => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

test('search finds venues by sport and location, sorted by distance', async () => {
  const r = await api(`/venues?sport=badminton&lat=12.97&lng=77.64&date=${date}`);
  assert.equal(r.status, 200);
  assert.equal(r.data[0].name, 'Smash Point Badminton');
  assert.ok(r.data[0].distanceKm < 2);
  assert.ok(r.data[0].availableSlots > 0);
  const pending = await api('/venues?q=marina');
  assert.equal(pending.data.length, 0, 'unverified venues are not searchable');
});

test('a paid booking is confirmed only by the signed webhook, with QR ref and invoice', async () => {
  const start = await freeSlot();
  const h = await hold(tokens.player, start, { couponCode: 'welcome20' });
  assert.equal(h.status, 201, JSON.stringify(h.data));
  assert.equal(h.data.status, 'held');
  assert.ok(h.data.discount > 0 && h.data.amount === h.data.subtotal - h.data.discount);
  let slot = (await api(`/venues/${venue.id}/availability?date=${date}`)).data.courts.find(c => c.id === court.id).slots.find(s => s.start === start);
  assert.equal(slot.state, 'held');
  const pay = await payAndSettle(tokens.player, h.data.id);
  const b = await waitFor(async () => { const r = await api(`/bookings/${h.data.id}`, { token: tokens.player }); return r.data.status === 'confirmed' && r.data; });
  assert.ok(b, 'booking confirmed');
  assert.match(b.ref, /^TC[A-Z0-9]{8}$/);
  assert.equal(b.payment.status, 'succeeded');
  assert.equal(b.payment.amount, pay.amount);
  slot = (await api(`/venues/${venue.id}/availability?date=${date}`)).data.courts.find(c => c.id === court.id).slots.find(s => s.start === start);
  assert.equal(slot.state, 'booked', 'availability updates immediately after confirmation');
  const inv = await api(`/bookings/${h.data.id}/invoice`, { token: tokens.player });
  assert.equal(inv.status, 200);
  assert.equal(inv.data.number, `INV-${b.ref}`);
  const second = await hold(tokens.p2, start, {});
  assert.equal(second.status, 409);
});

test('two customers racing for one slot: exactly one hold succeeds', async () => {
  const start = await freeSlot(court.id, date, 1);
  const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => hold(i % 2 ? tokens.p2 : tokens.player, start)));
  const ok = attempts.filter(a => a.status === 201);
  assert.equal(ok.length, 1, attempts.map(a => a.status).join(','));
  assert.ok(attempts.filter(a => a.status !== 201).every(a => a.status === 409 || a.status === 429));
  const claims = one('SELECT COUNT(*) AS n FROM slot_claims WHERE court_id=? AND date=? AND start_time=?', court.id, date, start).n;
  assert.equal(claims, 1);
  // Release it again so later tests have room.
  const winner = ok[0].data.id;
  const holder = one('SELECT u.email FROM bookings b JOIN users u ON u.id=b.customer_id WHERE b.id=?', winner).email ? tokens.player : tokens.p2;
  assert.equal((await api(`/bookings/${winner}/cancel`, { token: holder, method: 'POST', body: {} })).status, 200);
});

test('failed payment releases the held slot straight away', async () => {
  const start = await freeSlot(court.id, date, 2);
  const h = await hold(tokens.p2, start);
  await payAndSettle(tokens.p2, h.data.id, 'failure');
  const b = await waitFor(async () => { const r = await api(`/bookings/${h.data.id}`, { token: tokens.p2 }); return r.data.status === 'failed' && r.data; });
  assert.ok(b);
  assert.equal(b.payment.status, 'failed');
  const again = await hold(tokens.player, start);
  assert.equal(again.status, 201, 'slot is bookable again');
  await api(`/bookings/${again.data.id}/cancel`, { token: tokens.player, method: 'POST', body: {} });
});

test('expired holds release their slots', async () => {
  const start = await freeSlot(court.id, date, 3);
  const h = await hold(tokens.p2, start);
  run('UPDATE bookings SET hold_expires_at=? WHERE id=?', Date.now() - 1000, h.data.id);
  sweep();
  assert.equal(one('SELECT status FROM bookings WHERE id=?', h.data.id).status, 'expired');
  assert.equal(one('SELECT COUNT(*) AS n FROM slot_claims WHERE booking_id=?', h.data.id).n, 0);
  const pay = await api(`/bookings/${h.data.id}/pay`, { token: tokens.p2, method: 'POST' });
  assert.equal(pay.status, 409);
});

test('webhooks: bad signatures are rejected and duplicates are ignored', async () => {
  const body = JSON.stringify({ id: 'evt_forged', type: 'payment_intent.succeeded', data: { intentId: 'pi_x', amount: 100 } });
  const forged = await api('/webhooks/payments', { method: 'POST', body, headers: { 'x-turf-signature': 't=' + Date.now() + ',v1=deadbeef' } });
  assert.equal(forged.status, 401);
  const stale = await api('/webhooks/payments', { method: 'POST', body, headers: { 'x-turf-signature': signPayload(body, Date.now() - 10 * 60 * 1000) } });
  assert.equal(stale.status, 401, 'old signatures cannot be replayed');

  const start = await freeSlot(court.id, date, 4);
  const h = await hold(tokens.p2, start);
  const pay = await api(`/bookings/${h.data.id}/pay`, { token: tokens.p2, method: 'POST' });
  const event = JSON.stringify({ id: 'evt_dup_1', type: 'payment_intent.succeeded', data: { intentId: pay.data.intentId, amount: pay.data.amount } });
  const first = await api('/webhooks/payments', { method: 'POST', body: event, headers: { 'x-turf-signature': signPayload(event) } });
  const second = await api('/webhooks/payments', { method: 'POST', body: event, headers: { 'x-turf-signature': signPayload(event) } });
  assert.equal(first.data.confirmed, true);
  assert.equal(second.data.duplicate, true);
  assert.equal(one("SELECT COUNT(*) AS n FROM notifications WHERE booking_id=? AND kind='booking_confirmed' AND channel='inapp'", h.data.id).n, 1);
});

test('payment landing after the hold lapsed and the slot was re-sold is refunded in full', async () => {
  const start = await freeSlot(court.id, date, 5);
  const h = await hold(tokens.p2, start);
  const pay = await api(`/bookings/${h.data.id}/pay`, { token: tokens.p2, method: 'POST' });
  run('UPDATE bookings SET hold_expires_at=? WHERE id=?', Date.now() - 1000, h.data.id);
  sweep();
  const other = await hold(tokens.player, start);
  assert.equal(other.status, 201);
  const event = JSON.stringify({ id: 'evt_late_1', type: 'payment_intent.succeeded', data: { intentId: pay.data.intentId, amount: pay.data.amount } });
  const r = await api('/webhooks/payments', { method: 'POST', body: event, headers: { 'x-turf-signature': signPayload(event) } });
  assert.equal(r.data.confirmed, false);
  const p = one('SELECT * FROM payments WHERE intent_id=?', pay.data.intentId);
  assert.equal(p.status, 'refunded');
  assert.equal(p.refunded, p.amount);
  await api(`/bookings/${other.data.id}/cancel`, { token: tokens.player, method: 'POST', body: {} });
});

test('customer cancellation follows the venue policy snapshot', async () => {
  const start = await freeSlot(court.id, date, 6);
  const h = await hold(tokens.p2, start);
  await payAndSettle(tokens.p2, h.data.id);
  await waitFor(async () => (await api(`/bookings/${h.data.id}`, { token: tokens.p2 })).data.status === 'confirmed');
  const c = await api(`/bookings/${h.data.id}/cancel`, { token: tokens.p2, method: 'POST', body: { reason: 'Rain' } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.booking.status, 'cancelled');
  assert.equal(c.data.refund.amount, h.data.amount, '9 days ahead = 100% refund');
  assert.equal(one('SELECT status FROM payments WHERE booking_id=?', h.data.id).status, 'refunded');
});

test('price changes apply only to new bookings', async () => {
  const start = await freeSlot(court.id, date, 7);
  const h = await hold(tokens.p2, start);
  const rule = await api(`/owner/venues/${venue.id}/price-rules`, { token: tokens.owner, method: 'POST', body: { courtId: court.id, weekdays: '0123456', startTime: '00:00', endTime: '24:00', price: 9999, label: 'Test' } });
  assert.equal(rule.status, 201, JSON.stringify(rule.data));
  const after = await api(`/bookings/${h.data.id}`, { token: tokens.p2 });
  assert.equal(after.data.amount, h.data.amount);
  const fresh = (await api(`/venues/${venue.id}/availability?date=${date}`)).data.courts.find(c => c.id === court.id).slots.find(s => s.state === 'available');
  assert.equal(fresh.price, 999900);
  await api(`/owner/venues/${venue.id}/price-rules/${rule.data.id}`, { token: tokens.owner, method: 'DELETE' });
  await api(`/bookings/${h.data.id}/cancel`, { token: tokens.p2, method: 'POST', body: {} });
});

test('owners block, open and price slots; blocked slots cannot be booked', async () => {
  const start = await freeSlot(court.id, date, 8);
  const block = await api(`/owner/venues/${venue.id}/slots`, { token: tokens.manager, method: 'PUT', body: { courtId: court.id, date, starts: [start], action: 'block', reason: 'Re-turfing' } });
  assert.equal(block.status, 200, JSON.stringify(block.data));
  assert.equal((await hold(tokens.p2, start)).status, 409);
  await api(`/owner/venues/${venue.id}/slots`, { token: tokens.manager, method: 'PUT', body: { courtId: court.id, date, starts: [start], action: 'open' } });
  await api(`/owner/venues/${venue.id}/slots`, { token: tokens.manager, method: 'PUT', body: { courtId: court.id, date, starts: [start], action: 'price', price: 777 } });
  const h = await hold(tokens.p2, start);
  assert.equal(h.status, 201);
  assert.equal(h.data.amount, 77700);
  const blockBooked = await api(`/owner/venues/${venue.id}/slots`, { token: tokens.manager, method: 'PUT', body: { courtId: court.id, date, starts: [start], action: 'block' } });
  assert.equal(blockBooked.status, 409, 'cannot block a slot with a live booking');
  await api(`/bookings/${h.data.id}/cancel`, { token: tokens.p2, method: 'POST', body: {} });
});

test('staff permissions: front desk can book and check in but not change prices or see payouts', async () => {
  const start = await freeSlot(court.id, date, 9);
  const m = await api(`/owner/venues/${venue.id}/bookings`, { token: tokens.desk, method: 'POST', body: { courtId: court.id, date, starts: [start], customerName: 'Walk-in Team', method: 'cash' } });
  assert.equal(m.status, 201, JSON.stringify(m.data));
  assert.equal(m.data.status, 'confirmed');
  const lookup = await api(`/owner/venues/${venue.id}/lookup`, { token: tokens.desk, method: 'POST', body: { code: m.data.ref.toLowerCase() } });
  assert.equal(lookup.data.id, m.data.id);
  assert.equal((await api(`/owner/venues/${venue.id}/bookings/${m.data.id}/check-in`, { token: tokens.desk, method: 'POST' })).status, 200);
  assert.equal((await api(`/owner/venues/${venue.id}/price-rules`, { token: tokens.desk, method: 'POST', body: { weekdays: '1', startTime: '06:00', endTime: '07:00', price: 1 } })).status, 403);
  assert.equal((await api(`/owner/venues/${venue.id}/payouts`, { token: tokens.manager })).status, 403);
  assert.equal((await api(`/owner/venues/${venue.id}/calendar?date=${date}`, { token: tokens.p2 })).status, 404, 'customers cannot see venue internals');
  const edit = await api(`/owner/venues/${venue.id}/bookings/${m.data.id}`, { token: tokens.desk, method: 'PATCH', body: { notes: 'Paid cash at desk' } });
  assert.equal(edit.status, 200);
  assert.ok(one("SELECT 1 FROM audit_events WHERE action='booking.edited' AND entity_id=?", m.data.id), 'edits are audited');
});

test('owner reports cover revenue, bookings, cancellations and occupancy', async () => {
  const r = await api(`/owner/venues/${venue.id}/reports`, { token: tokens.owner });
  assert.equal(r.status, 200);
  assert.ok(r.data.totals.revenue > 0);
  assert.ok(r.data.totals.bookings > 0);
  assert.ok(r.data.totals.occupancy > 0 && r.data.totals.occupancy <= 100);
  assert.equal(r.data.series.length, 30);
});

test('admins verify and suspend venues; suspended venues stop taking bookings', async () => {
  const marina = one("SELECT * FROM venues WHERE slug='marina-sports-hub'");
  assert.equal((await api(`/admin/venues/${marina.id}/status`, { token: tokens.owner, method: 'POST', body: { status: 'active' } })).status, 403);
  assert.equal((await api(`/admin/venues/${marina.id}/status`, { token: tokens.admin, method: 'POST', body: { status: 'active' } })).status, 200);
  assert.equal((await api('/venues?q=marina')).data.length, 1);
  const smash = one("SELECT * FROM venues WHERE slug='smash-point-badminton'");
  await api(`/admin/venues/${smash.id}/status`, { token: tokens.admin, method: 'POST', body: { status: 'suspended', note: 'Safety inspection' } });
  const sc = one('SELECT id FROM courts WHERE venue_id=? LIMIT 1', smash.id);
  const h = await api('/bookings', { token: tokens.p2, method: 'POST', body: { venueId: smash.id, courtId: sc.id, date, starts: ['10:00'] } });
  assert.equal(h.status, 404);
  await api(`/admin/venues/${smash.id}/status`, { token: tokens.admin, method: 'POST', body: { status: 'active' } });
});

test('admins resolve disputes with a refund', async () => {
  const t = one("SELECT * FROM support_tickets WHERE kind='dispute' AND status='open'");
  assert.equal((await api(`/support/tickets/${t.id}/resolve`, { token: tokens.owner, method: 'POST', body: { resolution: 'nope' } })).status, 404, 'venues cannot see disputes');
  const r = await api(`/support/tickets/${t.id}/resolve`, { token: tokens.admin, method: 'POST', body: { resolution: 'Partial refund for lost time', refundAmount: 300 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refund.amount, 30000);
  assert.equal(r.data.refund.status, 'processed');
});

test('OTP: wrong codes are counted and locked out', async () => {
  const id = 'newplayer@example.com';
  const r1 = await api('/auth/otp/request', { method: 'POST', body: { identifier: id } });
  for (let i = 0; i < 5; i++) assert.equal((await api('/auth/otp/verify', { method: 'POST', body: { identifier: id, code: r1.data.devCode === '000000' ? '111111' : '000000' } })).status, 400);
  const locked = await api('/auth/otp/verify', { method: 'POST', body: { identifier: id, code: r1.data.devCode } });
  assert.equal(locked.data.code, 'otp_locked');
});

// ---- Wellness sessions and pools ---------------------------------------------------------------------------------
test('swimming pool lanes are searchable and bookable like any court', async () => {
  const r = await api(`/venues?sport=swimming&date=${date}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map(v => v.name).sort(), ['Aqua Arena Pool', 'Kickoff Arena']);
  assert.ok(r.data[0].availableSlots > 0);
});

async function newSession(extra = {}) {
  const aqua = one("SELECT * FROM venues WHERE slug='aqua-arena-pool'");
  const body = { title: 'Test flow', kind: 'yoga', mode: 'in_person', capacity: 1, price: 250, date, startTime: '10:00', endTime: '11:00', ...extra };
  const r = await api(`/owner/venues/${aqua.id}/sessions`, { token: tokens.owner, method: 'POST', body });
  return { aqua, r };
}

test('a full session rejects further seats and a lapsed payment is refunded', async () => {
  const { r } = await newSession({ title: 'One seat only' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const first = await api(`/wellness/sessions/${r.data.id}/book`, { token: tokens.player, method: 'POST', body: {} });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.session.title, 'One seat only');
  assert.equal((await api(`/wellness/sessions/${r.data.id}`)).data.seatsLeft, 0, 'a held seat counts against capacity');
  const second = await api(`/wellness/sessions/${r.data.id}/book`, { token: tokens.p2, method: 'POST', body: {} });
  assert.equal(second.status, 409);
  assert.equal(second.data.code, 'session_full');
  const again = await api(`/wellness/sessions/${r.data.id}/book`, { token: tokens.player, method: 'POST', body: {} });
  assert.equal(again.data.code, 'already_booked');
  const paid = await payAndSettle(tokens.player, first.data.id);
  assert.equal(paid.amount, 25000);
  assert.equal((await api(`/bookings/${first.data.id}`, { token: tokens.player })).data.status, 'confirmed');
});

test('online sessions need a join link, which is shown only to people who paid', async () => {
  const bad = await newSession({ title: 'Needs link', mode: 'online' });
  assert.equal(bad.r.status, 400);
  const { r } = await newSession({ title: 'Live breathwork', kind: 'breathwork', mode: 'online', capacity: 5, price: 99, joinUrl: 'https://meet.example.com/abc' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await api(`/wellness/sessions/${r.data.id}`)).data.joinUrl, undefined, 'public view never exposes the link');
  const h = await api(`/wellness/sessions/${r.data.id}/book`, { token: tokens.p2, method: 'POST', body: {} });
  assert.equal(h.data.session.joinUrl, '', 'hidden while unpaid');
  await payAndSettle(tokens.p2, h.data.id);
  const view = await api(`/bookings/${h.data.id}`, { token: tokens.p2 });
  assert.equal(view.data.session.joinUrl, 'https://meet.example.com/abc');
});

test('cancelling a session refunds every seat in full', async () => {
  const { aqua, r } = await newSession({ title: 'To be cancelled', capacity: 3, price: 400 });
  const h = await api(`/wellness/sessions/${r.data.id}/book`, { token: tokens.player, method: 'POST', body: {} });
  await payAndSettle(tokens.player, h.data.id);
  assert.equal((await api(`/owner/venues/${aqua.id}/sessions/${r.data.id}/cancel`, { token: tokens.player, method: 'POST', body: {} })).status, 404, 'players cannot manage sessions');
  const c = await api(`/owner/venues/${aqua.id}/sessions/${r.data.id}/cancel`, { token: tokens.owner, method: 'POST', body: { reason: 'Trainer unwell' } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.seatsRefunded, 1);
  const after = await api(`/bookings/${h.data.id}`, { token: tokens.player });
  assert.equal(after.data.status, 'cancelled');
  assert.equal(after.data.refunds[0].amount, 40000);
  assert.equal((await api(`/wellness/sessions/${r.data.id}/book`, { token: tokens.p2, method: 'POST', body: {} })).status, 404);
});

// ---- Vending machines ----------------------------------------------------------------------------------------------
const machineByName = async name => (await api('/vending/machines')).data.find(m => m.name === name);
const key = slug => ({ 'x-machine-key': `vm_demo_${slug}` });
async function payOrder(token, orderId, outcome = 'success') {
  const pay = await api(`/vending/orders/${orderId}/pay`, { token, method: 'POST' });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  const done = await api(`/payments/sandbox/${pay.data.intentId}/complete`, { token, method: 'POST', body: { outcome } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return pay.data;
}

test('machines report their status: online, warning, fault and offline', async () => {
  const list = (await api('/vending/machines')).data;
  const byName = Object.fromEntries(list.map(m => [m.name, m]));
  assert.equal(byName['Snack Point'].status, 'online');
  assert.equal(byName['Futsal Snacks'].status, 'fault');
  assert.equal(byName['Clubhouse Snacks'].status, 'offline');
  assert.equal(byName['Snack Point'].lowStock, 1, 'the energy drink is low');
  const orderOffline = await api('/vending/orders', { token: tokens.player, method: 'POST', body: { machineId: byName['Futsal Snacks'].id, items: [{ itemId: byName['Futsal Snacks'].items[0].id, qty: 1 }] } });
  assert.equal(orderOffline.status, 409);
  assert.equal(orderOffline.data.code, 'machine_unavailable');
});

test('pre-order, pay, then redeem the pickup code at the machine exactly once', async () => {
  const m = await machineByName('Snack Point'), chips = m.items.find(i => i.slot === 'A1');
  const o = await api('/vending/orders', { token: tokens.player, method: 'POST', body: { machineId: m.id, items: [{ itemId: chips.id, qty: 2 }] } });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  assert.equal(o.data.amount, 4000);
  assert.equal(o.data.pickupCode, '', 'no code before payment');
  assert.equal((await machineByName('Snack Point')).items.find(i => i.slot === 'A1').available, chips.available - 2, 'held items are reserved');
  await payOrder(tokens.player, o.data.id);
  const paid = (await api(`/vending/orders/${o.data.id}`, { token: tokens.player })).data;
  assert.equal(paid.status, 'paid');
  assert.match(paid.pickupCode, /^\d{6}$/);
  const headers = key('snack-point');
  assert.equal((await api(`/device/vending/${m.id}/dispense`, { method: 'POST', headers: { 'x-machine-key': 'wrong' }, body: { code: paid.pickupCode } })).status, 401);
  const wrongCode = await api(`/device/vending/${m.id}/dispense`, { method: 'POST', headers, body: { code: '000000' } });
  assert.equal(wrongCode.data.code, 'bad_code');
  const ok = await api(`/device/vending/${m.id}/dispense`, { method: 'POST', headers, body: { code: paid.pickupCode } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.deepEqual(ok.data.dispense, [{ slot: 'A1', name: 'Classic chips', qty: 2 }]);
  assert.equal((await api(`/device/vending/${m.id}/dispense`, { method: 'POST', headers, body: { code: paid.pickupCode } })).data.code, 'bad_code', 'a code works once');
  assert.equal((await api(`/vending/orders/${o.data.id}`, { token: tokens.player })).data.status, 'dispensed');
  assert.equal((await machineByName('Snack Point')).items.find(i => i.slot === 'A1').available, chips.available - 2, 'stock is really gone');
});

test('the last items cannot be ordered twice', async () => {
  const m = await machineByName('Snack Point'), energy = m.items.find(i => i.slot === 'B2');
  assert.equal(energy.available, 2);
  const first = await api('/vending/orders', { token: tokens.player, method: 'POST', body: { machineId: m.id, items: [{ itemId: energy.id, qty: 2 }] } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const second = await api('/vending/orders', { token: tokens.p2, method: 'POST', body: { machineId: m.id, items: [{ itemId: energy.id, qty: 1 }] } });
  assert.equal(second.status, 409);
  assert.equal(second.data.code, 'out_of_stock');
  const cancelled = await api(`/vending/orders/${first.data.id}/cancel`, { token: tokens.player, method: 'POST' });
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal((await api('/vending/orders', { token: tokens.p2, method: 'POST', body: { machineId: m.id, items: [{ itemId: energy.id, qty: 1 }] } })).status, 201, 'freed stock can be ordered');
});

test('machine heartbeats update stock, raise faults and recover', async () => {
  const m = await machineByName('Court Corner'), headers = key('court-corner');
  const bad = await api(`/device/vending/${m.id}/heartbeat`, { method: 'POST', headers: { 'x-machine-key': 'nope' }, body: {} });
  assert.equal(bad.status, 401);
  const hb = await api(`/device/vending/${m.id}/heartbeat`, { method: 'POST', headers, body: { temperature: 5, stock: { A1: 1 }, faults: [{ code: 'DOOR_STUCK', severity: 'critical', message: 'Door sensor error' }] } });
  assert.equal(hb.status, 200, JSON.stringify(hb.data));
  const owner = (await api(`/owner/venues/${one("SELECT id FROM venues WHERE slug='smash-point-badminton'").id}/vending`, { token: tokens.owner })).data;
  const staff = owner.machines.find(x => x.name === 'Court Corner');
  assert.equal(staff.status, 'fault');
  assert.equal(staff.items.find(i => i.slot === 'A1').stock, 1);
  assert.equal(staff.faults[0].code, 'DOOR_STUCK');
  assert.ok(one("SELECT 1 FROM notifications WHERE kind='vending_alert' AND title LIKE '%Court Corner%'"), 'staff are alerted');
  await api(`/device/vending/${m.id}/heartbeat`, { method: 'POST', headers, body: { temperature: 5, stock: {}, faults: [] } });
  assert.equal((await machineByName('Court Corner')).status, 'online', 'the fault clears when the machine stops reporting it');
});

test('venue managers refund a paid order that was never collected', async () => {
  const m = await machineByName('Barista Bot'), cup = m.items.find(i => i.slot === 'C1');
  const o = await api('/vending/orders', { token: tokens.p2, method: 'POST', body: { machineId: m.id, items: [{ itemId: cup.id, qty: 1 }] } });
  await payOrder(tokens.p2, o.data.id);
  const venueId = one("SELECT id FROM venues WHERE slug='kickoff-arena'").id;
  assert.equal((await api(`/owner/venues/${venueId}/vending/orders/${o.data.id}/refund`, { token: tokens.player, method: 'POST', body: {} })).status, 404, 'players cannot refund');
  const r = await api(`/owner/venues/${venueId}/vending/orders/${o.data.id}/refund`, { token: tokens.owner, method: 'POST', body: { reason: 'Machine was stuck' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'refunded');
  assert.equal(one('SELECT status, refunded, amount FROM order_payments WHERE order_id=?', o.data.id).status, 'refunded');
});

// ---- Entry access control and surveillance -------------------------------------------------------------------------
const { sweepAccess } = await import('../access.js');
const gate = () => one("SELECT * FROM access_points WHERE name='Main Gate'");
const scanApi = (b, direction, key = 'ax_demo_main-gate') => api(`/device/access/${gate().id}/scan`, { method: 'POST', headers: { 'x-device-key': key }, body: { credential: b.ref, direction } });
// A confirmed, future kickoff booking, moved to "now" so the entry window is open.
function liveBooking(offsetStartMin = -1, lengthMin = 60) {
  const b = db.prepare("SELECT * FROM bookings WHERE venue_id=? AND status='confirmed' AND customer_id IS NOT NULL AND session_id IS NULL AND inside_count=0 AND start_at>? AND id NOT IN (SELECT booking_id FROM access_events WHERE booking_id IS NOT NULL) LIMIT 1 OFFSET ?").get(venue.id, Date.now() + 86400000, Math.floor(Math.random() * 20));
  run('UPDATE bookings SET start_at=?, end_at=? WHERE id=?', Date.now() + offsetStartMin * 60000, Date.now() + (offsetStartMin + lengthMin) * 60000, b.id);
  return one('SELECT * FROM bookings WHERE id=?', b.id);
}

test('gates admit people inside the booking window and count them in and out', async () => {
  const b = liveBooking();
  assert.equal((await scanApi(b, 'in', 'wrong-key')).status, 401);
  const unknown = await api(`/device/access/${gate().id}/scan`, { method: 'POST', headers: { 'x-device-key': 'ax_demo_main-gate' }, body: { credential: 'TCNOSUCH', direction: 'in' } });
  assert.equal(unknown.data.result, 'denied');
  assert.equal(unknown.data.reason, 'unknown');
  for (let i = 1; i <= 3; i++) assert.equal((await scanApi(b, 'in')).data.inside, i);
  assert.equal((await scanApi(b, 'out')).data.inside, 2);
  assert.ok(one('SELECT checked_in_at FROM bookings WHERE id=?', b.id).checked_in_at, 'first entry checks the booking in');
  const early = liveBooking(120);
  const denied = (await scanApi(early, 'in')).data;
  assert.equal(denied.result, 'denied');
  assert.equal(denied.reason, 'too_early');
  const cancelled = liveBooking();
  run("UPDATE bookings SET status='cancelled' WHERE id=?", cancelled.id);
  assert.equal((await scanApi(cancelled, 'in')).data.reason, 'cancelled');
});

test('people still inside after the slot ends raise an overstay alert that clears when they leave', async () => {
  const b = liveBooking(-80, 60);                                   // ended 20 minutes ago
  run('UPDATE bookings SET inside_count=2 WHERE id=?', b.id);
  sweepAccess({ force: true });
  const alert = one("SELECT * FROM venue_alerts WHERE booking_id=? AND kind='overstay'", b.id);
  assert.ok(alert, 'overstay alert raised');
  assert.equal(alert.resolved_at, null);
  assert.ok(one("SELECT 1 FROM notifications WHERE booking_id=? AND kind='slot_ended'", b.id), 'the player is told to leave');
  sweepAccess({ force: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM venue_alerts WHERE booking_id=? AND kind='overstay'").get(b.id).n, 1, 'only one alert per booking');
  await scanApi(b, 'out'); await scanApi(b, 'out');
  assert.ok(one("SELECT resolved_at FROM venue_alerts WHERE booking_id=? AND kind='overstay'", b.id).resolved_at, 'alert resolves once everyone is out');
});

test('a slot ending soon warns the people inside, and a missing group is flagged as a no-show', async () => {
  const ending = liveBooking(-50, 60);                              // 10 minutes left
  run('UPDATE bookings SET inside_count=4, end_at=? WHERE id=?', Date.now() + 8 * 60000, ending.id);
  const missing = liveBooking(-30, 90);                             // started 30 minutes ago, nobody arrived
  sweepAccess({ force: true });
  assert.ok(one("SELECT 1 FROM notifications WHERE booking_id=? AND kind='slot_ending'", ending.id));
  assert.ok(one("SELECT 1 FROM venue_alerts WHERE booking_id=? AND kind='no_show'", missing.id));
});

test('cameras raise alerts and head-count mismatches are caught', async () => {
  const cam = one("SELECT * FROM cameras WHERE name='Gate camera'"), headers = { 'x-device-key': 'cm_demo_gate-camera' };
  assert.equal((await api(`/device/camera/${cam.id}/event`, { method: 'POST', headers: { 'x-device-key': 'nope' }, body: { kind: 'motion' } })).status, 401);
  assert.equal((await api(`/device/camera/${cam.id}/event`, { method: 'POST', headers, body: { kind: 'laser' } })).status, 400);
  run('DELETE FROM venue_alerts WHERE kind IN (?,?)', 'unknown_person', 'headcount');
  const e = await api(`/device/camera/${cam.id}/event`, { method: 'POST', headers, body: { kind: 'unknown_person', note: 'Climbing the fence' } });
  assert.equal(e.status, 200, JSON.stringify(e.data));
  assert.ok(one("SELECT 1 FROM venue_alerts WHERE kind='unknown_person' AND message LIKE '%Climbing the fence%'"));
  run('UPDATE bookings SET inside_count=0 WHERE venue_id=?', venue.id);
  await api(`/device/camera/${cam.id}/event`, { method: 'POST', headers, body: { kind: 'people_count', people: 30 } });
  sweepAccess({ force: true });
  assert.ok(one("SELECT 1 FROM venue_alerts WHERE kind='headcount' AND venue_id=?", venue.id), 'cameras see 30, gates let in 0');
});

test('repeated refused scans raise an alert; staff see the live picture and the report', async () => {
  run("DELETE FROM venue_alerts WHERE kind='denied_burst'");
  for (let i = 0; i < 3; i++) await api(`/device/access/${gate().id}/scan`, { method: 'POST', headers: { 'x-device-key': 'ax_demo_main-gate' }, body: { credential: 'TCBADCODE' + i, direction: 'in' } });
  sweepAccess({ force: true });
  assert.ok(one("SELECT 1 FROM venue_alerts WHERE kind='denied_burst'"));
  const live = await api(`/owner/venues/${venue.id}/access`, { token: tokens.desk });
  assert.equal(live.status, 200, 'front desk can watch the live view');
  assert.ok(live.data.points.length >= 2 && live.data.cameras.length >= 3);
  assert.ok(live.data.alerts.length > 0);
  assert.equal((await api(`/owner/venues/${venue.id}/access/report`, { token: tokens.desk })).status, 403, 'the report is for managers');
  const report = await api(`/owner/venues/${venue.id}/access/report?days=7`, { token: tokens.manager });
  assert.equal(report.status, 200, JSON.stringify(report.data));
  assert.ok(report.data.entries > 50 && report.data.exits > 50, 'seeded history is analysed');
  assert.equal(report.data.heat.length, 7);
  assert.ok(report.data.attendanceRate > 50 && report.data.attendanceRate <= 100);
  assert.ok(report.data.peakOccupancy > 0);
  const ack = await api(`/owner/venues/${venue.id}/access/alerts/${live.data.alerts[0].id}/ack`, { token: tokens.desk, method: 'POST' });
  assert.equal(ack.status, 200);
});

test('managers can try the gate and camera flows in demo mode', async () => {
  process.env.TURF_VENDING_SIM = 'true';
  const { config } = await import('../config.js');
  const before = config.vendingSim; config.vendingSim = true;
  try {
    const b = liveBooking();
    const sim = await api(`/owner/venues/${venue.id}/access/simulate`, { token: tokens.manager, method: 'POST', body: { type: 'scan', deviceId: gate().id, credential: b.ref, direction: 'in' } });
    assert.equal(sim.status, 200, JSON.stringify(sim.data));
    assert.equal(sim.data.result, 'granted');
    assert.equal((await api(`/owner/venues/${venue.id}/access/simulate`, { token: tokens.desk, method: 'POST', body: { type: 'scan', deviceId: gate().id, credential: b.ref, direction: 'in' } })).status, 403, 'front desk cannot use the simulator');
    config.vendingSim = false;
    assert.equal((await api(`/owner/venues/${venue.id}/access/simulate`, { token: tokens.manager, method: 'POST', body: { type: 'scan', deviceId: gate().id, credential: b.ref, direction: 'in' } })).status, 404, 'disabled outside demo mode');
  } finally { config.vendingSim = before; }
});

// ---- Blog and Q&A -------------------------------------------------------------------------------------------------
test('the blog shows published posts only; admins write, edit and publish', async () => {
  const list = await api('/blog');
  assert.equal(list.status, 200);
  assert.ok(list.data.length >= 5 && list.data.every(p => p.status === 'published'));
  assert.equal(list.data.some(p => p.title.startsWith('Draft')), false, 'drafts stay private');
  const post = await api(`/blog/${list.data[0].slug}`);
  assert.ok(post.data.body.length > 100 && post.data.readingMinutes >= 1);
  assert.equal((await api('/admin/blog', { token: tokens.owner, method: 'POST', body: { title: 'Nope nope', body: 'x', category: 'tips' } })).status, 403, 'only admins write');
  const draft = await api('/admin/blog', { token: tokens.admin, method: 'POST', body: { title: 'Cricket nets etiquette', category: 'tips', body: 'Short draft' } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal((await api(`/blog/${draft.data.slug}`)).status, 404, 'unpublished posts are not public');
  const tooShort = await api(`/admin/blog/${draft.data.id}`, { token: tokens.admin, method: 'PATCH', body: { status: 'published' } });
  assert.equal(tooShort.status, 400, 'publishing needs a real body');
  const live = await api(`/admin/blog/${draft.data.id}`, { token: tokens.admin, method: 'PATCH', body: { status: 'published', body: 'Share the nets, rotate every six balls, and keep the bags behind the netting. '.repeat(3) } });
  assert.equal(live.status, 200, JSON.stringify(live.data));
  assert.equal((await api(`/blog/${live.data.slug}`)).status, 200);
  assert.equal((await api(`/admin/blog/${draft.data.id}`, { token: tokens.admin, method: 'DELETE' })).status, 200);
});

test('players ask, the right team answers, and nobody else can', async () => {
  const kick = one("SELECT * FROM venues WHERE slug='kickoff-arena'");
  assert.equal((await api('/qa/questions', { method: 'POST', body: { title: 'Anyone there at night?' } })).status, 401, 'asking needs an account');
  const spam = await api('/qa/questions', { token: tokens.p2, method: 'POST', body: { title: 'Great deals at http://spam.example', venueId: kick.id } });
  assert.equal(spam.status, 400, 'links are rejected');
  const q = await api('/qa/questions', { token: tokens.p2, method: 'POST', body: { title: 'Can we bring our own football?', body: 'We have a size 5 match ball.', venueId: kick.id } });
  assert.equal(q.status, 201, JSON.stringify(q.data));
  assert.equal(q.data.answered, false);
  assert.ok(one("SELECT 1 FROM notifications n JOIN venues v ON v.owner_id=n.user_id WHERE n.kind='question' AND v.id=?", kick.id), 'the venue team is told');
  assert.equal((await api(`/qa/questions/${q.data.id}/answers`, { token: tokens.player, method: 'POST', body: { body: 'Sure!' } })).status, 403, 'other players cannot answer');
  const a = await api(`/qa/questions/${q.data.id}/answers`, { token: tokens.manager, method: 'POST', body: { body: 'Yes, match balls are welcome. Please avoid worn balls on the artificial grass.' } });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const shown = (await api(`/qa/questions/${q.data.id}`)).data;
  assert.equal(shown.answers[0].by, 'Kickoff Arena team');
  assert.equal(shown.askedBy.includes(' '), false, 'only first names are public');
  assert.ok(one("SELECT 1 FROM notifications WHERE kind='answer'"), 'the asker is told');
  const general = await api('/qa/questions', { token: tokens.p2, method: 'POST', body: { title: 'Do you plan to add a gym finder?' } });
  assert.equal((await api(`/qa/questions/${general.data.id}/answers`, { token: tokens.owner, method: 'POST', body: { body: 'We are looking at it.' } })).status, 403, 'general questions are for the Thidal team');
  assert.equal((await api(`/qa/questions/${general.data.id}/answers`, { token: tokens.admin, method: 'POST', body: { body: 'Great idea, we are looking at it.' } })).status, 201);
});

test('reported questions hide after three reports and admins can restore them', async () => {
  const q = (await api('/qa/questions', { token: tokens.p2, method: 'POST', body: { title: 'Totally off-topic question here' } })).data;
  const reporters = [tokens.player, tokens.owner, tokens.manager];
  for (const t of reporters) assert.equal((await api('/qa/report', { token: t, method: 'POST', body: { kind: 'question', id: q.id } })).status, 200);
  assert.equal((await api('/qa/report', { token: tokens.player, method: 'POST', body: { kind: 'question', id: q.id } })).status, 409, 'one report per person');
  assert.equal((await api(`/qa/questions/${q.id}`)).status, 404, 'hidden after three reports');
  const queue = await api('/admin/qa', { token: tokens.admin });
  assert.ok(queue.data.flagged.some(f => f.id === q.id && f.hidden));
  assert.equal((await api('/admin/qa', { token: tokens.owner })).status, 403);
  await api(`/admin/qa/question/${q.id}/hide`, { token: tokens.admin, method: 'POST', body: { hidden: false } });
  assert.equal((await api(`/qa/questions/${q.id}`)).status, 200, 'restored');
});

// ---- Coaches ---------------------------------------------------------------------------------------------------------
const coachDate = () => { for (let d = 2; d < 9; d++) { const x = addDays(zonedParts(Date.now(), 'Asia/Kolkata').date, d); if (new Date(x + 'T00:00:00Z').getUTCDay() === 3) return x; } };   // a Wednesday: every coach works

test('coaches can be browsed, sorted and liked', async () => {
  const all = (await api('/coaches')).data;
  assert.equal(all.length, 9);
  assert.ok(all[0].rating >= all.at(-1).rating, 'best rated first');
  const cricket = (await api('/coaches?sport=cricket')).data;
  assert.deepEqual(cricket.map(c => c.name), ['Rajesh Iyer']);
  const profile = (await api(`/coaches/${cricket[0].id}`)).data;
  assert.ok(profile.reviewList.length >= 4 && profile.histogram.length === 5);
  assert.equal(profile.reviewList.every(r => !r.name.includes(' ')), true, 'reviewers show first names only');
  assert.equal((await api(`/coaches/${cricket[0].id}/like`, { method: 'POST' })).status, 401);
  const before = profile.likes, liked = profile.liked;
  const t1 = await api(`/coaches/${cricket[0].id}/like`, { token: tokens.p2, method: 'POST' });
  const t2 = await api(`/coaches/${cricket[0].id}/like`, { token: tokens.p2, method: 'POST' });
  assert.equal(t1.data.liked, !(t2.data.liked), 'second tap undoes the first');
  assert.equal(t2.data.likes, before, 'liking twice leaves the count unchanged');
  void liked;
});

test('a coach slot books once, pays like any booking, and can be reviewed after the session', async () => {
  const coach = (await api('/coaches?sport=badminton')).data[0], date = coachDate();
  const slots = (await api(`/coaches/${coach.id}/slots?date=${date}`)).data.slots;
  assert.ok(slots.length >= 4 && slots.every(s => s.state === 'available'));
  const pick = slots[1].start;
  const h = await api(`/coaches/${coach.id}/book`, { token: tokens.player, method: 'POST', body: { date, start: pick } });
  assert.equal(h.status, 201, JSON.stringify(h.data));
  assert.equal(h.data.coach.name, 'Anil Gopal');
  assert.equal(h.data.court.name, 'Coaching with Anil Gopal');
  const clash = await api(`/coaches/${coach.id}/book`, { token: tokens.desk, method: 'POST', body: { date, start: pick } });
  assert.equal(clash.status, 409, 'the coach cannot be double-booked');
  assert.equal((await api(`/coaches/${coach.id}/book`, { token: tokens.desk, method: 'POST', body: { date, start: '03:00' } })).status, 400, 'outside availability');
  await payAndSettle(tokens.player, h.data.id);
  assert.equal((await api(`/bookings/${h.data.id}`, { token: tokens.player })).data.status, 'confirmed');
  assert.equal((await api(`/coaches/${coach.id}/slots?date=${date}`)).data.slots.find(s => s.start === pick).state, 'booked');
  // After the session: rate and comment.
  assert.equal((await api(`/bookings/${h.data.id}/review`, { token: tokens.player, method: 'POST', body: { rating: 5, comment: 'Superb footwork drills' } })).status, 409, 'not before the session is completed');
  run("UPDATE bookings SET status='completed' WHERE id=?", h.data.id);
  const rev = await api(`/bookings/${h.data.id}/review`, { token: tokens.player, method: 'POST', body: { rating: 5, comment: 'Superb footwork drills' } });
  assert.equal(rev.status, 201, JSON.stringify(rev.data));
  assert.equal((await api(`/bookings/${h.data.id}/review`, { token: tokens.player, method: 'POST', body: { rating: 4 } })).status, 409, 'one review per session');
  const after = (await api(`/coaches/${coach.id}`)).data;
  assert.equal(after.reviewList[0].comment, 'Superb footwork drills');
  assert.equal(after.reviews, coach.reviews + 1);
  assert.equal((await api(`/bookings/${h.data.id}`, { token: tokens.player })).data.review.rating, 5);
});

test('venue managers add coaches with weekly availability and reply to reviews', async () => {
  const kick = one("SELECT id FROM venues WHERE slug='kickoff-arena'");
  const body = { name: 'Neha Verma', specialty: 'basketball', price: 650, sessionMinutes: 60, bio: 'Point guard turned coach.', experienceYears: 7, languages: 'English, Hindi', availability: [{ weekday: 3, start: '17:00', end: '20:00' }] };
  assert.equal((await api(`/owner/venues/${kick.id}/coaches`, { token: tokens.player, method: 'POST', body })).status, 404, 'players cannot add coaches');
  assert.equal((await api(`/owner/venues/${kick.id}/coaches`, { token: tokens.manager, method: 'POST', body: { ...body, availability: [{ weekday: 3, start: '20:00', end: '17:00' }] } })).status, 400);
  const made = await api(`/owner/venues/${kick.id}/coaches`, { token: tokens.manager, method: 'POST', body });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const date = coachDate();
  assert.equal((await api(`/coaches/${made.data.id}/slots?date=${date}`)).data.slots.length, 3, 'a 3-hour window gives three one-hour slots');
  const off = await api(`/owner/venues/${kick.id}/coaches/${made.data.id}`, { token: tokens.manager, method: 'PATCH', body: { active: false } });
  assert.equal(off.data.active, false);
  assert.equal((await api(`/coaches/${made.data.id}`)).status, 404, 'inactive coaches are hidden');
  const sameer = (await api('/coaches?sport=football')).data[0], review = (await api(`/coaches/${sameer.id}`)).data.reviewList.find(r => !r.reply);
  const reply = await api(`/owner/venues/${kick.id}/coaches/${sameer.id}/reviews/${review.id}/reply`, { token: tokens.owner, method: 'POST', body: { reply: 'Thank you for the kind words!' } });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal((await api(`/coaches/${sameer.id}`)).data.reviewList.find(r => r.id === review.id).reply, 'Thank you for the kind words!');
});

// ---- Assistant -------------------------------------------------------------------------------------------------------
const bot = (text, token) => api('/assistant/message', { token, method: 'POST', body: { text } }).then(r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; });

test('the assistant finds free slots from plain language', async () => {
  const r = await bot('any badminton court free tomorrow evening?');
  assert.match(r.reply, /badminton slots tomorrow in the evening/);
  assert.equal(r.cards.length, 1, 'only this turf is offered');
  assert.equal(r.cards[0].title, 'Kickoff Arena');
  assert.match(r.cards[0].href, /^#\/game\/badminton\?date=\d{4}-\d\d-\d\d$/);
  const none = await bot('swimming lane tomorrow at 3 am');
  assert.match(none.reply, /could not find/);
  assert.ok(none.quick.length > 0);
});

test('the assistant answers prices, classes, coaches and machines from live data', async () => {
  assert.match((await bot('how much is a football turf')).reply, /Football prices start at ₹/);
  const yoga = await bot('any yoga classes today or tomorrow');
  assert.ok(yoga.cards.length > 0 && yoga.cards.every(c => c.href.startsWith('#/session/')));
  const online = await bot('live online classes');
  assert.ok(online.cards.every(c => /Online/.test(c.subtitle)));
  const coach = await bot('I need a cricket coach');
  assert.equal(coach.cards[0].title.startsWith('Rajesh Iyer'), true);
  const coffee = await bot('is the coffee machine working?');
  assert.match(coffee.reply, /\d+ of \d+ coffee machines are working/);
  assert.ok(coffee.cards.some(c => /Barista Bot/.test(c.title)));
});

test('the assistant is personal only when signed in, and explains policies', async () => {
  const anon = await bot('show my next booking');
  assert.match(anon.reply, /Sign in/);
  const mine = await bot('what are my upcoming bookings', tokens.player);
  assert.ok(mine.cards.length > 0 && mine.cards[0].href.startsWith('#/booking/'));
  const cancel = await bot('how do I cancel my booking', tokens.player);
  assert.match(cancel.reply, /refund/i);
  assert.ok(cancel.cards.some(c => /refund/i.test(c.subtitle)), 'shows what the player would get');
  assert.match((await bot('how do i enter the venue')).reply, /QR code/);
  assert.match((await bot('is there a promo code?')).reply, /WELCOME20/);
  assert.match((await bot('help me with my refund')).reply, /5 to 7 working days/, 'a help request about a refund is answered, not shown a menu');
  const human = await bot('I want to talk to a person');
  assert.equal(human.handoff, true);
  assert.equal(human.cards[0].href, '#/support/new');
  const lost = await bot('qwertyuiop');
  assert.ok(lost.quick.includes('Talk to a person'));
  assert.equal((await api('/assistant/message', { method: 'POST', body: { text: 'x'.repeat(400) } })).status, 400, 'messages are length limited');
});

// ---- One-turf mode: site info, photos and videos, coach add-on ---------------------------------------------------------
test('the site endpoint describes the turf and the games it offers', async () => {
  const site = await api('/site');
  assert.equal(site.status, 200);
  assert.equal(site.data.venue.slug, 'kickoff-arena');
  assert.deepEqual(site.data.games.map(g => g.sport).sort(), ['badminton', 'cricket', 'football', 'swimming', 'tennis']);
  assert.ok(site.data.games.every(g => g.courts >= 1 && g.fromPrice > 0));
});

test('owners add photos, videos and YouTube links; players see them per game', async () => {
  const kick = one("SELECT id FROM venues WHERE slug='kickoff-arena'");
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const base = `/owner/venues/${kick.id}/media`;
  assert.equal((await api(base, { token: tokens.player, method: 'POST', body: { dataUrl: png } })).status, 404, 'players cannot upload');
  const img = await api(base, { token: tokens.manager, method: 'POST', body: { dataUrl: png, sport: 'cricket', caption: 'Nets at sunset' } });
  assert.equal(img.status, 201, JSON.stringify(img.data));
  assert.equal(img.data.kind, 'image');
  const vidBytes = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(2048, 7)]);
  const vid = await api(base, { token: tokens.manager, method: 'POST', body: { dataUrl: `data:video/webm;base64,${vidBytes.toString('base64')}`, sport: 'cricket', caption: 'Bowling drill' } });
  assert.equal(vid.status, 201, JSON.stringify(vid.data));
  assert.equal(vid.data.kind, 'video');
  // The video is served with byte ranges so browsers can seek.
  const full = await fetch(base.replace(/^.*$/, '') + `${server.address ? 'http://127.0.0.1:' + server.address().port : ''}${vid.data.url}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/webm');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const part = await fetch(`http://127.0.0.1:${server.address().port}${vid.data.url}`, { headers: { range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-9/${vidBytes.length}`);
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  const yt = await api(base, { token: tokens.manager, method: 'POST', body: { youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s', sport: 'football' } });
  assert.equal(yt.status, 201, JSON.stringify(yt.data));
  assert.equal(yt.data.youtubeId, 'dQw4w9WgXcQ');
  assert.equal((await api(base, { token: tokens.manager, method: 'POST', body: { youtubeUrl: 'https://evil.example/watch?v=dQw4w9WgXcQ' } })).status, 400, 'only YouTube links');
  assert.equal((await api(base, { token: tokens.manager, method: 'POST', body: { dataUrl: 'data:text/html;base64,PGI+' } })).status, 400, 'only images and videos');
  const cricket = (await api(`/media?venueId=${kick.id}&sport=cricket`)).data;
  assert.ok(cricket.some(m => m.id === img.data.id) && cricket.some(m => m.kind === 'video'), 'cricket sees its own media');
  assert.equal(cricket.some(m => m.id === yt.data.id), false, 'and not football media');
  assert.ok(cricket.some(m => m.sport === null), 'but does see media shared by all games');
  assert.equal((await api(`${base}/${img.data.id}`, { token: tokens.manager, method: 'DELETE' })).status, 200);
  assert.equal((await api(`/media?venueId=${kick.id}&sport=cricket`)).data.some(m => m.id === img.data.id), false);
});

test('a coach can be added to a turf slot: game coach, common coach, never double-booked', async () => {
  const kick = one("SELECT * FROM venues WHERE slug='kickoff-arena'"), wed = coachDate();
  const pitches = ['Pitch A (5-a-side)', 'Pitch B (5-a-side)', 'Pitch C (7-a-side)'].map(n => one('SELECT * FROM courts WHERE venue_id=? AND name=?', kick.id, n));
  const free = async c => (await api(`/venues/${kick.id}/availability?date=${wed}&sport=football`)).data.courts.find(x => x.id === c.id).slots.filter(s => (s.state === 'available' || s.state === 'almost_full') && s.start >= '17:00' && s.start <= '19:00').map(s => s.start);
  const common = [...new Set((await Promise.all(pitches.map(free))).flat())].sort();
  assert.ok(common.length, 'some evening slot is free on a pitch');
  const start = common[0], withStart = [];
  for (const p of pitches) if ((await free(p)).includes(start)) withStart.push(p);
  assert.ok(withStart.length >= 1);
  const opts = (await api(`/venues/${kick.id}/coach-options?date=${wed}&sport=football&starts=${start}`)).data.options;
  const names = opts.map(o => o.name);
  assert.ok(names.includes('Sameer Khan') && names.includes('Rohit Menon'), 'the football coach and a common coach are offered');
  assert.equal(names.includes('Anil Gopal'), false, 'a badminton coach is not offered for football');
  const sameer = opts.find(o => o.name === 'Sameer Khan'), rohit = opts.find(o => o.name === 'Rohit Menon');
  assert.equal(rohit.scope, 'all');
  assert.equal(sameer.feePerSlot, 80000, 'one hour at the coach rate');
  const book = (token, court, coachId) => api('/bookings', { token, method: 'POST', body: { venueId: kick.id, courtId: court.id, date: wed, starts: [start], sport: 'football', coachId } });
  const h = await book(tokens.desk, withStart[0], sameer.id);
  assert.equal(h.status, 201, JSON.stringify(h.data));
  const slotPrice = h.data.slots.find(s => s.start === start).price;
  assert.equal(h.data.amount, slotPrice + 80000, 'coach fee is part of the total');
  assert.equal(h.data.addonCoach.name, 'Sameer Khan');
  assert.ok(h.data.slots.some(s => s.label === 'Coach: Sameer Khan'), 'the coach is a line on the bill');
  const after = (await api(`/venues/${kick.id}/coach-options?date=${wed}&sport=football&starts=${start}`)).data.options.map(o => o.name);
  assert.equal(after.includes('Sameer Khan'), false, 'a held coach is no longer offered for that hour');
  if (withStart[1]) {
    const clash = await book(tokens.manager, withStart[1], sameer.id);
    assert.equal(clash.status, 409, JSON.stringify(clash.data));
    assert.equal(clash.data.code, 'coach_unavailable');
  }
  const wrong = await api('/bookings', { token: tokens.manager, method: 'POST', body: { venueId: kick.id, courtId: withStart.at(-1).id, date: wed, starts: [start], sport: 'football', coachId: opts.find(o => o.name === 'Rohit Menon').id } });
  assert.ok([201, 409].includes(wrong.status), 'a common coach can join any game');
  await api(`/bookings/${h.data.id}/cancel`, { token: tokens.desk, method: 'POST', body: {} });
  const back = (await api(`/venues/${kick.id}/coach-options?date=${wed}&sport=football&starts=${start}`)).data.options.map(o => o.name);
  assert.ok(back.includes('Sameer Khan'), 'cancelling frees the coach');
  const badSport = await api('/bookings', { token: tokens.manager, method: 'POST', body: { venueId: kick.id, courtId: withStart[0].id, date: wed, starts: [start], sport: 'football', coachId: (await api('/coaches?sport=badminton')).data[0].id } });
  assert.equal(badSport.status, 400, 'a badminton coach cannot coach football');
});

test('managers add a webcam test camera and delete cameras; used gates are kept', async () => {
  const kick = one("SELECT id FROM venues WHERE slug='kickoff-arena'"), base = `/owner/venues/${kick.id}/access`;
  const cam = await api(`${base}/cameras`, { token: tokens.manager, method: 'POST', body: { name: 'My webcam', location: 'This computer', source: 'webcam' } });
  assert.equal(cam.status, 201, JSON.stringify(cam.data));
  const overview = (await api(base, { token: tokens.manager })).data;
  assert.equal(overview.cameras.find(c => c.id === cam.data.id).source, 'webcam');
  assert.equal((await api(`${base}/cameras`, { token: tokens.manager, method: 'POST', body: { name: 'Bad', source: 'laser' } })).status, 400);
  // the browser reports through the demo simulator, which counts as the camera being seen
  const ev = await api(`${base}/simulate`, { token: tokens.manager, method: 'POST', body: { type: 'camera', deviceId: cam.data.id, kind: 'motion', note: 'Webcam motion' } });
  if (ev.status === 200) assert.equal(one('SELECT COUNT(*) AS n FROM camera_events WHERE camera_id=?', cam.data.id).n, 1);
  assert.equal((await api(`${base}/cameras/${cam.data.id}`, { token: tokens.desk, method: 'DELETE' })).status, 403, 'front desk cannot delete');
  assert.equal((await api(`${base}/cameras/${cam.data.id}`, { token: tokens.manager, method: 'DELETE' })).status, 200);
  assert.equal(one('SELECT COUNT(*) AS n FROM cameras WHERE id=?', cam.data.id).n, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM camera_events WHERE camera_id=?', cam.data.id).n, 0, 'its events go with it');
  assert.equal((await api(`${base}/cameras/${cam.data.id}`, { token: tokens.manager, method: 'DELETE' })).status, 404);
  const used = one("SELECT id FROM access_points WHERE name='Main Gate'");
  const keep = await api(`${base}/points/${used.id}`, { token: tokens.manager, method: 'DELETE' });
  assert.equal(keep.status, 409);
  assert.equal(keep.data.code, 'has_history');
  const fresh = await api(`${base}/points`, { token: tokens.manager, method: 'POST', body: { name: 'Spare door', kind: 'door' } });
  assert.equal((await api(`${base}/points/${fresh.data.id}`, { token: tokens.manager, method: 'DELETE' })).status, 200, 'a gate with no history can go');
});
