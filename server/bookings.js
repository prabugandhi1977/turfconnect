// Booking lifecycle: hold -> (payment webhook) -> confirmed -> completed, with cancel/expire/fail releasing the slots.
// Every state change that frees or takes a slot goes through claimSlots/releaseSlots so slot_claims stays the
// single source of truth for occupancy.
import { all, id, now, one, parseJson, run, transaction } from './db.js';
import { venueDay, isBookable, slotStarts } from './availability.js';
import { zonedToEpoch, toMin } from './time.js';
import { conflict, bad, notFound, forbidden, HttpError } from './validate.js';
import { randomCode } from './security.js';
import { publishVenue, publishUser } from './events.js';
import { notify, cancelPending } from './notify.js';
import { audit } from './audit.js';
import { config } from './config.js';
import { refundPayment } from './payments.js';
import { coachSlots, claimCoach, coachForSlots } from './coaches.js';

export const LIVE = ['held', 'confirmed', 'completed'];
export const money = p => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0 })}`;

function newRef() {
  for (;;) { const ref = 'TC' + randomCode(8); if (!one('SELECT 1 FROM bookings WHERE ref=?', ref)) return ref; }
}

// ---- Coupons -------------------------------------------------------------------------------------------------
export function evaluateCoupon(code, { venueId, userId, subtotal, ignoreBookingId = null }) {
  const c = one('SELECT * FROM coupons WHERE code=?', String(code || '').trim().toUpperCase());
  const invalid = msg => bad(msg, 'coupon_invalid');
  if (!c || !c.active) invalid('That promo code is not valid');
  if (c.venue_id && c.venue_id !== venueId) invalid('That promo code is not valid at this venue');
  if (c.owner_user_id && c.owner_user_id !== userId) invalid('That promo code belongs to another account');
  if (c.valid_until && c.valid_until < new Date().toISOString().slice(0, 10)) invalid('That promo code has expired');
  if (subtotal < c.min_amount) invalid(`Add ${money(c.min_amount - subtotal)} more to use this code`);
  const used = one(`SELECT COUNT(*) AS n, SUM(customer_id=?) AS mine FROM bookings WHERE coupon_id=? AND status IN ('held','confirmed','completed') AND id IS NOT ?`, userId, c.id, ignoreBookingId);
  if (c.max_uses != null && used.n >= c.max_uses) invalid('That promo code has been fully used');
  if ((used.mine || 0) >= c.per_user_limit) invalid('You have already used this promo code');
  let discount = c.kind === 'percent' ? Math.floor(subtotal * c.value / 100) : c.value;
  if (c.max_discount != null) discount = Math.min(discount, c.max_discount);
  return { coupon: c, discount: Math.min(discount, subtotal) };
}

// ---- Slot claims ---------------------------------------------------------------------------------------------
function claimSlots(booking, starts) {
  try {
    for (const s of starts) run('INSERT INTO slot_claims (court_id,date,start_time,booking_id) VALUES (?,?,?,?)', booking.court_id, booking.date, s, booking.id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE') || String(e.message).includes('PRIMARY')) conflict('Sorry, someone just booked that slot. Please pick another time.', 'slot_taken');
    throw e;
  }
}
function releaseSlots(bookingId) { run('DELETE FROM slot_claims WHERE booking_id=?', bookingId); }

function validateSelection(venue, courtId, date, starts, { staff = false } = {}) {
  if (!Array.isArray(starts) || !starts.length) bad('Pick at least one slot');
  if (starts.length > 6) bad('You can book up to 6 consecutive slots at once');
  const grid = slotStarts(venue);
  const idx = [...new Set(starts)].map(s => grid.indexOf(s)).sort((a, b) => a - b);
  if (idx.includes(-1) || idx.length !== starts.length) bad('One of the selected times is not a valid slot');
  if (idx.some((v, i) => i && v !== idx[i - 1] + 1)) bad('Pick consecutive slots on the same court');
  const court = venueDay(venue, date, { courtId, withDetails: true, includeInactive: staff })[0];
  if (!court) notFound('Court not found');
  const chosen = idx.map(i => court.slots[i]);
  for (const s of chosen) {
    // Staff may book over a manual block (they just set it); everything else must be genuinely free.
    const ok = isBookable(s.state) || (staff && s.state === 'closed' && s.reason !== 'Past');
    if (!ok) conflict(s.state === 'held' || s.state === 'booked' ? 'Sorry, someone just booked that slot. Please pick another time.' : `${s.start} is not available (${s.reason || s.state})`, 'slot_unavailable');
  }
  return { court, chosen };
}

function snapshotPolicy(venue) {
  return JSON.stringify({ fullHours: venue.cancel_full_hours, partialHours: venue.cancel_partial_hours, partialPercent: venue.cancel_partial_percent });
}

// ---- Customer hold -------------------------------------------------------------------------------------------
export function createHold(user, { venueId, courtId, date, starts, sport, couponCode, coachId = null }) {
  const result = transaction(() => {
    expireHolds();
    const venue = one('SELECT * FROM venues WHERE id=?', venueId);
    if (!venue || venue.status !== 'active') notFound('This venue is not taking bookings right now');
    const active = one("SELECT COUNT(*) AS n FROM bookings WHERE customer_id=? AND status='held'", user.id).n;
    if (active >= config.maxActiveHolds) throw new HttpError(429, 'You have too many unfinished checkouts. Finish or cancel one first.');
    const { court, chosen } = validateSelection(venue, courtId, date, starts);
    const pickedSport = sport || court.sports[0];
    if (!court.sports.includes(pickedSport)) bad(`${court.name} is not set up for ${pickedSport}`);
    const turfTotal = chosen.reduce((sum, s) => sum + s.price, 0);
    const coach = coachId ? coachForSlots(venue, coachId, date, chosen.map(s => s.start), pickedSport) : null;
    const coachFee = coach ? coach.feePerSlot * chosen.length : 0;
    const subtotal = turfTotal + coachFee;
    let discount = 0, couponId = null;
    if (couponCode) { const c = evaluateCoupon(couponCode, { venueId, userId: user.id, subtotal }); discount = c.discount; couponId = c.coupon.id; }
    const first = chosen[0], last = chosen[chosen.length - 1];
    const booking = {
      id: id(), ref: newRef(), venue_id: venue.id, court_id: court.id, date,
      start_time: first.start, end_time: last.end,
      start_at: zonedToEpoch(date, toMin(first.start), venue.timezone), end_at: zonedToEpoch(date, toMin(last.end), venue.timezone),
    };
    const ts = now();
    run(`INSERT INTO bookings (id,ref,venue_id,court_id,customer_id,customer_name,customer_phone,sport,date,start_time,end_time,start_at,end_at,slots,status,source,subtotal,discount,amount,coupon_id,price_snapshot,policy_snapshot,hold_expires_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'held','online',?,?,?,?,?,?,?,?,?)`,
      booking.id, booking.ref, venue.id, court.id, user.id, user.name || '', user.phone || '', pickedSport, date, booking.start_time, booking.end_time, booking.start_at, booking.end_at,
      JSON.stringify(chosen.map(s => s.start)), subtotal, discount, subtotal - discount, couponId,
      JSON.stringify([...chosen.map(s => ({ start: s.start, end: s.end, price: s.price })), ...(coach ? [{ start: '', end: '', label: `Coach: ${coach.name}`, price: coachFee }] : [])]), snapshotPolicy(venue), Date.now() + venue.hold_minutes * 60000, ts, ts);
    claimSlots(booking, chosen.map(s => s.start));
    if (coach) { claimCoach(booking.id, coach, date, chosen.map(s => s.start)); run('UPDATE bookings SET addon_coach_id=?, coach_fee=? WHERE id=?', coach.id, coachFee, booking.id); }
    audit(user.id, 'booking.hold', 'booking', booking.id, { venueId: venue.id, ref: booking.ref, date, starts, amount: subtotal - discount });
    return { bookingId: booking.id, venueId: venue.id, courtId: court.id, date };
  });
  publishVenue(result.venueId, { date: result.date, courtId: result.courtId });
  return bookingView(one('SELECT * FROM bookings WHERE id=?', result.bookingId));
}

// ---- Wellness sessions: a seat is a booking row, capacity is a live-booking count --------------------------------
// SQLite runs these transactions one at a time, so counting inside the transaction cannot oversell a class.
export function seatsTaken(sessionId) {
  return one(`SELECT COUNT(*) AS n FROM bookings WHERE session_id=? AND (status IN ('confirmed','completed') OR (status='held' AND hold_expires_at>=?))`, sessionId, Date.now()).n;
}
// Session bookings need a court_id; they all point at one hidden, inactive "Wellness studio" per venue.
function studioCourt(venueId) {
  const found = one("SELECT id FROM courts WHERE venue_id=? AND name='Wellness studio'", venueId);
  if (found) return found.id;
  const cid = id();
  run("INSERT INTO courts (id,venue_id,name,sports,surface,indoor,base_price,active,sort) VALUES (?,?,'Wellness studio','[]','concrete',1,0,0,999)", cid, venueId);
  return cid;
}

export function createSessionHold(user, sessionId, { couponCode } = {}) {
  const result = transaction(() => {
    expireHolds();
    const session = one('SELECT * FROM wellness_sessions WHERE id=?', sessionId);
    if (!session || session.status !== 'scheduled') notFound('This session is not available');
    if (session.start_at <= Date.now()) conflict('This session has already started', 'session_started');
    const venue = one('SELECT * FROM venues WHERE id=?', session.venue_id);
    if (!venue || venue.status !== 'active') notFound('This venue is not taking bookings right now');
    if (one("SELECT 1 FROM bookings WHERE session_id=? AND customer_id=? AND status IN ('held','confirmed','completed')", session.id, user.id)) conflict('You already have a seat in this session', 'already_booked');
    if (one("SELECT COUNT(*) AS n FROM bookings WHERE customer_id=? AND status='held'", user.id).n >= config.maxActiveHolds) throw new HttpError(429, 'You have too many unfinished checkouts. Finish or cancel one first.');
    if (seatsTaken(session.id) >= session.capacity) conflict('Sorry, this session is full', 'session_full');
    const subtotal = session.price;
    let discount = 0, couponId = null;
    if (couponCode) { const c = evaluateCoupon(couponCode, { venueId: venue.id, userId: user.id, subtotal }); discount = c.discount; couponId = c.coupon.id; }
    const bid = id(), ts = now(), courtId = studioCourt(venue.id);
    run(`INSERT INTO bookings (id,ref,venue_id,court_id,session_id,customer_id,customer_name,customer_phone,sport,date,start_time,end_time,start_at,end_at,slots,status,source,subtotal,discount,amount,coupon_id,price_snapshot,policy_snapshot,hold_expires_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'held','online',?,?,?,?,?,?,?,?,?)`,
      bid, newRef(), venue.id, courtId, session.id, user.id, user.name || '', user.phone || '', session.kind, session.date, session.start_time, session.end_time, session.start_at, session.end_at,
      JSON.stringify([session.start_time]), subtotal, discount, subtotal - discount, couponId, JSON.stringify([{ start: session.start_time, end: session.end_time, price: subtotal }]),
      snapshotPolicy(venue), Date.now() + venue.hold_minutes * 60000, ts, ts);
    audit(user.id, 'booking.session_hold', 'booking', bid, { venueId: venue.id, sessionId: session.id, amount: subtotal - discount });
    return { bookingId: bid, venueId: venue.id, date: session.date };
  });
  publishVenue(result.venueId, { date: result.date, session: true });
  return bookingView(one('SELECT * FROM bookings WHERE id=?', result.bookingId));
}

// ---- Coach sessions: one-to-one, claimed through the coach's hidden court so a coach can never be double-booked ----------
export function createCoachHold(user, coachId, { date, start, couponCode } = {}) {
  const result = transaction(() => {
    expireHolds();
    const coach = one('SELECT * FROM coaches WHERE id=? AND active=1', coachId);
    const venue = coach && one('SELECT * FROM venues WHERE id=?', coach.venue_id);
    if (!coach || venue?.status !== 'active') notFound('This coach is not available');
    const slot = coachSlots(coach, date, venue).find(s => s.start === start);
    if (!slot) bad('That time is not in the coach\'s availability');
    if (one("SELECT COUNT(*) AS n FROM bookings WHERE customer_id=? AND status='held'", user.id).n >= config.maxActiveHolds) throw new HttpError(429, 'You have too many unfinished checkouts. Finish or cancel one first.');
    let discount = 0, couponId = null;
    if (couponCode) { const c = evaluateCoupon(couponCode, { venueId: venue.id, userId: user.id, subtotal: coach.price }); discount = c.discount; couponId = c.coupon.id; }
    const b = { id: id(), court_id: coach.court_id, date }, ts = now();
    run(`INSERT INTO bookings (id,ref,venue_id,court_id,coach_id,customer_id,customer_name,customer_phone,sport,date,start_time,end_time,start_at,end_at,slots,status,source,subtotal,discount,amount,coupon_id,price_snapshot,policy_snapshot,hold_expires_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'held','online',?,?,?,?,?,?,?,?,?)`,
      b.id, newRef(), venue.id, coach.court_id, coach.id, user.id, user.name || '', user.phone || '', coach.specialty, date, slot.start, slot.end, slot.startAt, slot.startAt + coach.session_minutes * 60000,
      JSON.stringify([slot.start]), coach.price, discount, coach.price - discount, couponId, JSON.stringify([{ start: slot.start, end: slot.end, price: coach.price }]), snapshotPolicy(venue), Date.now() + venue.hold_minutes * 60000, ts, ts);
    claimSlots(b, [slot.start]);
    audit(user.id, 'booking.coach_hold', 'booking', b.id, { venueId: venue.id, coachId: coach.id, date, start });
    return { bookingId: b.id, venueId: venue.id };
  });
  publishVenue(result.venueId, { coach: true });
  return bookingView(one('SELECT * FROM bookings WHERE id=?', result.bookingId));
}

// Venue cancels a whole session: every held or confirmed seat is cancelled with a full refund.
export function cancelSession(actor, session, reason) {
  const seats = all("SELECT * FROM bookings WHERE session_id=? AND status IN ('held','confirmed')", session.id);
  for (const b of seats) cancelBooking(b, actor, { reason: reason || 'Session cancelled by the venue', byStaff: true });
  run("UPDATE wellness_sessions SET status='cancelled', updated_at=? WHERE id=?", now(), session.id);
  audit(actor.id, 'session.cancelled', 'session', session.id, { venueId: session.venue_id, seats: seats.length, reason });
  return seats.length;
}

export function applyCouponToHold(user, bookingId, code) {
  return transaction(() => {
    const b = one('SELECT * FROM bookings WHERE id=? AND customer_id=?', bookingId, user.id);
    if (!b) notFound('Booking not found');
    if (b.status !== 'held' || b.hold_expires_at < Date.now()) conflict('This checkout has expired. Please pick your slot again.', 'hold_expired');
    if (one("SELECT 1 FROM payments WHERE booking_id=? AND status='requires_payment'", b.id)) conflict('Payment has already started for this booking');
    let discount = 0, couponId = null;
    if (code) { const c = evaluateCoupon(code, { venueId: b.venue_id, userId: user.id, subtotal: b.subtotal, ignoreBookingId: b.id }); discount = c.discount; couponId = c.coupon.id; }
    run('UPDATE bookings SET discount=?, amount=?, coupon_id=?, updated_at=? WHERE id=?', discount, b.subtotal - discount, couponId, now(), b.id);
    return bookingView(one('SELECT * FROM bookings WHERE id=?', b.id));
  });
}

// ---- Confirmation (only ever called from a verified payment webhook, a free booking, or staff) -------------
export function confirmBooking(bookingId) {
  const b = one('SELECT * FROM bookings WHERE id=?', bookingId);
  if (b.status === 'confirmed' || b.status === 'completed') return { ok: true, already: true };
  if (b.status === 'cancelled') return { ok: false };
  if (b.status !== 'held') {
    // The hold lapsed before the payment landed. Re-take the slots if nobody else has them.
    if (b.session_id) {
      const sess = one('SELECT * FROM wellness_sessions WHERE id=?', b.session_id);
      if (!sess || sess.status !== 'scheduled' || seatsTaken(sess.id) >= sess.capacity) return { ok: false };
    } else {
      try {
        claimSlots(b, parseJson(b.slots, []));
        if (b.addon_coach_id) claimCoach(b.id, one('SELECT * FROM coaches WHERE id=?', b.addon_coach_id), b.date, parseJson(b.slots, []));
      } catch (e) { releaseSlots(b.id); if (e.status === 409) return { ok: false }; throw e; }
    }
  }
  run("UPDATE bookings SET status='confirmed', confirmed_at=?, hold_expires_at=NULL, updated_at=? WHERE id=?", now(), now(), b.id);
  const venue = one('SELECT name, timezone FROM venues WHERE id=?', b.venue_id);
  const session = b.session_id ? one('SELECT title, mode FROM wellness_sessions WHERE id=?', b.session_id) : null;
  const coachRow = b.coach_id ? one('SELECT name FROM coaches WHERE id=?', b.coach_id) : null;
  const court = session ? { name: session.title } : coachRow ? { name: `Coaching with ${coachRow.name}` } : one('SELECT name FROM courts WHERE id=?', b.court_id);
  const when = `${b.date} ${b.start_time}–${b.end_time}`;
  notify(b.customer_id, { kind: 'booking_confirmed', title: 'Booking confirmed', body: `${venue.name} · ${court.name} · ${when}. Ref ${b.ref}. ${session?.mode === 'online' ? 'Your join link is on the booking page.' : 'Show your QR code at the desk.'}`, link: `#/booking/${b.id}`, bookingId: b.id });
  const reminderAt = b.start_at - config.reminderMinutes * 60000;
  if (reminderAt > Date.now()) notify(b.customer_id, { kind: 'reminder', title: 'Game starts soon', body: `${venue.name} · ${court.name} at ${b.start_time} today. Ref ${b.ref}.`, link: `#/booking/${b.id}`, bookingId: b.id, sendAfter: reminderAt });
  rewardReferral(b);
  audit(null, 'booking.confirmed', 'booking', b.id, { venueId: b.venue_id, ref: b.ref, amount: b.amount });
  return { ok: true };
}

