// Slot grid for a venue and date: which slots exist, what they cost right now, and their state.
// States: available | almost_full | held | booked | closed. Customers see "held" without who holds it.
import { all, one, parseJson } from './db.js';
import { toMin, toHHMM, weekday, zonedParts, daysBetween } from './time.js';

const ALMOST_FULL_RATIO = 0.7;

export function slotStarts(venue) {
  const open = toMin(venue.open_time), close = toMin(venue.close_time), out = [];
  for (let t = open; t + venue.slot_minutes <= close; t += venue.slot_minutes) out.push(toHHMM(t));
  return out;
}

function ruleMatches(rule, day, start) {
  return rule.weekdays.includes(String(day)) && toMin(start) >= toMin(rule.start_time) && toMin(start) < toMin(rule.end_time);
}
// Most specific wins: a slot override, then a court rule, then a venue-wide rule (newest first), then the base price.
export function priceOf(court, date, start, rules, override) {
  if (override?.price != null) return { price: override.price, source: 'override' };
  const day = weekday(date);
  const match = rules.filter(r => ruleMatches(r, day, start))
    .sort((a, b) => (b.court_id ? 1 : 0) - (a.court_id ? 1 : 0) || b.created_at.localeCompare(a.created_at))
    .find(r => !r.court_id || r.court_id === court.id);
  return match ? { price: match.price, source: match.label || 'rule' } : { price: court.base_price, source: 'base' };
}

function blockedByRecurring(blocks, court, date, start) {
  const day = String(weekday(date)), t = toMin(start);
  return blocks.find(b => (!b.court_id || b.court_id === court.id) && b.weekdays.includes(day) && t >= toMin(b.start_time) && t < toMin(b.end_time));
}

// Returns courts with their slots for one date. withDetails adds booking refs for staff views.
export function venueDay(venue, date, { courtId = null, sport = null, withDetails = false, includeInactive = false } = {}) {
  let courts = all('SELECT * FROM courts WHERE venue_id=? ' + (includeInactive ? '' : 'AND active=1 ') + 'ORDER BY sort, name', venue.id)
    .map(c => ({ ...c, sports: parseJson(c.sports, []) }));
  if (courtId) courts = courts.filter(c => c.id === courtId);
  if (sport) courts = courts.filter(c => c.sports.includes(sport));
  const rules = all('SELECT * FROM price_rules WHERE venue_id=?', venue.id);
  const blocks = all('SELECT * FROM recurring_blocks WHERE venue_id=?', venue.id);
  const overrides = new Map(all('SELECT o.* FROM slot_overrides o JOIN courts c ON c.id=o.court_id WHERE c.venue_id=? AND o.date=?', venue.id, date).map(o => [`${o.court_id}|${o.start_time}`, o]));
  const claims = new Map(all(`SELECT s.court_id, s.start_time, b.id AS booking_id, b.ref, b.status, b.hold_expires_at, b.customer_name, b.source, b.checked_in_at,
      COALESCE(u.name, b.customer_name) AS who FROM slot_claims s JOIN bookings b ON b.id=s.booking_id LEFT JOIN users u ON u.id=b.customer_id
      JOIN courts c ON c.id=s.court_id WHERE c.venue_id=? AND s.date=?`, venue.id, date).map(c => [`${c.court_id}|${c.start_time}`, c]));

  const local = zonedParts(Date.now(), venue.timezone);
  const offset = daysBetween(local.date, date);
  const beyondWindow = offset < 0 || offset > venue.booking_window_days;
  const starts = slotStarts(venue);
  const t = Date.now();

  return courts.map(court => {
    const slots = starts.map(start => {
      const key = `${court.id}|${start}`, override = overrides.get(key), claim = claims.get(key);
      const { price, source } = priceOf(court, date, start, rules, override);
      const slot = { start, end: toHHMM(toMin(start) + venue.slot_minutes), price, state: 'available' };
      if (withDetails) slot.priceSource = source;
      const past = offset < 0 || (offset === 0 && toMin(start) <= local.minutes);
      const recurring = blockedByRecurring(blocks, court, date, start);
      if (claim && (claim.status === 'confirmed' || claim.status === 'completed')) slot.state = 'booked';
      else if (claim && claim.status === 'held' && claim.hold_expires_at > t) slot.state = 'held';
      else if (!court.active) { slot.state = 'closed'; slot.reason = 'Court inactive'; }
      else if (past) { slot.state = 'closed'; slot.reason = 'Past'; }
      else if (beyondWindow) { slot.state = 'closed'; slot.reason = 'Not open for booking yet'; }
      else if (override?.state === 'blocked') { slot.state = 'closed'; slot.reason = override.reason || 'Blocked'; slot.blocked = true; }
      else if (recurring && override?.state !== 'open') { slot.state = 'closed'; slot.reason = recurring.reason || 'Closed'; slot.recurring = true; }
      if (withDetails && claim && slot.state !== 'available') Object.assign(slot, { bookingId: claim.booking_id, ref: claim.ref, who: claim.who, source: claim.source, checkedIn: !!claim.checked_in_at });
      return slot;
    });
    const open = slots.filter(s => s.state !== 'closed' || s.reason !== 'Past');
    const taken = open.filter(s => s.state === 'booked' || s.state === 'held').length;
    const bookable = open.filter(s => s.state !== 'closed').length;
    if (bookable && taken / bookable >= ALMOST_FULL_RATIO) for (const s of slots) if (s.state === 'available') s.state = 'almost_full';
    return { id: court.id, name: court.name, sports: court.sports, surface: court.surface, indoor: !!court.indoor, active: !!court.active, basePrice: court.base_price, slots };
  });
}

export const isBookable = state => state === 'available' || state === 'almost_full';

export function venueSummary(venueId) {
  const r = one('SELECT ROUND(AVG(rating),1) AS rating, COUNT(*) AS reviews FROM reviews WHERE venue_id=? AND hidden=0', venueId);
  return { rating: r.rating || null, reviews: r.reviews };
}
