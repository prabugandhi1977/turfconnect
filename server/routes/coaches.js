// Coaches: players browse coaches, open a profile (rating, likes, comments), see free slots and book one-to-one sessions.
// Venue managers add coaches, set weekly availability and reply to reviews.
import { all, id, now, one, run, transaction } from '../db.js';
import { rateLimit, requireVenue } from '../security.js';
import { createCoachHold } from '../bookings.js';
import { coachOptions, coachSlots, coachStats, nextFreeSlot } from '../coaches.js';
import { idempotent } from './bookings.js';
import { venueToday, toMin } from '../time.js';
import { audit } from '../audit.js';
import { created } from '../http.js';
import { COACH_SPECIALTIES, bad, date as dateOf, int, notFound, num, oneOf, str, time as timeOf } from '../validate.js';

const SPECIALTIES = COACH_SPECIALTIES;
const firstName = n => (n || 'Player').split(' ')[0];
const paise = (v, name) => Math.round(num(v, name, { min: 0, max: 100000 }) * 100);

function coachView(c, u, { full = false } = {}) {
  const venue = one('SELECT id,name,slug,city,address FROM venues WHERE id=?', c.venue_id);
  const view = {
    id: c.id, name: c.name, specialty: c.specialty, scope: c.scope, bio: c.bio, experienceYears: c.experience_years, languages: c.languages.split(',').map(x => x.trim()).filter(Boolean),
    price: c.price, sessionMinutes: c.session_minutes, venue, ...coachStats(c.id), liked: !!(u && one('SELECT 1 FROM coach_likes WHERE coach_id=? AND user_id=?', c.id, u.id)), nextSlot: nextFreeSlot(c), active: !!c.active,
  };
  if (full) {
    view.histogram = [5, 4, 3, 2, 1].map(n => ({ stars: n, count: one('SELECT COUNT(*) AS c FROM coach_reviews WHERE coach_id=? AND hidden=0 AND rating=?', c.id, n).c }));
    view.reviewList = all('SELECT r.id, r.rating, r.comment, r.reply, r.created_at, u.name FROM coach_reviews r JOIN users u ON u.id=r.customer_id WHERE r.coach_id=? AND r.hidden=0 ORDER BY r.created_at DESC LIMIT 40', c.id)
      .map(r => ({ id: r.id, rating: r.rating, comment: r.comment, reply: r.reply, createdAt: r.created_at, name: firstName(r.name) }));
  }
  return view;
}

function availabilityInput(list) {
  if (!Array.isArray(list) || !list.length) bad('Add at least one weekly availability window');
  if (list.length > 28) bad('Too many availability windows');
  return list.map(w => {
    const weekday = int(w.weekday, 'Weekday', { min: 0, max: 6 }), start = timeOf(w.start, 'Start time'), end = timeOf(w.end, 'End time');
    if (toMin(end) <= toMin(start)) bad('Each window must end after it starts');
    return { weekday, start, end };
  });
}
function coachInput(body, cur = {}) {
  return {
    scope: oneOf(body.scope ?? cur.scope ?? 'game', 'Coverage', ['game', 'all']), name: str(body.name ?? cur.name, 'Name', { min: 2, max: 60 }), specialty: oneOf(body.specialty ?? cur.specialty, 'Specialty', SPECIALTIES), bio: str(body.bio ?? cur.bio, 'Bio', { max: 800, optional: true }),
    experience_years: int(body.experienceYears ?? cur.experience_years ?? 0, 'Experience', { min: 0, max: 60 }), languages: str(body.languages ?? cur.languages ?? 'English', 'Languages', { max: 100 }) || 'English',
    price: body.price === undefined ? cur.price : paise(body.price, 'Price'), session_minutes: int(body.sessionMinutes ?? cur.session_minutes ?? 60, 'Session length', { min: 15, max: 240 }),
  };
}
export const _scopeNote = 'scope: game = coaches one game (specialty), all = common coach for every game';
const saveAvailability = (coachId, list) => { run('DELETE FROM coach_availability WHERE coach_id=?', coachId); for (const w of list) run('INSERT INTO coach_availability (id,coach_id,weekday,start_time,end_time) VALUES (?,?,?,?,?)', id(), coachId, w.weekday, w.start, w.end); };