function rewardReferral(b) {
  if (!b.customer_id || b.amount <= 0) return;
  const customer = one('SELECT id, name, referred_by FROM users WHERE id=?', b.customer_id);
  if (!customer?.referred_by) return;
  const paid = one("SELECT COUNT(*) AS n FROM bookings WHERE customer_id=? AND status IN ('confirmed','completed') AND amount>0", b.customer_id).n;
  if (paid !== 1) return;
  const code = 'REF' + randomCode(6);
  run(`INSERT INTO coupons (id,owner_user_id,code,kind,value,max_uses,per_user_limit,description,created_at) VALUES (?,?,?,'flat',?,1,1,?,?)`,
    id(), customer.referred_by, code, config.referralRewardPaise, `Referral reward for inviting ${customer.name || 'a friend'}`, now());
  notify(customer.referred_by, { kind: 'referral_reward', title: 'You earned a referral reward', body: `${customer.name || 'Your friend'} played their first game. Use code ${code} for ${money(config.referralRewardPaise)} off your next booking.`, link: '#/profile', channels: ['inapp', 'email'] });
}

// ---- Releases ------------------------------------------------------------------------------------------------
function release(b, status, fields = {}) {
  releaseSlots(b.id);
  run(`UPDATE bookings SET status=?, hold_expires_at=NULL, updated_at=?, cancel_reason=?, cancelled_by=?, cancelled_at=? WHERE id=?`,
    status, now(), fields.reason || '', fields.by || null, status === 'cancelled' ? now() : null, b.id);
  run("UPDATE payments SET status='cancelled', updated_at=? WHERE booking_id=? AND status='requires_payment'", now(), b.id);
  cancelPending(b.id, 'reminder');
}
export function failBooking(b, reason) { release(b, 'failed', { reason }); }

