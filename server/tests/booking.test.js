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