export default function coachRoutes(r) {
  // ---- Players ----
  r.get('/coaches', ({ u, query }) => {
    const sport = oneOf(query.get('sport') || null, 'Sport', SPECIALTIES, { optional: true }), venueId = query.get('venueId'), text = (query.get('q') || '').trim().toLowerCase();
    const rows = all("SELECT c.* FROM coaches c JOIN venues v ON v.id=c.venue_id WHERE c.active=1 AND v.status='active'").filter(c => (!sport || c.specialty === sport) && (!venueId || c.venue_id === venueId) && (!text || `${c.name} ${c.specialty} ${c.bio}`.toLowerCase().includes(text)));
    const list = rows.map(c => coachView(c, u));
    const sort = query.get('sort') || 'rating';
    list.sort(sort === 'price' ? (a, b) => a.price - b.price : sort === 'likes' ? (a, b) => b.likes - a.likes : (a, b) => (b.rating || 0) - (a.rating || 0) || b.reviews - a.reviews);
    return list;
  }, { auth: 'optional' });

  r.get('/coaches/:id', ({ u, params }) => {
    const c = one("SELECT c.* FROM coaches c JOIN venues v ON v.id=c.venue_id WHERE c.id=? AND c.active=1 AND v.status='active'", params.id);
    if (!c) notFound('Coach not found');
    return coachView(c, u, { full: true });
  }, { auth: 'optional' });

  r.get('/coaches/:id/slots', ({ params, query }) => {
    const c = one('SELECT * FROM coaches WHERE id=? AND active=1', params.id);
    if (!c) notFound('Coach not found');
    const date = dateOf(query.get('date') || venueToday(one('SELECT * FROM venues WHERE id=?', c.venue_id)));
    return { date, sessionMinutes: c.session_minutes, price: c.price, slots: coachSlots(c, date).map(({ start, end, state }) => ({ start, end, state })) };
  }, { auth: 'none' });

  r.post('/coaches/:id/like', ({ u, params }) => {
    rateLimit(`like:${u.id}`, 60, 60 * 1000);
    if (!one('SELECT 1 FROM coaches WHERE id=? AND active=1', params.id)) notFound('Coach not found');
    const had = one('SELECT 1 FROM coach_likes WHERE coach_id=? AND user_id=?', params.id, u.id);
    if (had) run('DELETE FROM coach_likes WHERE coach_id=? AND user_id=?', params.id, u.id);
    else run('INSERT INTO coach_likes (coach_id,user_id,created_at) VALUES (?,?,?)', params.id, u.id, now());
    return { liked: !had, likes: one('SELECT COUNT(*) AS n FROM coach_likes WHERE coach_id=?', params.id).n };
  });

  r.post('/coaches/:id/book', ({ u, params, body, req }) => {
    rateLimit(`hold:${u.id}`, 20, 60 * 1000);
    return idempotent(u, req, 'coach-hold', () => createCoachHold(u, params.id, { date: dateOf(body.date), start: timeOf(body.start, 'Start time'), couponCode: str(body.couponCode, 'Promo code', { max: 40, optional: true }) }));
  });

  // Coaches a player can add to a turf slot: those who cover the game (or all games) and are free for every chosen slot.
  r.get('/venues/:id/coach-options', ({ params, query }) => {
    const venue = one("SELECT * FROM venues WHERE id=? AND status='active'", params.id);
    if (!venue) notFound('Venue not found');
    const starts = (query.get('starts') || '').split(',').filter(Boolean).map(s => timeOf(s, 'Slot'));
    if (!starts.length || starts.length > 6) bad('Choose 1 to 6 slots');
    return { options: coachOptions(venue, dateOf(query.get('date')), query.get('sport') || null, starts) };
  }, { auth: 'none' });

  // ---- Venue staff ----
  const ownerView = c => ({ ...coachView(c, null, { full: true }), availability: all('SELECT weekday, start_time AS start, end_time AS end FROM coach_availability WHERE coach_id=? ORDER BY weekday, start_time', c.id) });
  r.get('/owner/venues/:vid/coaches', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    return all('SELECT * FROM coaches WHERE venue_id=? ORDER BY name', venue.id).map(ownerView);
  });
  r.post('/owner/venues/:vid/coaches', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const f = coachInput(body), avail = availabilityInput(body.availability), cid = id(), court = id(), ts = now();
    if (f.price === undefined) bad('Price is required');
    transaction(() => {
      run("INSERT INTO courts (id,venue_id,name,sports,surface,indoor,base_price,active,sort) VALUES (?,?,?,?,'concrete',1,0,0,998)", court, venue.id, `Coach: ${f.name}`, '[]');
      run('INSERT INTO coaches (id,venue_id,court_id,name,specialty,scope,bio,experience_years,languages,price,session_minutes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', cid, venue.id, court, f.name, f.specialty, f.scope, f.bio, f.experience_years, f.languages, f.price, f.session_minutes, ts, ts);
      saveAvailability(cid, avail);
    });
    audit(u.id, 'coach.created', 'coach', cid, { venueId: venue.id, name: f.name });
    return created(ownerView(one('SELECT * FROM coaches WHERE id=?', cid)));
  });
  r.patch('/owner/venues/:vid/coaches/:cid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const cur = one('SELECT * FROM coaches WHERE id=? AND venue_id=?', params.cid, venue.id);
    if (!cur) notFound('Coach not found');
    const f = coachInput(body, cur);
    transaction(() => {
      run('UPDATE coaches SET name=?, specialty=?, scope=?, bio=?, experience_years=?, languages=?, price=?, session_minutes=?, active=?, updated_at=? WHERE id=?', f.name, f.specialty, f.scope, f.bio, f.experience_years, f.languages, f.price, f.session_minutes, body.active === undefined ? cur.active : (body.active ? 1 : 0), now(), cur.id);
      if (body.availability !== undefined) saveAvailability(cur.id, availabilityInput(body.availability));
    });
    audit(u.id, 'coach.updated', 'coach', cur.id, { venueId: venue.id });
    return ownerView(one('SELECT * FROM coaches WHERE id=?', cur.id));
  });
  r.post('/owner/venues/:vid/coaches/:cid/reviews/:rid/reply', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const rev = one('SELECT r.id FROM coach_reviews r JOIN coaches c ON c.id=r.coach_id WHERE r.id=? AND c.id=? AND c.venue_id=?', params.rid, params.cid, venue.id);
    if (!rev) notFound('Review not found');
    run('UPDATE coach_reviews SET reply=? WHERE id=?', str(body.reply, 'Reply', { min: 2, max: 500 }), rev.id);
    return { ok: true };
  });
}