export function expireHolds() {
  const stale = all("SELECT * FROM bookings WHERE status='held' AND hold_expires_at<?", Date.now());
  for (const b of stale) {
    release(b, 'expired');
    publishVenue(b.venue_id, { date: b.date, courtId: b.court_id });
    publishUser(b.customer_id, 'booking', { id: b.id, status: 'expired' });
  }
  return stale.length;
}

export function completeFinished() {
  const done = all("SELECT * FROM bookings WHERE status='confirmed' AND end_at<?", Date.now());
  for (const b of done) {
    run("UPDATE bookings SET status='completed', updated_at=? WHERE id=?", now(), b.id);
    if (b.customer_id && b.source === 'online') notify(b.customer_id, { kind: 'review_request', title: 'How was your game?', body: 'Rate the venue to help other players.', link: `#/booking/${b.id}`, bookingId: b.id, channels: ['inapp'] });
  }
  return done.length;
}

// ---- Cancellation and refunds -------------------------------------------------------------------------------
export function paidAmount(bookingId) {
  const p = one("SELECT * FROM payments WHERE booking_id=? AND status IN ('succeeded','partially_refunded','refunded') ORDER BY created_at DESC", bookingId);
  return p ? { payment: p, refundable: p.amount - p.refunded } : { payment: null, refundable: 0 };
}

