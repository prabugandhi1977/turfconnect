// Wellness sessions: scheduled classes (yoga, meditation, fitness, aqua...) held at a venue or online. Players browse and
// book a seat (checkout reuses the normal booking flow); venue managers schedule, edit and cancel sessions.
import { all, id, now, one, parseJson, run } from '../db.js';
import { rateLimit, requireVenue } from '../security.js';
import { bookingView, cancelSession, createSessionHold, seatsTaken } from '../bookings.js';
import { idempotent } from './bookings.js';
import { zonedToEpoch, toMin, venueToday } from '../time.js';
import { audit } from '../audit.js';
import { created } from '../http.js';
import { WELLNESS_KINDS, bad, conflict, date as dateOf, int, notFound, num, oneOf, str, time as timeOf } from '../validate.js';

const MODES = ['in_person', 'online'];
const rupees = (v, name) => Math.round(num(v, name, { min: 0, max: 100000 }) * 100);

function sessionView(s, { staff = false } = {}) {
  const venue = one('SELECT id,name,slug,city,address,photos,status FROM venues WHERE id=?', s.venue_id);
  const taken = seatsTaken(s.id);
  const view = {
    id: s.id, title: s.title, kind: s.kind, mode: s.mode, description: s.description, trainer: s.trainer, date: s.date, startTime: s.start_time, endTime: s.end_time,
    startAt: s.start_at, endAt: s.end_at, capacity: s.capacity, seatsLeft: Math.max(0, s.capacity - taken), price: s.price, status: s.status,
    venue: { id: venue.id, name: venue.name, slug: venue.slug, city: venue.city, address: venue.address, photo: parseJson(venue.photos, [])[0] || null },
  };
  if (staff) Object.assign(view, { joinUrl: s.join_url, seatsTaken: taken });
  return view;
}

// Owner input. On edit (partial) the date and time are fixed: to move a session, cancel it and schedule a new one.
function sessionInput(body, venue, { partial = false } = {}) {
  const out = {
    title: str(body.title, 'Title', { min: 2, max: 80 }), kind: oneOf(body.kind, 'Type', WELLNESS_KINDS), mode: oneOf(body.mode, 'Format', MODES),
    description: str(body.description, 'Description', { max: 1000, optional: true }), trainer: str(body.trainer, 'Trainer', { max: 80, optional: true }),
    capacity: int(body.capacity, 'Seats', { min: 1, max: 500 }), price: rupees(body.price, 'Price'), joinUrl: str(body.joinUrl, 'Join link', { max: 300, optional: true }),
  };
  if (out.mode === 'online') {
    if (!/^https:\/\/\S+$/i.test(out.joinUrl)) bad('Online sessions need an https:// join link (Zoom, Meet, Teams...)');
  } else out.joinUrl = '';
  if (!partial) {
    out.date = dateOf(body.date); out.startTime = timeOf(body.startTime, 'Start time'); out.endTime = timeOf(body.endTime, 'End time');
    if (toMin(out.endTime) <= toMin(out.startTime)) bad('End time must be after the start time');
    if (out.date < venueToday(venue)) bad('Pick today or a future date');
    out.startAt = zonedToEpoch(out.date, toMin(out.startTime), venue.timezone); out.endAt = zonedToEpoch(out.date, toMin(out.endTime), venue.timezone);
    if (out.startAt <= Date.now()) bad('That start time has already passed');
  }
  return out;
}

