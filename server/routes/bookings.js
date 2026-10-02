import { all, id, now, one, run, transaction } from '../db.js';
import { applyCouponToHold, bookingView, cancelBooking, createHold, issueRefund, loadOwnBooking, money, paidAmount } from '../bookings.js';
import { completeSandboxCheckout, handleWebhook, sandboxIntent, startPayment } from '../payments.js';
import { rateLimit } from '../security.js';
import { conflict, bad, date as dateOf, int, str, oneOf, SPORTS } from '../validate.js';
import { reply } from '../http.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';

// Replays the stored response when a client retries with the same Idempotency-Key (e.g. after a network drop).
export function idempotent(u, req, scope, fn) {
  const key = req.headers['idempotency-key'];
  if (!key) return reply(201, fn());
  if (key.length > 100) bad('Idempotency-Key is too long');
  const prior = one('SELECT status, response FROM idempotency_keys WHERE user_id=? AND scope=? AND key=?', u.id, scope, key);
  if (prior) return reply(prior.status, JSON.parse(prior.response));
  const value = fn();
  run('INSERT OR IGNORE INTO idempotency_keys (user_id,key,scope,status,response,created_at) VALUES (?,?,?,?,?,?)', u.id, key, scope, 201, JSON.stringify(value), now());
  return reply(201, value);
}

export default function bookingRoutes(r) {
  r.post('/bookings', ({ u, body, req }) => {
    rateLimit(`hold:${u.id}`, 20, 60 * 1000);
    return idempotent(u, req, 'hold', () => createHold(u, {
      venueId: str(body.venueId, 'Venue', { min: 1, max: 64 }), courtId: str(body.courtId, 'Court', { min: 1, max: 64 }),
      date: dateOf(body.date), starts: body.starts, sport: oneOf(body.sport || null, 'Sport', SPORTS, { optional: true }),
      couponCode: str(body.couponCode, 'Promo code', { max: 40, optional: true }), coachId: str(body.coachId, 'Coach', { max: 64, optional: true }) || null,
    }));
  });

  r.get('/bookings/mine', ({ u, query }) => {
    const scope = query.get('scope') || 'upcoming';
    const rows = scope === 'past'
      ? all("SELECT * FROM bookings WHERE customer_id=? AND (status IN ('completed','cancelled','failed','expired') OR end_at<?) ORDER BY start_at DESC LIMIT 100", u.id, Date.now())
      : all("SELECT * FROM bookings WHERE customer_id=? AND status IN ('held','confirmed') AND end_at>=? ORDER BY start_at LIMIT 100", u.id, Date.now());
    return rows.map(b => bookingView(b));
  });

  r.get('/bookings/:id', ({ u, params }) => bookingView(loadOwnBooking(u, params.id)));
  r.post('/bookings/:id/coupon', ({ u, params, body }) => applyCouponToHold(u, params.id, str(body.code, 'Promo code', { max: 40, optional: true })));
  r.post('/bookings/:id/pay', ({ u, params }) => startPayment(u, loadOwnBooking(u, params.id)));
  r.post('/bookings/:id/cancel', ({ u, params, body }) => cancelBooking(loadOwnBooking(u, params.id), u, { reason: str(body.reason, 'Reason', { max: 300, optional: true }) }));

  // For problems the policy does not cover (e.g. pitch unplayable). The venue decides; disputes go to admins.
  r.post('/bookings/:id/refund-request', ({ u, params, body }) => transaction(() => {
    const b = loadOwnBooking(u, params.id);
    if (!['confirmed', 'completed', 'cancelled'].includes(b.status)) conflict('Only paid bookings can be refunded');
    if (one("SELECT 1 FROM refunds WHERE booking_id=? AND status='pending'", b.id)) conflict('A refund request is already waiting for the venue');
    const { refundable } = paidAmount(b.id);
    if (!refundable) conflict('Nothing left to refund on this booking');
    const amount = body.amount != null ? int(body.amount, 'Amount', { min: 1, max: refundable }) : refundable;
    const refund = issueRefund(b, amount, { origin: 'customer_request', actorId: u.id, reason: str(body.reason, 'Reason', { min: 5, max: 500 }), status: 'pending' });
    const venue = one('SELECT owner_id, name FROM venues WHERE id=?', b.venue_id);
    notify(venue.owner_id, { kind: 'refund_request', title: 'Refund requested', body: `${b.ref}: ${money(amount)} — ${refund.reason}`, link: `#/owner/${b.venue_id}/refunds`, channels: ['inapp', 'email'] });
    audit(u.id, 'refund.requested', 'refund', refund.id, { venueId: b.venue_id, amount, ref: b.ref });
    return refund;
  }));

  r.post('/bookings/:id/review', ({ u, params, body }) => {
    const b = loadOwnBooking(u, params.id);
    if (b.status !== 'completed') conflict('You can review a venue after your game');
    if (one('SELECT 1 FROM reviews WHERE booking_id=?', b.id) || one('SELECT 1 FROM coach_reviews WHERE booking_id=?', b.id)) conflict('You already reviewed this booking');
    const review = { id: id(), rating: int(body.rating, 'Rating', { min: 1, max: 5 }), comment: str(body.comment, 'Comment', { max: 1000, optional: true }) };
    if (b.coach_id) {
      run('INSERT INTO coach_reviews (id,coach_id,booking_id,customer_id,rating,comment,created_at) VALUES (?,?,?,?,?,?,?)', review.id, b.coach_id, b.id, u.id, review.rating, review.comment, now());
      return reply(201, review);
    }
    run('INSERT INTO reviews (id,venue_id,booking_id,customer_id,rating,comment,created_at) VALUES (?,?,?,?,?,?,?)', review.id, b.venue_id, b.id, u.id, review.rating, review.comment, now());
    audit(u.id, 'review.created', 'review', review.id, { venueId: b.venue_id, rating: review.rating });
    return reply(201, review);
  });

  r.get('/bookings/:id/invoice', ({ u, params }) => {
    const b = loadOwnBooking(u, params.id);
    if (!['confirmed', 'completed', 'cancelled'].includes(b.status) || !b.confirmed_at) conflict('An invoice is available once the booking is paid');
    const v = one('SELECT name, business_name, tax_id, address, city, phone FROM venues WHERE id=?', b.venue_id);
    return { number: `INV-${b.ref}`, issuedAt: b.confirmed_at, customer: { name: u.name, email: u.email, phone: u.phone }, venue: v, booking: bookingView(b) };
  });

  r.get('/payments/sandbox/:intentId', ({ u, params }) => sandboxIntent(u, params.intentId));
  r.post('/payments/sandbox/:intentId/complete', ({ u, params, body }) => completeSandboxCheckout(u, params.intentId, oneOf(body.outcome, 'Outcome', ['success', 'failure'])));
  r.post('/webhooks/payments', ({ raw, req }) => handleWebhook(raw, req.headers['x-turf-signature']), { auth: 'none', raw: true });
}
