// Payments. A provider creates payment intents and refunds; a booking is only ever confirmed by a webhook whose
// signature verifies. The sandbox provider stands in for a hosted gateway (Stripe, Razorpay): its checkout page is
// simulated in the web app, and "completing" it makes the server sign and POST a webhook to itself, so the real
// verification path runs end to end.
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { id, now, one, run, transaction } from './db.js';
import { hmacHex, safeEqual } from './security.js';
import { bad, conflict, HttpError, notFound } from './validate.js';
import { confirmBooking, failBooking, issueRefund, money } from './bookings.js';
import { notify } from './notify.js';
import { publishUser, publishVenue } from './events.js';
import { audit } from './audit.js';
import { confirmOrderPaid, failOrderPayment, refundOrder } from './vending.js';
import { confirmStorePaid, failStorePayment, refundStoreOrder } from './store.js';

const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
let selfBaseUrl = `http://127.0.0.1:${config.port}`;
export const setSelfBaseUrl = url => { selfBaseUrl = url; };

const providers = {
  sandbox: {
    createIntent: () => { const intentId = 'pi_sbx_' + randomBytes(12).toString('hex'); return { intentId, checkoutUrl: `#/pay/${intentId}` }; },
    refund: () => ({ ref: 're_sbx_' + randomBytes(10).toString('hex') }),
  },
};
const provider = () => {
  const p = providers[config.paymentProvider];
  if (!p) throw new Error(`Payment provider "${config.paymentProvider}" is not implemented`);
  return p;
};
export const createIntent = o => provider().createIntent(o);
export const refundPayment = (payment, amount) => payment.provider === 'free' || payment.provider === 'sandbox' ? providers.sandbox.refund(payment, amount) : provider().refund(payment, amount);

export function startPayment(user, booking) {
  return transaction(() => {
    const b = one('SELECT * FROM bookings WHERE id=?', booking.id);
    if (b.status !== 'held') conflict(b.status === 'confirmed' ? 'This booking is already paid' : 'This checkout has expired. Please pick your slot again.', 'hold_expired');
    if (b.hold_expires_at < Date.now()) conflict('This checkout has expired. Please pick your slot again.', 'hold_expired');
    // Repeated clicks reuse the open intent, so a customer can never be charged twice for one hold.
    const open = one("SELECT * FROM payments WHERE booking_id=? AND status='requires_payment'", b.id);
    if (open) return { intentId: open.intent_id, checkoutUrl: `#/pay/${open.intent_id}`, amount: open.amount, currency: open.currency };
    if (b.amount === 0) {
      run("INSERT INTO payments (id,booking_id,provider,intent_id,amount,currency,status,created_at,updated_at) VALUES (?,?,'free',?,0,?,'succeeded',?,?)", id(), b.id, 'free_' + b.id, config.currency, now(), now());
      confirmBooking(b.id);
      return { free: true, status: 'confirmed' };
    }
    const intent = provider().createIntent(b);
    run("INSERT INTO payments (id,booking_id,provider,intent_id,amount,currency,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'requires_payment',?,?)",
      id(), b.id, config.paymentProvider, intent.intentId, b.amount, config.currency, now(), now());
    audit(user.id, 'payment.started', 'booking', b.id, { venueId: b.venue_id, intent: intent.intentId, amount: b.amount });
    return { intentId: intent.intentId, checkoutUrl: intent.checkoutUrl, amount: b.amount, currency: config.currency };
  });
}

// ---- Webhook signatures: header "t=<ms>,v1=<hex hmac of `${t}.${body}`>" ------------------------------------
export function signPayload(body, t = Date.now()) { return `t=${t},v1=${hmacHex(config.webhookSecret, `${t}.${body}`)}`; }
export function verifySignature(header, body) {
  const parts = Object.fromEntries(String(header || '').split(',').map(kv => kv.split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() - t) > SIGNATURE_TOLERANCE_MS) return false;
  return safeEqual(hmacHex(config.webhookSecret, `${t}.${body}`), parts.v1);
}