export default function wellnessRoutes(r) {
  // ---- Players ----
  r.get('/wellness/sessions', ({ query }) => {
    const mode = oneOf(query.get('mode') || null, 'Format', MODES, { optional: true });
    const kind = oneOf(query.get('kind') || null, 'Type', WELLNESS_KINDS, { optional: true });
    const venueId = query.get('venueId');
    const day = query.get('date') ? dateOf(query.get('date')) : null;
    const rows = all(`SELECT s.* FROM wellness_sessions s JOIN venues v ON v.id=s.venue_id WHERE s.status='scheduled' AND v.status='active' AND s.start_at>?
                      ORDER BY s.start_at LIMIT 200`, Date.now())
      .filter(s => (!mode || s.mode === mode) && (!kind || s.kind === kind) && (!venueId || s.venue_id === venueId) && (!day || s.date === day));
    return rows.map(s => sessionView(s));
  }, { auth: 'none' });

  r.get('/wellness/sessions/:id', ({ params }) => {
    const s = one('SELECT * FROM wellness_sessions WHERE id=?', params.id);
    if (!s || one('SELECT status FROM venues WHERE id=?', s.venue_id).status !== 'active') notFound('Session not found');
    return sessionView(s);
  }, { auth: 'none' });

  r.post('/wellness/sessions/:id/book', ({ u, params, body, req }) => {
    rateLimit(`hold:${u.id}`, 20, 60 * 1000);
    return idempotent(u, req, 'session-hold', () => createSessionHold(u, params.id, { couponCode: str(body.couponCode, 'Promo code', { max: 40, optional: true }) }));
  });

  // ---- Venue staff ----
  r.get('/owner/venues/:vid/sessions', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    return all('SELECT * FROM wellness_sessions WHERE venue_id=? AND start_at>? ORDER BY start_at', venue.id, Date.now() - 7 * 86400000).map(s => sessionView(s, { staff: true }));
  });

  r.post('/owner/venues/:vid/sessions', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const s = sessionInput(body, venue), sid = id(), ts = now();
    run(`INSERT INTO wellness_sessions (id,venue_id,title,kind,mode,description,trainer,date,start_time,end_time,start_at,end_at,capacity,price,join_url,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, sid, venue.id, s.title, s.kind, s.mode, s.description, s.trainer, s.date, s.startTime, s.endTime, s.startAt, s.endAt, s.capacity, s.price, s.joinUrl, ts, ts);
    audit(u.id, 'session.created', 'session', sid, { venueId: venue.id, title: s.title, date: s.date, mode: s.mode });
    return created(sessionView(one('SELECT * FROM wellness_sessions WHERE id=?', sid), { staff: true }));
  });

  r.patch('/owner/venues/:vid/sessions/:sid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const cur = one('SELECT * FROM wellness_sessions WHERE id=? AND venue_id=?', params.sid, venue.id);
    if (!cur) notFound('Session not found');
    if (cur.status !== 'scheduled') conflict('A cancelled session cannot be edited');
    const s = sessionInput({ ...cur, price: cur.price / 100, joinUrl: cur.join_url, ...body }, venue, { partial: true });
    const taken = seatsTaken(cur.id);
    if (s.capacity < taken) bad(`${taken} seats are already booked, so capacity cannot go below that`);
    run('UPDATE wellness_sessions SET title=?, kind=?, mode=?, description=?, trainer=?, capacity=?, price=?, join_url=?, updated_at=? WHERE id=?',
      s.title, s.kind, s.mode, s.description, s.trainer, s.capacity, s.price, s.joinUrl, now(), cur.id);
    audit(u.id, 'session.updated', 'session', cur.id, { venueId: venue.id });
    return sessionView(one('SELECT * FROM wellness_sessions WHERE id=?', cur.id), { staff: true });
  });

  r.post('/owner/venues/:vid/sessions/:sid/cancel', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const cur = one('SELECT * FROM wellness_sessions WHERE id=? AND venue_id=?', params.sid, venue.id);
    if (!cur) notFound('Session not found');
    if (cur.status !== 'scheduled') conflict('This session is already cancelled');
    const refunded = cancelSession(u, cur, str(body.reason, 'Reason', { max: 200, optional: true }));
    return { cancelled: true, seatsRefunded: refunded };
  });

  r.get('/owner/venues/:vid/sessions/:sid/attendees', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'front_desk');
    if (!one('SELECT 1 FROM wellness_sessions WHERE id=? AND venue_id=?', params.sid, venue.id)) notFound('Session not found');
    return all("SELECT * FROM bookings WHERE session_id=? AND status IN ('held','confirmed','completed') ORDER BY created_at", params.sid)
      .map(b => bookingView(b, { staff: true })).map(b => ({ id: b.id, ref: b.ref, status: b.status, name: b.customerName, phone: b.customerPhone, checkedInAt: b.checkedInAt }));
  });
}