export function refundQuote(b) {
  const policy = parseJson(b.policy_snapshot, {});
  const hoursLeft = (b.start_at - Date.now()) / 3600000;
  const percent = hoursLeft >= policy.fullHours ? 100 : hoursLeft >= policy.partialHours ? policy.partialPercent : 0;
  const { refundable } = paidAmount(b.id);
  return { percent, amount: Math.floor(refundable * percent / 100), refundable, hoursLeft: Math.max(0, Math.round(hoursLeft * 10) / 10), policy };
}

export function issueRefund(b, amount, { origin, actorId, reason, status = 'processed' }) {
  const { payment, refundable } = paidAmount(b.id);
  if (!payment) bad('This booking has no online payment to refund. Settle offline payments at the desk.');
  if (amount <= 0 || amount > refundable) bad(`Refund must be between ₹0.01 and ${money(refundable)}`);
  const refund = { id: id(), status, created_at: now() };
  run(`INSERT INTO refunds (id,booking_id,payment_id,amount,status,reason,origin,requested_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    refund.id, b.id, payment.id, amount, status, reason || '', origin, actorId || null, refund.created_at);
  if (status === 'processed') processRefund(refund.id, actorId);
  return one('SELECT * FROM refunds WHERE id=?', refund.id);
}

export function processRefund(refundId, actorId, note = '') {
  const r = one('SELECT * FROM refunds WHERE id=?', refundId);
  const p = one('SELECT * FROM payments WHERE id=?', r.payment_id);
  if (r.amount > p.amount - p.refunded) bad('Refund is larger than what is left on the payment');
  const { ref } = refundPayment(p, r.amount);
  const refunded = p.refunded + r.amount;
  run('UPDATE payments SET refunded=?, status=?, updated_at=? WHERE id=?', refunded, refunded >= p.amount ? 'refunded' : 'partially_refunded', now(), p.id);
  run("UPDATE refunds SET status='processed', provider_ref=?, decided_by=?, decision_note=?, decided_at=? WHERE id=?", ref, actorId || null, note, now(), r.id);
  const b = one('SELECT customer_id, ref FROM bookings WHERE id=?', r.booking_id);
  notify(b.customer_id, { kind: 'refund', title: 'Refund issued', body: `${money(r.amount)} for booking ${b.ref} is on its way back to your original payment method (usually 5–7 working days).`, link: `#/booking/${r.booking_id}`, bookingId: r.booking_id, channels: ['inapp', 'email'] });
  audit(actorId, 'refund.processed', 'refund', r.id, { venueId: one('SELECT venue_id FROM bookings WHERE id=?', r.booking_id).venue_id, amount: r.amount, origin: r.origin });
}

export function cancelBooking(b, actor, { reason = '', byStaff = false } = {}) {
  const result = transaction(() => {
    b = one('SELECT * FROM bookings WHERE id=?', b.id);
    if (b.status === 'held') { release(b, 'cancelled', { reason: reason || 'Checkout abandoned', by: actor.id }); return { refund: null }; }
    if (b.status !== 'confirmed') conflict(`A ${b.status} booking cannot be cancelled`);
    if (b.start_at <= Date.now() && !byStaff) conflict('This game has already started. Contact support if something went wrong.');
    const quote = refundQuote(b);
    const amount = byStaff ? quote.refundable : quote.amount;
    release(b, 'cancelled', { reason, by: actor.id });
    let refund = null;
    if (amount > 0) refund = issueRefund(b, amount, { origin: byStaff ? 'owner' : 'policy', actorId: actor.id, reason: byStaff ? `Cancelled by venue: ${reason}` : `Cancellation policy ${quote.percent}%` });
    if (byStaff && b.customer_id) notify(b.customer_id, { kind: 'booking_cancelled', title: 'Your booking was cancelled by the venue', body: `${b.ref} on ${b.date} at ${b.start_time}. ${reason}${amount ? ` A full refund of ${money(amount)} has been issued.` : ''}`, link: `#/booking/${b.id}`, bookingId: b.id });
    audit(actor.id, byStaff ? 'booking.cancelled_by_venue' : 'booking.cancelled', 'booking', b.id, { venueId: b.venue_id, ref: b.ref, reason, refund: amount, percent: byStaff ? 100 : quote.percent });
    return { refund };
  });
  publishVenue(b.venue_id, { date: b.date, courtId: b.court_id });
  return { booking: bookingView(one('SELECT * FROM bookings WHERE id=?', b.id)), ...result };
}

// ---- Staff bookings ------------------------------------------------------------------------------------------
export function createManualBooking(actor, venue, { courtId, date, starts, customerName, customerPhone, sport, amount, method, notes }) {
  const result = transaction(() => {
    const { court, chosen } = validateSelection(venue, courtId, date, starts, { staff: true });
    const subtotal = chosen.reduce((sum, s) => sum + s.price, 0);
    const charged = amount ?? subtotal;
    const linked = customerPhone ? one('SELECT id FROM users WHERE phone=?', customerPhone) : null;
    const first = chosen[0], last = chosen[chosen.length - 1], ts = now();
    const b = { id: id(), ref: newRef(), court_id: court.id, date };
    run(`INSERT INTO bookings (id,ref,venue_id,court_id,customer_id,customer_name,customer_phone,sport,date,start_time,end_time,start_at,end_at,slots,status,source,subtotal,discount,amount,price_snapshot,policy_snapshot,offline_method,notes,created_at,confirmed_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed','manual',?,?,?,?,?,?,?,?,?,?)`,
      b.id, b.ref, venue.id, court.id, linked?.id || null, customerName, customerPhone || '', sport || court.sports[0], date, first.start, last.end,
      zonedToEpoch(date, toMin(first.start), venue.timezone), zonedToEpoch(date, toMin(last.end), venue.timezone), JSON.stringify(chosen.map(s => s.start)),
      subtotal, Math.max(0, subtotal - charged), charged, JSON.stringify(chosen.map(s => ({ start: s.start, end: s.end, price: s.price }))), snapshotPolicy(venue), method, notes || '', ts, ts, ts);
    claimSlots(b, chosen.map(s => s.start));
    if (linked) notify(linked.id, { kind: 'booking_confirmed', title: 'Booking confirmed', body: `${venue.name} · ${court.name} · ${date} ${first.start}–${last.end}. Ref ${b.ref}.`, link: `#/booking/${b.id}`, bookingId: b.id });
    audit(actor.id, 'booking.manual_create', 'booking', b.id, { venueId: venue.id, ref: b.ref, date, starts, amount: charged, method, priceOverride: charged !== subtotal });
    return b;
  });
  publishVenue(venue.id, { date, courtId: result.court_id });
  return bookingView(one('SELECT * FROM bookings WHERE id=?', result.id));
}

// ---- Views ---------------------------------------------------------------------------------------------------
export function bookingView(b, { staff = false } = {}) {
  const venue = one('SELECT id,name,slug,address,city,lat,lng,phone,timezone,photos FROM venues WHERE id=?', b.venue_id);
  const court = one('SELECT id,name FROM courts WHERE id=?', b.court_id);
  const payment = one('SELECT id,provider,intent_id,amount,refunded,status,failure_reason,created_at FROM payments WHERE booking_id=? ORDER BY created_at DESC', b.id);
  const refunds = all('SELECT id,amount,status,reason,origin,decision_note,created_at,decided_at FROM refunds WHERE booking_id=? ORDER BY created_at', b.id);
  const review = b.coach_id ? one('SELECT id,rating,comment,reply AS owner_reply,created_at FROM coach_reviews WHERE booking_id=?', b.id) : one('SELECT id,rating,comment,owner_reply,created_at FROM reviews WHERE booking_id=?', b.id);
  const coupon = b.coupon_id ? one('SELECT code FROM coupons WHERE id=?', b.coupon_id)?.code : null;
  const view = {
    id: b.id, ref: b.ref, status: b.status, source: b.source, sport: b.sport, date: b.date, startTime: b.start_time, endTime: b.end_time,
    startAt: b.start_at, endAt: b.end_at, slots: parseJson(b.price_snapshot, []), subtotal: b.subtotal, discount: b.discount, amount: b.amount, coupon,
    policy: parseJson(b.policy_snapshot, {}), holdExpiresAt: b.status === 'held' ? b.hold_expires_at : null, checkedInAt: b.checked_in_at, noShow: !!b.no_show,
    cancelReason: b.cancel_reason, createdAt: b.created_at, confirmedAt: b.confirmed_at, cancelledAt: b.cancelled_at, offlineMethod: b.offline_method,
    venue: { ...venue, photos: parseJson(venue.photos, []) }, court, payment, refunds, review,
  };
  if (b.addon_coach_id) view.addonCoach = { ...one('SELECT id,name,specialty FROM coaches WHERE id=?', b.addon_coach_id), fee: b.coach_fee };
  if (b.coach_id) {
    const coach = one('SELECT id,name,specialty FROM coaches WHERE id=?', b.coach_id);
    view.court = { id: b.court_id, name: `Coaching with ${coach.name}` };
    view.coach = coach;
  }
  if (b.session_id) {
    const sess = one('SELECT id,title,kind,mode,trainer,join_url,status FROM wellness_sessions WHERE id=?', b.session_id);
    const paid = b.status === 'confirmed' || b.status === 'completed';
    view.court = { id: b.court_id, name: sess.title };
    view.session = { id: sess.id, title: sess.title, kind: sess.kind, mode: sess.mode, trainer: sess.trainer, status: sess.status, joinUrl: paid || staff ? sess.join_url : '' };
  }
  if (b.status === 'confirmed' && b.start_at > Date.now()) view.refundQuote = refundQuote(b);
  if (staff) Object.assign(view, { customerId: b.customer_id, customerName: b.customer_name, customerPhone: b.customer_phone, notes: b.notes });
  return view;
}

export function loadOwnBooking(user, bookingId) {
  const b = one('SELECT * FROM bookings WHERE id=?', bookingId);
  if (!b) notFound('Booking not found');
  if (b.customer_id !== user.id) forbidden();
  return b;
}