export function handleWebhook(raw, signature) {
  if (!verifySignature(signature, raw)) throw new HttpError(401, 'Invalid webhook signature');
  let event; try { event = JSON.parse(raw); } catch { bad('Invalid JSON'); }
  if (!event?.id || !event?.type) bad('Malformed event');
  const touched = [], touchedOrders = [], touchedStore = [];
  const result = transaction(() => {
    if (one('SELECT 1 FROM webhook_events WHERE event_id=?', event.id)) return { received: true, duplicate: true };
    run('INSERT INTO webhook_events (event_id,type,received_at) VALUES (?,?,?)', event.id, event.type, now());
    const payment = one('SELECT * FROM payments WHERE intent_id=?', event.data?.intentId);
    if (!payment) {
      const op = one('SELECT * FROM order_payments WHERE intent_id=?', event.data?.intentId);
      if (op) return handleOrderEvent(event, op, touchedOrders);
      const sp = one('SELECT * FROM store_payments WHERE intent_id=?', event.data?.intentId);
      return sp ? handleStoreEvent(event, sp, touchedStore) : { received: true, ignored: 'unknown intent' };
    }
    const b = one('SELECT * FROM bookings WHERE id=?', payment.booking_id);
    touched.push(b);
    if (event.type === 'payment_intent.succeeded') {
      if (payment.status === 'succeeded') return { received: true };
      if (event.data.amount !== payment.amount) {
        run("UPDATE payments SET status='failed', failure_reason='amount mismatch', updated_at=? WHERE id=?", now(), payment.id);
        audit(null, 'payment.amount_mismatch', 'payment', payment.id, { venueId: b.venue_id, expected: payment.amount, got: event.data.amount });
        return { received: true, error: 'amount mismatch' };
      }
      run("UPDATE payments SET status='succeeded', updated_at=? WHERE id=?", now(), payment.id);
      const confirmed = confirmBooking(b.id);
      if (!confirmed.ok) {
        // Paid after the hold lapsed and someone else took the slot: refund in full automatically.
        if (b.status === 'held') failBooking(b, 'Slot no longer available');
        issueRefund(b, payment.amount, { origin: 'system', reason: 'Slot was no longer available when payment completed' });
        notify(b.customer_id, { kind: 'booking_failed', title: 'Slot no longer available', body: `Your payment for ${b.ref} arrived after the slot was released. ${money(payment.amount)} has been refunded in full.`, link: `#/booking/${b.id}`, bookingId: b.id });
      }
      audit(null, 'payment.succeeded', 'payment', payment.id, { venueId: b.venue_id, ref: b.ref, amount: payment.amount, confirmed: confirmed.ok });
      return { received: true, confirmed: confirmed.ok };
    }
    if (event.type === 'payment_intent.payment_failed') {
      run("UPDATE payments SET status='failed', failure_reason=?, updated_at=? WHERE id=?", String(event.data.reason || 'Payment declined').slice(0, 200), now(), payment.id);
      // Failed payments release the held slot straight away rather than waiting for the hold timer.
      if (b.status === 'held') failBooking(b, 'Payment failed');
      notify(b.customer_id, { kind: 'payment_failed', title: 'Payment failed', body: `Your payment for ${b.ref} did not go through, so the slot was released. You were not charged.`, link: `#/booking/${b.id}`, bookingId: b.id, channels: ['inapp'] });
      audit(null, 'payment.failed', 'payment', payment.id, { venueId: b.venue_id, ref: b.ref, reason: event.data.reason });
      return { received: true };
    }
    return { received: true, ignored: event.type };
  });
  for (const b of touched) {
    publishVenue(b.venue_id, { date: b.date, courtId: b.court_id });
    const status = one('SELECT status FROM bookings WHERE id=?', b.id).status;
    publishUser(b.customer_id, 'booking', { id: b.id, status });
  }
  for (const o of touchedOrders) publishUser(o.customer_id, 'order', { id: o.id, status: one('SELECT status FROM vending_orders WHERE id=?', o.id).status });
  for (const o of touchedStore) publishUser(o.customer_id, 'order', { id: o.id, status: one('SELECT status FROM store_orders WHERE id=?', o.id).status });
  return result;
}

// Vending order payments: same signed webhook, same amount check; stock that vanished before payment cleared is refunded.
function handleOrderEvent(event, op, touchedOrders) {
  const o = one('SELECT * FROM vending_orders WHERE id=?', op.order_id);
  touchedOrders.push(o);
  if (event.type === 'payment_intent.succeeded') {
    if (op.status === 'succeeded') return { received: true };
    if (event.data.amount !== op.amount) {
      run("UPDATE order_payments SET status='failed', updated_at=? WHERE id=?", now(), op.id);
      audit(null, 'payment.amount_mismatch', 'order_payment', op.id, { venueId: o.venue_id, expected: op.amount, got: event.data.amount });
      return { received: true, error: 'amount mismatch' };
    }
    run("UPDATE order_payments SET status='succeeded', updated_at=? WHERE id=?", now(), op.id);
    const confirmed = confirmOrderPaid(o.id);
    if (!confirmed.ok) refundOrder(one('SELECT * FROM vending_orders WHERE id=?', o.id), { reason: 'Items sold out before your payment cleared.' });
    return { received: true, confirmed: confirmed.ok };
  }
  if (event.type === 'payment_intent.payment_failed') {
    run("UPDATE order_payments SET status='failed', updated_at=? WHERE id=?", now(), op.id);
    failOrderPayment(o.id);
    return { received: true };
  }
  return { received: true, ignored: event.type };
}

