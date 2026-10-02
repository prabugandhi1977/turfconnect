// Coach slots, ratings and the coach add-on for turf bookings. A coach with no weekly windows works whenever the turf is open;
// otherwise only inside their windows. A slot is taken when the coach's hidden court has a claim for it (held or confirmed).
import { all, one, run } from './db.js';
import { bad, conflict } from './validate.js';
import { toHHMM, toMin, venueToday, weekday, zonedToEpoch, addDays, daysBetween } from './time.js';

export const COACH_WINDOW_DAYS = 30;

function windows(coach, venue, date) {
  const any = one('SELECT 1 FROM coach_availability WHERE coach_id=?', coach.id);
  if (!any) return [{ start_time: venue.open_time, end_time: venue.close_time }];       // follows the turf's open hours
  return all('SELECT start_time, end_time FROM coach_availability WHERE coach_id=? AND weekday=? ORDER BY start_time', coach.id, weekday(date));
}

export function coachSlots(coach, date, venue = one('SELECT * FROM venues WHERE id=?', coach.venue_id)) {
  const today = venueToday(venue), offset = daysBetween(today, date);
  if (offset < 0 || offset > COACH_WINDOW_DAYS) return [];
  const taken = busyRanges(coach, date);
  const slots = [];
  for (const r of windows(coach, venue, date)) {
    for (let m = toMin(r.start_time); m + coach.session_minutes <= toMin(r.end_time); m += coach.session_minutes) {
      const startAt = zonedToEpoch(date, m, venue.timezone);
      if (startAt <= Date.now()) continue;
      slots.push({ start: toHHMM(m), end: toHHMM(m + coach.session_minutes), startAt, state: taken.some(([a, b]) => m < b && m + coach.session_minutes > a) ? 'booked' : 'available' });
    }
  }
  return slots;
}

// A claim blocks the coach from its start for the longer of a session or a turf slot, so mixed lengths never overlap.
function busyRanges(coach, date) {
  const venue = one('SELECT slot_minutes FROM venues WHERE id=?', coach.venue_id), len = Math.max(coach.session_minutes, venue?.slot_minutes || 60);
  return all('SELECT start_time FROM slot_claims WHERE court_id=? AND date=?', coach.court_id, date).map(r => [toMin(r.start_time), toMin(r.start_time) + len]);
}

export function nextFreeSlot(coach) {
  const venue = one('SELECT * FROM venues WHERE id=?', coach.venue_id), today = venueToday(venue);
  for (let d = 0; d <= 14; d++) {
    const date = addDays(today, d), free = coachSlots(coach, date, venue).find(s => s.state === 'available');
    if (free) return { date, start: free.start };
  }
  return null;
}

export function coachStats(coachId) {
  const r = one('SELECT ROUND(AVG(rating),1) AS rating, COUNT(*) AS reviews FROM coach_reviews WHERE coach_id=? AND hidden=0', coachId);
  const likes = one('SELECT COUNT(*) AS n FROM coach_likes WHERE coach_id=?', coachId).n;
  return { rating: r.rating, reviews: r.reviews, likes };
}

// ---- Coach add-on: bring a coach along to a turf slot ------------------------------------------------------------------
const feePerSlot = (coach, venue) => Math.round(coach.price * venue.slot_minutes / coach.session_minutes / 100) * 100;

function freeForSlots(coach, venue, date, starts) {
  const busy = busyRanges(coach, date), ranges = windows(coach, venue, date).map(r => [toMin(r.start_time), toMin(r.end_time)]);
  return starts.every(s => { const a = toMin(s), b = a + venue.slot_minutes; return ranges.some(([from, to]) => a >= from && b <= to) && !busy.some(([x, y]) => a < y && b > x); });
}

// Coaches who cover this game (or all games) and are free for every chosen slot.
export function coachOptions(venue, date, sport, starts) {
  return all('SELECT * FROM coaches WHERE venue_id=? AND active=1 ORDER BY scope DESC, name', venue.id)
    .filter(c => (c.scope === 'all' || !sport || c.specialty === sport) && freeForSlots(c, venue, date, starts))
    .map(c => ({ id: c.id, name: c.name, specialty: c.specialty, scope: c.scope, feePerSlot: feePerSlot(c, venue), fee: feePerSlot(c, venue) * starts.length, ...coachStats(c.id) }));
}

export function coachForSlots(venue, coachId, date, starts, sport) {
  const c = one('SELECT * FROM coaches WHERE id=? AND venue_id=? AND active=1', coachId, venue.id);
  if (!c) bad('That coach is not available at this venue');
  if (c.scope !== 'all' && sport && c.specialty !== sport) bad(`${c.name} coaches ${c.specialty}, not ${sport}`);
  if (!freeForSlots(c, venue, date, starts)) conflict(`${c.name} is not free for all of those slots`, 'coach_unavailable');
  return { id: c.id, name: c.name, court_id: c.court_id, feePerSlot: feePerSlot(c, venue) };
}

export function claimCoach(bookingId, coach, date, starts) {
  try { for (const s of starts) run('INSERT INTO slot_claims (court_id,date,start_time,booking_id) VALUES (?,?,?,?)', coach.court_id, date, s, bookingId); }
  catch (e) { if (String(e.message).includes('UNIQUE') || String(e.message).includes('PRIMARY')) conflict(`${coach.name} was just booked for one of those times. Pick another coach or time.`, 'coach_unavailable'); throw e; }
}