// Shop and rental payments: same rules; items that went while the player paid are refunded in full.
function handleStoreEvent(event, sp, touchedStore) {
  const o = one('SELECT * FROM store_orders WHERE id=?', sp.order_id);
  touchedStore.push(o);
  if (event.type === 'payment_intent.succeeded') {
    if (sp.status === 'succeeded') return { received: true };
    if (event.data.amount !== sp.amount) {
      run("UPDATE store_payments SET status='failed', updated_at=? WHERE id=?", now(), sp.id);
      audit(null, 'payment.amount_mismatch', 'store_payment', sp.id, { venueId: o.venue_id, expected: sp.amount, got: event.data.amount });
      return { received: true, error: 'amount mismatch' };
    }
    run("UPDATE store_payments SET status='succeeded', updated_at=? WHERE id=?", now(), sp.id);
    const confirmed = confirmStorePaid(o.id);
    if (!confirmed.ok) {
      run("UPDATE store_orders SET status='paid', updated_at=? WHERE id=?", now(), o.id);
      refundStoreOrder(one('SELECT * FROM store_orders WHERE id=?', o.id), { reason: 'The items were taken before your payment cleared.' });
    }
    return { received: true, confirmed: confirmed.ok };
  }
  if (event.type === 'payment_intent.payment_failed') {
    run("UPDATE store_payments SET status='failed', updated_at=? WHERE id=?", now(), sp.id);
    failStorePayment(o.id);
    return { received: true };
  }
  return { received: true, ignored: event.type };
}

// ---- Sandbox checkout ----------------------------------------------------------------------------------------
export async function completeSandboxCheckout(user, intentId, outcome) {
  if (config.paymentProvider !== 'sandbox') notFound();
  const payment = one('SELECT p.*, b.customer_id FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE p.intent_id=?', intentId)
    || one('SELECT p.*, o.customer_id FROM order_payments p JOIN vending_orders o ON o.id=p.order_id WHERE p.intent_id=?', intentId)
    || one('SELECT p.*, o.customer_id FROM store_payments p JOIN store_orders o ON o.id=p.order_id WHERE p.intent_id=?', intentId);
  if (!payment || payment.customer_id !== user.id) notFound('Payment not found');
  if (payment.status !== 'requires_payment') conflict('This payment is already finished');
  const body = JSON.stringify({
    id: 'evt_sbx_' + randomBytes(10).toString('hex'),
    type: outcome === 'success' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed',
    data: { intentId, amount: payment.amount, reason: outcome === 'success' ? undefined : 'Card declined (sandbox)' },
  });
  const res = await fetch(`${selfBaseUrl}/api/webhooks/payments`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-turf-signature': signPayload(body) }, body });
  if (!res.ok) throw new HttpError(502, 'The payment gateway did not respond');
  return { delivered: true };
}

export function sandboxIntent(user, intentId) {
  const p = one(`SELECT p.intent_id, p.amount, p.currency, p.status, b.id AS booking_id, b.ref, b.customer_id, b.hold_expires_at, v.name AS venue
                 FROM payments p JOIN bookings b ON b.id=p.booking_id JOIN venues v ON v.id=b.venue_id WHERE p.intent_id=?`, intentId);
  if (!p) {
    const q = one(`SELECT p.intent_id, p.amount, p.currency, p.status, o.id AS order_id, o.ref, o.customer_id, o.hold_expires_at, v.name AS venue, m.name AS machine
                   FROM order_payments p JOIN vending_orders o ON o.id=p.order_id JOIN venues v ON v.id=o.venue_id JOIN vending_machines m ON m.id=o.machine_id WHERE p.intent_id=?`, intentId);
    if (!q) {
      const st = one(`SELECT p.intent_id, p.amount, p.currency, p.status, o.id AS order_id, o.kind, o.ref, o.customer_id, o.hold_expires_at, v.name AS venue
                       FROM store_payments p JOIN store_orders o ON o.id=p.order_id JOIN venues v ON v.id=o.venue_id WHERE p.intent_id=?`, intentId);
      if (!st || st.customer_id !== user.id) notFound('Payment not found');
      return { intentId: st.intent_id, amount: st.amount, currency: st.currency, status: st.status, storeOrderId: st.order_id, ref: st.ref, venue: `${st.venue} · ${st.kind === 'rental' ? 'Rentals' : 'Shop'}`, holdExpiresAt: st.hold_expires_at };
    }
    if (q.customer_id !== user.id) notFound('Payment not found');
    return { intentId: q.intent_id, amount: q.amount, currency: q.currency, status: q.status, orderId: q.order_id, ref: q.ref, venue: `${q.venue} · ${q.machine}`, holdExpiresAt: q.hold_expires_at };
  }
  if (p.customer_id !== user.id) notFound('Payment not found');
  return { intentId: p.intent_id, amount: p.amount, currency: p.currency, status: p.status, bookingId: p.booking_id, ref: p.ref, venue: p.venue, holdExpiresAt: p.hold_expires_at };
}
