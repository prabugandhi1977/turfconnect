import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, all, id, now, one, parseJson, run, transaction } from '../db.js';
import { requireVenue, canAtLeast } from '../security.js';
import { venueDay } from '../availability.js';
import { bookingView, cancelBooking, createManualBooking, issueRefund, processRefund } from '../bookings.js';
import { venueReport } from '../reports.js';
import { venueToday, addDays, daysBetween, toMin } from '../time.js';
import { publishVenue } from '../events.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { created } from '../http.js';
import { userView } from './auth.js';
import {
  SPORTS, SURFACES, amenityList, bad, bool, conflict, date as dateOf, email as emailOf, forbidden, int, notFound, num, oneOf,
  phone as phoneOf, sportList, str, time as timeOf, weekdays as weekdaysOf,
} from '../validate.js';

export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60) || 'venue';
function uniqueSlug(name) { const base = slugify(name); let slug = base, n = 2; while (one('SELECT 1 FROM venues WHERE slug=?', slug)) slug = `${base}-${n++}`; return slug; }
const rupees = (v, name) => Math.round(num(v, name, { min: 0, max: 1000000 }) * 100);

function venueConfig(venue, role) {
  const v = { ...venue, amenities: parseJson(venue.amenities, []), photos: parseJson(venue.photos, []), role };
  v.courts = all('SELECT * FROM courts WHERE venue_id=? ORDER BY sort, name', venue.id).map(c => ({ ...c, sports: parseJson(c.sports, []), indoor: !!c.indoor, active: !!c.active }));
  v.priceRules = all('SELECT * FROM price_rules WHERE venue_id=? ORDER BY start_time', venue.id);
  v.recurringBlocks = all('SELECT * FROM recurring_blocks WHERE venue_id=? ORDER BY start_time', venue.id);
  if (!canAtLeast(role, 'owner')) for (const k of ['tax_id', 'payout_holder', 'payout_bank', 'payout_last4']) delete v[k];
  v.today = venueToday(venue);
  return v;
}

function courtInput(body) {
  return {
    name: str(body.name, 'Court name', { min: 1, max: 60 }), sports: sportList(body.sports), surface: oneOf(body.surface || 'artificial_grass', 'Surface', SURFACES),
    indoor: bool(body.indoor) ? 1 : 0, base_price: rupees(body.basePrice, 'Base price'),
  };
}

// Fields a manager may change vs. those reserved for the owner (business identity and payouts).
const OPERATIONAL = {
  name: b => str(b.name, 'Venue name', { min: 2, max: 80 }), description: b => str(b.description, 'Description', { max: 2000 }),
  address: b => str(b.address, 'Address', { min: 5, max: 300 }), city: b => str(b.city, 'City', { min: 2, max: 60 }),
  lat: b => num(b.lat, 'Latitude', { min: -90, max: 90 }), lng: b => num(b.lng, 'Longitude', { min: -180, max: 180 }),
  phone: b => phoneOf(b.phone, { optional: true }), open_time: b => timeOf(b.open_time, 'Opening time'), close_time: b => timeOf(b.close_time, 'Closing time', { allow24: true }),
  slot_minutes: b => int(b.slot_minutes, 'Slot length', { min: 30, max: 180 }), hold_minutes: b => int(b.hold_minutes, 'Checkout hold', { min: 3, max: 30 }),
  booking_window_days: b => int(b.booking_window_days, 'Booking window', { min: 1, max: 90 }),
  cancel_full_hours: b => int(b.cancel_full_hours, 'Full refund notice', { min: 0, max: 720 }), cancel_partial_hours: b => int(b.cancel_partial_hours, 'Partial refund notice', { min: 0, max: 720 }),
  cancel_partial_percent: b => int(b.cancel_partial_percent, 'Partial refund %', { min: 0, max: 100 }),
  amenities: b => JSON.stringify(amenityList(b.amenities)), rules: b => str(b.rules, 'Rules', { max: 3000 }),
  indoor: b => bool(b.indoor) ? 1 : 0, lighting: b => bool(b.lighting) ? 1 : 0, surface: b => oneOf(b.surface, 'Surface', SURFACES),
  video_url: b => { const u = str(b.video_url, 'Video link', { max: 300, optional: true }); if (u && !/^https:\/\//.test(u)) bad('Video link must start with https://'); return u; },
};
const BUSINESS = {
  business_name: b => str(b.business_name, 'Business name', { max: 120 }), tax_id: b => str(b.tax_id, 'GST / tax ID', { max: 30, optional: true }),
  payout_holder: b => str(b.payout_holder, 'Account holder', { max: 120 }), payout_bank: b => str(b.payout_bank, 'Bank', { max: 80 }),
  payout_last4: b => { const v = str(b.payout_last4, 'Account last 4 digits', { max: 4 }); if (v && !/^\d{4}$/.test(v)) bad('Enter only the last 4 digits of the account'); return v; },
};
function checkHours(v) {
  if (toMin(v.close_time) <= toMin(v.open_time)) bad('Closing time must be after opening time');
  if (toMin(v.close_time) - toMin(v.open_time) < v.slot_minutes) bad('Opening hours must fit at least one slot');
  if (v.cancel_partial_hours > v.cancel_full_hours) bad('Partial-refund notice must be shorter than full-refund notice');
}

function loadBooking(venueId, bookingId) {
  const b = one('SELECT * FROM bookings WHERE id=? AND venue_id=?', bookingId, venueId);
  if (!b) notFound('Booking not found'); return b;
}
function range(query, venue, defaultDays = 30) {
  const to = query.get('to') ? dateOf(query.get('to'), 'To') : venueToday(venue);
  const from = query.get('from') ? dateOf(query.get('from'), 'From') : addDays(to, -(defaultDays - 1));
  if (daysBetween(from, to) < 0) bad('From must be before To');
  if (daysBetween(from, to) > 366) bad('Pick a range of a year or less');
  return { from, to };
}

export default function ownerRoutes(r) {
  // ---- Onboarding ----------------------------------------------------------------------------------------------
  r.post('/owner/venues', ({ u, body }) => {
    const v = { id: id() };
    for (const [k, f] of Object.entries({ ...OPERATIONAL, ...BUSINESS })) if (body[k] !== undefined) v[k] = f(body);
    for (const k of ['name', 'address', 'city', 'lat', 'lng', 'business_name', 'payout_holder', 'payout_bank', 'payout_last4']) if (v[k] === undefined || v[k] === '') bad(`${k.replace('_', ' ')} is required`);
    const defaults = { open_time: '06:00', close_time: '23:00', slot_minutes: 60, cancel_full_hours: 24, cancel_partial_hours: 6 };
    checkHours({ ...defaults, ...v });
    if (!Array.isArray(body.courts) || !body.courts.length) bad('Add at least one court or turf');
    const courts = body.courts.slice(0, 20).map(courtInput);
    transaction(() => {
      const cols = Object.keys(v).filter(k => k !== 'id');
      run(`INSERT INTO venues (id,owner_id,slug,status,created_at,updated_at,${cols.join(',')}) VALUES (?,?,?,'pending',?,?,${cols.map(() => '?').join(',')})`,
        v.id, u.id, uniqueSlug(v.name), now(), now(), ...cols.map(k => v[k]));
      courts.forEach((c, i) => run('INSERT INTO courts (id,venue_id,name,sports,surface,indoor,base_price,sort) VALUES (?,?,?,?,?,?,?,?)', id(), v.id, c.name, JSON.stringify(c.sports), c.surface, c.indoor, c.base_price, i));
      if (u.role === 'customer') run("UPDATE users SET role='owner' WHERE id=?", u.id);
      audit(u.id, 'venue.submitted', 'venue', v.id, { venueId: v.id, name: v.name });
      for (const admin of all("SELECT id FROM users WHERE role='admin' AND active=1")) notify(admin.id, { kind: 'venue_review', title: 'New venue waiting for verification', body: `${v.name}, ${v.city}`, link: '#/admin', channels: ['inapp'] });
    });
    return created({ venue: venueConfig(one('SELECT * FROM venues WHERE id=?', v.id), 'owner'), user: userView(one('SELECT * FROM users WHERE id=?', u.id)) });
  });

  r.get('/owner/venues/:vid', ({ u, params }) => { const { venue, role } = requireVenue(u, params.vid); return venueConfig(venue, role); });

  r.patch('/owner/venues/:vid', ({ u, params, body }) => {
    const { venue, role } = requireVenue(u, params.vid, 'manager');
    const changes = {};
    for (const [k, f] of Object.entries(OPERATIONAL)) if (body[k] !== undefined) changes[k] = f(body);
    for (const [k, f] of Object.entries(BUSINESS)) if (body[k] !== undefined) { if (!canAtLeast(role, 'owner')) forbidden('Only the owner can change business and payout details'); changes[k] = f(body); }
    if (!Object.keys(changes).length) bad('Nothing to update');
    checkHours({ ...venue, ...changes });
    run(`UPDATE venues SET ${Object.keys(changes).map(k => `${k}=?`).join(',')}, updated_at=? WHERE id=?`, ...Object.values(changes), now(), venue.id);
    // Payout details are recorded as "changed" only, so the audit log never holds account data.
    const masked = k => k in BUSINESS ? '(changed)' : undefined;
    audit(u.id, 'venue.updated', 'venue', venue.id, { venueId: venue.id,
      before: Object.fromEntries(Object.keys(changes).map(k => [k, masked(k) ?? venue[k]])), after: Object.fromEntries(Object.keys(changes).map(k => [k, masked(k) ?? changes[k]])) });
    publishVenue(venue.id, { config: true });
    return venueConfig(one('SELECT * FROM venues WHERE id=?', venue.id), role);
  });

  r.post('/owner/venues/:vid/photos', ({ u, params, body }) => {
    const { venue, role } = requireVenue(u, params.vid, 'manager');
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
    if (!m) bad('Upload a PNG, JPEG or WebP image');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 3 * 1024 * 1024) bad('Images must be 3 MB or smaller');
    const photos = parseJson(venue.photos, []);
    if (photos.length >= 12) bad('A venue can have up to 12 photos');
    const name = `${id()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    writeFileSync(join(UPLOAD_DIR, name), buf);
    photos.push(`/uploads/${name}`);
    run('UPDATE venues SET photos=?, updated_at=? WHERE id=?', JSON.stringify(photos), now(), venue.id);
    audit(u.id, 'venue.photo_added', 'venue', venue.id, { venueId: venue.id, photo: name });
    return venueConfig(one('SELECT * FROM venues WHERE id=?', venue.id), role);
  }, { limit: 5 * 1024 * 1024 });

  r.delete('/owner/venues/:vid/photos', ({ u, params, body }) => {
    const { venue, role } = requireVenue(u, params.vid, 'manager');
    const photos = parseJson(venue.photos, []);
    if (!photos.includes(body.url)) notFound('Photo not found');
    run('UPDATE venues SET photos=?, updated_at=? WHERE id=?', JSON.stringify(photos.filter(p => p !== body.url)), now(), venue.id);
    if (body.url.startsWith('/uploads/')) try { unlinkSync(join(UPLOAD_DIR, body.url.slice(9).replace(/[\\/]/g, ''))); } catch {}
    audit(u.id, 'venue.photo_removed', 'venue', venue.id, { venueId: venue.id, photo: body.url });
    return venueConfig(one('SELECT * FROM venues WHERE id=?', venue.id), role);
  });

  // ---- Courts, pricing, recurring closures --------------------------------------------------------------------
  r.post('/owner/venues/:vid/courts', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const c = courtInput(body), cid = id();
    run('INSERT INTO courts (id,venue_id,name,sports,surface,indoor,base_price,sort) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM courts WHERE venue_id=?))', cid, venue.id, c.name, JSON.stringify(c.sports), c.surface, c.indoor, c.base_price, venue.id);
    audit(u.id, 'court.created', 'court', cid, { venueId: venue.id, ...c });
    publishVenue(venue.id, { config: true });
    return created({ id: cid });
  });
  r.patch('/owner/venues/:vid/courts/:cid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const court = one('SELECT * FROM courts WHERE id=? AND venue_id=?', params.cid, venue.id);
    if (!court) notFound('Court not found');
    const c = courtInput({ name: court.name, sports: parseJson(court.sports, []), surface: court.surface, indoor: court.indoor, basePrice: court.base_price / 100, ...body });
    const active = body.active === undefined ? court.active : bool(body.active) ? 1 : 0;
    if (!active && court.active) {
      const upcoming = one("SELECT COUNT(*) AS n FROM bookings WHERE court_id=? AND status IN ('held','confirmed') AND end_at>?", court.id, Date.now()).n;
      if (upcoming) conflict(`This court has ${upcoming} upcoming booking(s). Cancel or move them before deactivating it.`);
    }
    run('UPDATE courts SET name=?, sports=?, surface=?, indoor=?, base_price=?, active=? WHERE id=?', c.name, JSON.stringify(c.sports), c.surface, c.indoor, c.base_price, active, court.id);
    audit(u.id, 'court.updated', 'court', court.id, { venueId: venue.id, before: { ...court, sports: parseJson(court.sports, []) }, after: { ...c, active } });
    publishVenue(venue.id, { config: true });
    return { ok: true };
  });

  r.post('/owner/venues/:vid/price-rules', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const rule = { id: id(), court_id: body.courtId || null, label: str(body.label, 'Label', { max: 40, optional: true }), weekdays: weekdaysOf(body.weekdays),
      start_time: timeOf(body.startTime, 'From'), end_time: timeOf(body.endTime, 'To', { allow24: true }), price: rupees(body.price, 'Price') };
    if (rule.court_id && !one('SELECT 1 FROM courts WHERE id=? AND venue_id=?', rule.court_id, venue.id)) notFound('Court not found');
    if (toMin(rule.end_time) <= toMin(rule.start_time)) bad('End time must be after start time');
    run('INSERT INTO price_rules (id,venue_id,court_id,label,weekdays,start_time,end_time,price,created_at) VALUES (?,?,?,?,?,?,?,?,?)', rule.id, venue.id, rule.court_id, rule.label, rule.weekdays, rule.start_time, rule.end_time, rule.price, now());
    // Price changes only affect new holds: existing bookings keep their price_snapshot.
    audit(u.id, 'pricing.rule_added', 'price_rule', rule.id, { venueId: venue.id, ...rule });
    publishVenue(venue.id, { config: true });
    return created(rule);
  });
  r.delete('/owner/venues/:vid/price-rules/:rid', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const rule = one('SELECT * FROM price_rules WHERE id=? AND venue_id=?', params.rid, venue.id);
    if (!rule) notFound('Rule not found');
    run('DELETE FROM price_rules WHERE id=?', rule.id);
    audit(u.id, 'pricing.rule_removed', 'price_rule', rule.id, { venueId: venue.id, ...rule });
    publishVenue(venue.id, { config: true });
    return { ok: true };
  });

  r.post('/owner/venues/:vid/recurring-blocks', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const blk = { id: id(), court_id: body.courtId || null, weekdays: weekdaysOf(body.weekdays), start_time: timeOf(body.startTime, 'From'), end_time: timeOf(body.endTime, 'To', { allow24: true }), reason: str(body.reason, 'Reason', { max: 80, optional: true }) };
    if (blk.court_id && !one('SELECT 1 FROM courts WHERE id=? AND venue_id=?', blk.court_id, venue.id)) notFound('Court not found');
    if (toMin(blk.end_time) <= toMin(blk.start_time)) bad('End time must be after start time');
    run('INSERT INTO recurring_blocks (id,venue_id,court_id,weekdays,start_time,end_time,reason,created_at) VALUES (?,?,?,?,?,?,?,?)', blk.id, venue.id, blk.court_id, blk.weekdays, blk.start_time, blk.end_time, blk.reason, now());
    audit(u.id, 'schedule.recurring_block_added', 'recurring_block', blk.id, { venueId: venue.id, ...blk });
    publishVenue(venue.id, { config: true });
    return created(blk);
  });
  r.delete('/owner/venues/:vid/recurring-blocks/:bid', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const blk = one('SELECT * FROM recurring_blocks WHERE id=? AND venue_id=?', params.bid, venue.id);
    if (!blk) notFound('Closure not found');
    run('DELETE FROM recurring_blocks WHERE id=?', blk.id);
    audit(u.id, 'schedule.recurring_block_removed', 'recurring_block', blk.id, { venueId: venue.id, ...blk });
    publishVenue(venue.id, { config: true });
    return { ok: true };
  });

  // ---- Calendar ------------------------------------------------------------------------------------------------
  r.get('/owner/venues/:vid/calendar', ({ u, params, query }) => {
    const { venue } = requireVenue(u, params.vid);
    const date = dateOf(query.get('date') || venueToday(venue));
    return { date, today: venueToday(venue), slotMinutes: venue.slot_minutes, courts: venueDay(venue, date, { withDetails: true, includeInactive: false }) };
  });

  // Block, re-open or re-price individual slots. Booked/held slots cannot be blocked.
  r.put('/owner/venues/:vid/slots', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const action = oneOf(body.action, 'Action', ['block', 'open', 'price', 'reset']);
    const date = dateOf(body.date);
    if (!Array.isArray(body.starts) || !body.starts.length || body.starts.length > 48) bad('Pick at least one slot');
    const courtIds = Array.isArray(body.courtIds) ? body.courtIds : [body.courtId];
    const price = action === 'price' ? rupees(body.price, 'Price') : null;
    const reason = str(body.reason, 'Reason', { max: 80, optional: true });
    transaction(() => {
      for (const courtId of courtIds) {
        const court = venueDay(venue, date, { courtId, withDetails: true, includeInactive: true })[0];
        if (!court) notFound('Court not found');
        for (const start of body.starts) {
          const slot = court.slots.find(s => s.start === start);
          if (!slot) bad(`${start} is not a slot at this venue`);
          if (action === 'block' && (slot.state === 'booked' || slot.state === 'held')) conflict(`${court.name} ${start} already has a booking. Cancel it first.`);
          const existing = one('SELECT * FROM slot_overrides WHERE court_id=? AND date=? AND start_time=?', courtId, date, start);
          const next = { state: existing?.state ?? null, price: existing?.price ?? null, reason: existing?.reason ?? '' };
          if (action === 'block') Object.assign(next, { state: 'blocked', reason: reason || 'Blocked by venue' });
          if (action === 'open') Object.assign(next, { state: slot.recurring ? 'open' : null, reason: '' });
          if (action === 'price') next.price = price;
          if (action === 'reset') Object.assign(next, { state: null, price: null, reason: '' });
          if (next.state == null && next.price == null) run('DELETE FROM slot_overrides WHERE court_id=? AND date=? AND start_time=?', courtId, date, start);
          else run(`INSERT INTO slot_overrides (court_id,date,start_time,state,price,reason,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT (court_id,date,start_time) DO UPDATE SET state=excluded.state, price=excluded.price, reason=excluded.reason, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
            courtId, date, start, next.state, next.price, next.reason, u.id, now());
        }
      }
      audit(u.id, `slots.${action}`, 'slot', `${date}`, { venueId: venue.id, courtIds, starts: body.starts, price, reason });
    });
    publishVenue(venue.id, { date });
    return { ok: true };
  });

  // ---- Bookings ------------------------------------------------------------------------------------------------
  r.get('/owner/venues/:vid/bookings', ({ u, params, query }) => {
    const { venue } = requireVenue(u, params.vid);
    const q = (query.get('q') || '').trim();
    const status = query.get('status');
    const args = [venue.id]; let where = 'b.venue_id=?';
    if (q) { where += ' AND (b.ref LIKE ? OR b.customer_name LIKE ? OR b.customer_phone LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)'; args.push(...Array(5).fill(`%${q}%`)); }
    else { const { from, to } = range(query, venue, 1); where += ' AND b.date BETWEEN ? AND ?'; args.push(from, to); }
    if (status) { where += ' AND b.status=?'; args.push(status); } else where += " AND b.status IN ('held','confirmed','completed','cancelled')";
    return all(`SELECT b.* FROM bookings b LEFT JOIN users u ON u.id=b.customer_id WHERE ${where} ORDER BY b.date, b.start_time LIMIT 300`, ...args)
      .map(b => bookingView(b, { staff: true }));
  });
  r.get('/owner/venues/:vid/bookings/:bid', ({ u, params }) => { requireVenue(u, params.vid); return bookingView(loadBooking(params.vid, params.bid), { staff: true }); });

  r.post('/owner/venues/:vid/bookings', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid);
    const b = createManualBooking(u, venue, {
      courtId: str(body.courtId, 'Court', { min: 1 }), date: dateOf(body.date), starts: body.starts,
      customerName: str(body.customerName, 'Customer name', { min: 2, max: 80 }), customerPhone: phoneOf(body.customerPhone, { optional: true }),
      sport: oneOf(body.sport || null, 'Sport', SPORTS, { optional: true }), amount: body.amount === undefined || body.amount === '' ? undefined : rupees(body.amount, 'Amount'),
      method: oneOf(body.method || 'cash', 'Payment method', ['cash', 'upi', 'card_terminal', 'unpaid', 'complimentary']), notes: str(body.notes, 'Notes', { max: 300, optional: true }),
    });
    return created(b);
  });

  r.post('/owner/venues/:vid/bookings/:bid/cancel', ({ u, params, body }) => {
    requireVenue(u, params.vid, 'manager');
    return cancelBooking(loadBooking(params.vid, params.bid), u, { reason: str(body.reason, 'Reason', { min: 3, max: 300 }), byStaff: true });
  });

  r.post('/owner/venues/:vid/bookings/:bid/check-in', ({ u, params }) => {
    requireVenue(u, params.vid);
    const b = loadBooking(params.vid, params.bid);
    if (!['confirmed', 'completed'].includes(b.status)) conflict(`This booking is ${b.status} and cannot be checked in`);
    if (b.checked_in_at) conflict(`Already checked in at ${new Date(b.checked_in_at).toLocaleTimeString()}`);
    run('UPDATE bookings SET checked_in_at=?, no_show=0, updated_at=? WHERE id=?', now(), now(), b.id);
    audit(u.id, 'booking.checked_in', 'booking', b.id, { venueId: b.venue_id, ref: b.ref });
    publishVenue(b.venue_id, { date: b.date });
    return bookingView(loadBooking(params.vid, b.id), { staff: true });
  });

  // QR scan or typed reference at the front desk.
  r.post('/owner/venues/:vid/lookup', ({ u, params, body }) => {
    requireVenue(u, params.vid);
    const ref = str(body.code, 'Booking code', { min: 4, max: 40 }).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const b = one('SELECT * FROM bookings WHERE ref=? AND venue_id=?', ref, params.vid);
    if (!b) notFound('No booking with that code at this venue');
    return bookingView(b, { staff: true });
  });

  r.post('/owner/venues/:vid/bookings/:bid/no-show', ({ u, params }) => {
    requireVenue(u, params.vid);
    const b = loadBooking(params.vid, params.bid);
    if (b.start_at > Date.now()) conflict('You can mark a no-show only after the start time');
    if (!['confirmed', 'completed'].includes(b.status)) conflict(`This booking is ${b.status}`);
    run('UPDATE bookings SET no_show=1, updated_at=? WHERE id=?', now(), b.id);
    audit(u.id, 'booking.no_show', 'booking', b.id, { venueId: b.venue_id, ref: b.ref });
    return bookingView(loadBooking(params.vid, b.id), { staff: true });
  });

  // Only notes are editable; on completed bookings every edit keeps the previous value in the audit log.
  r.patch('/owner/venues/:vid/bookings/:bid', ({ u, params, body }) => {
    requireVenue(u, params.vid);
    const b = loadBooking(params.vid, params.bid);
    const notes = str(body.notes, 'Notes', { max: 300, optional: true });
    run('UPDATE bookings SET notes=?, updated_at=? WHERE id=?', notes, now(), b.id);
    audit(u.id, 'booking.edited', 'booking', b.id, { venueId: b.venue_id, ref: b.ref, status: b.status, before: { notes: b.notes }, after: { notes } });
    return bookingView(loadBooking(params.vid, b.id), { staff: true });
  });

  // ---- Refunds -------------------------------------------------------------------------------------------------
  r.get('/owner/venues/:vid/refunds', ({ u, params, query }) => {
    requireVenue(u, params.vid, 'manager');
    const status = query.get('status');
    return all(`SELECT r.*, b.ref, b.date, b.start_time, COALESCE(u.name, b.customer_name) AS customer FROM refunds r JOIN bookings b ON b.id=r.booking_id LEFT JOIN users u ON u.id=b.customer_id
                WHERE b.venue_id=? ${status ? 'AND r.status=?' : ''} ORDER BY r.status='pending' DESC, r.created_at DESC LIMIT 200`, ...(status ? [params.vid, status] : [params.vid]));
  });
  r.post('/owner/venues/:vid/refunds/:rid/:decision', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const decision = oneOf(params.decision, 'Decision', ['approve', 'reject']);
    const note = str(body.note, 'Note', { max: 300, optional: true });
    return transaction(() => {
      const refund = one('SELECT r.*, b.venue_id, b.customer_id, b.ref FROM refunds r JOIN bookings b ON b.id=r.booking_id WHERE r.id=? AND b.venue_id=?', params.rid, venue.id);
      if (!refund) notFound('Refund not found');
      if (refund.status !== 'pending') conflict(`This refund is already ${refund.status}`);
      if (decision === 'approve') processRefund(refund.id, u.id, note);
      else {
        if (!note) bad('Tell the customer why the refund was declined');
        run("UPDATE refunds SET status='rejected', decided_by=?, decision_note=?, decided_at=? WHERE id=?", u.id, note, now(), refund.id);
        notify(refund.customer_id, { kind: 'refund', title: 'Refund request declined', body: `${refund.ref}: ${note}. You can raise a dispute from the booking page if you disagree.`, link: `#/booking/${refund.booking_id}`, bookingId: refund.booking_id, channels: ['inapp', 'email'] });
        audit(u.id, 'refund.rejected', 'refund', refund.id, { venueId: venue.id, amount: refund.amount, note });
      }
      return one('SELECT * FROM refunds WHERE id=?', refund.id);
    });
  });
  r.post('/owner/venues/:vid/bookings/:bid/refund', ({ u, params, body }) => {
    requireVenue(u, params.vid, 'manager');
    return transaction(() => issueRefund(loadBooking(params.vid, params.bid), rupees(body.amount, 'Amount'), { origin: 'owner', actorId: u.id, reason: str(body.reason, 'Reason', { min: 3, max: 300 }) }));
  });

  // ---- Coupons -------------------------------------------------------------------------------------------------
  r.get('/owner/venues/:vid/coupons', ({ u, params }) => {
    requireVenue(u, params.vid, 'manager');
    return all(`SELECT c.*, (SELECT COUNT(*) FROM bookings b WHERE b.coupon_id=c.id AND b.status IN ('confirmed','completed')) AS redemptions FROM coupons c WHERE venue_id=? ORDER BY created_at DESC`, params.vid);
  });
  r.post('/owner/venues/:vid/coupons', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const kind = oneOf(body.kind, 'Type', ['percent', 'flat']);
    const c = {
      id: id(), code: str(body.code, 'Code', { min: 3, max: 20 }).toUpperCase(), kind,
      value: kind === 'percent' ? int(body.value, 'Discount %', { min: 1, max: 100 }) : rupees(body.value, 'Discount'),
      max_discount: body.maxDiscount ? rupees(body.maxDiscount, 'Max discount') : null, min_amount: body.minAmount ? rupees(body.minAmount, 'Minimum spend') : 0,
      max_uses: body.maxUses ? int(body.maxUses, 'Max uses', { min: 1, max: 100000 }) : null, per_user_limit: body.perUserLimit ? int(body.perUserLimit, 'Uses per customer', { min: 1, max: 100 }) : 1,
      valid_until: body.validUntil ? dateOf(body.validUntil, 'Valid until') : null, description: str(body.description, 'Description', { max: 120, optional: true }),
    };
    if (!/^[A-Z0-9_-]+$/.test(c.code)) bad('Codes can use letters, numbers, - and _');
    if (one('SELECT 1 FROM coupons WHERE code=?', c.code)) conflict('That code is already taken');
    run('INSERT INTO coupons (id,venue_id,code,kind,value,max_discount,min_amount,max_uses,per_user_limit,valid_until,description,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      c.id, venue.id, c.code, c.kind, c.value, c.max_discount, c.min_amount, c.max_uses, c.per_user_limit, c.valid_until, c.description, now());
    audit(u.id, 'coupon.created', 'coupon', c.id, { venueId: venue.id, ...c });
    return created(c);
  });
  r.patch('/owner/venues/:vid/coupons/:cid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const c = one('SELECT * FROM coupons WHERE id=? AND venue_id=?', params.cid, venue.id);
    if (!c) notFound('Coupon not found');
    const active = bool(body.active) ? 1 : 0;
    run('UPDATE coupons SET active=? WHERE id=?', active, c.id);
    audit(u.id, active ? 'coupon.activated' : 'coupon.deactivated', 'coupon', c.id, { venueId: venue.id, code: c.code });
    return { ok: true };
  });

  // ---- Staff ---------------------------------------------------------------------------------------------------
  r.get('/owner/venues/:vid/staff', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'owner');
    const owner = one("SELECT id, name, email, phone, 'owner' AS role FROM users WHERE id=?", venue.owner_id);
    return [owner, ...all('SELECT u.id, u.name, u.email, u.phone, s.role, s.created_at FROM venue_staff s JOIN users u ON u.id=s.user_id WHERE s.venue_id=? ORDER BY s.role, u.name', venue.id)];
  });
  r.post('/owner/venues/:vid/staff', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'owner');
    const role = oneOf(body.role, 'Role', ['manager', 'front_desk']);
    const ident = String(body.identifier || '').trim();
    const field = ident.includes('@') ? 'email' : 'phone';
    const value = field === 'email' ? emailOf(ident) : phoneOf(ident);
    return transaction(() => {
      let staff = one(`SELECT * FROM users WHERE ${field}=?`, value);
      if (!staff) {
        // Placeholder account: the person signs in with an OTP to this email/phone and lands on the venue.
        const uid = id(); let code; do { code = Math.random().toString(36).slice(2, 8).toUpperCase(); } while (one('SELECT 1 FROM users WHERE referral_code=?', code));
        run(`INSERT INTO users (id,name,${field},role,referral_code,created_at) VALUES (?,?,?,'customer',?,?)`, uid, str(body.name, 'Name', { max: 80, optional: true }), value, code, now());
        staff = one('SELECT * FROM users WHERE id=?', uid);
      }
      if (staff.id === venue.owner_id) bad('That person is the owner');
      run('INSERT INTO venue_staff (venue_id,user_id,role,created_at) VALUES (?,?,?,?) ON CONFLICT (venue_id,user_id) DO UPDATE SET role=excluded.role', venue.id, staff.id, role, now());
      notify(staff.id, { kind: 'staff_invite', title: `You were added to ${venue.name}`, body: `Role: ${role.replace('_', ' ')}. Sign in with this ${field} to open the venue dashboard.`, link: `#/owner/${venue.id}`, channels: ['inapp', 'email', 'whatsapp'] });
      audit(u.id, 'staff.granted', 'user', staff.id, { venueId: venue.id, role, [field]: value });
      return created({ id: staff.id, role });
    });
  });
  r.delete('/owner/venues/:vid/staff/:uid', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'owner');
    const s = one('SELECT * FROM venue_staff WHERE venue_id=? AND user_id=?', venue.id, params.uid);
    if (!s) notFound('Staff member not found');
    run('DELETE FROM venue_staff WHERE venue_id=? AND user_id=?', venue.id, params.uid);
    audit(u.id, 'staff.revoked', 'user', params.uid, { venueId: venue.id, role: s.role });
    return { ok: true };
  });

  // ---- Insight -------------------------------------------------------------------------------------------------
  r.get('/owner/venues/:vid/overview', ({ u, params }) => {
    const { venue, role } = requireVenue(u, params.vid);
    const today = venueToday(venue);
    const report = canAtLeast(role, 'manager') ? venueReport(venue, today, today).totals : null;
    const upcoming = all("SELECT * FROM bookings WHERE venue_id=? AND status='confirmed' AND end_at>? ORDER BY start_at LIMIT 8", venue.id, Date.now()).map(b => bookingView(b, { staff: true }));
    return {
      today, status: venue.status, statusNote: venue.status_note, role, report, upcoming,
      todayBookings: one("SELECT COUNT(*) AS n FROM bookings WHERE venue_id=? AND date=? AND status IN ('confirmed','completed')", venue.id, today).n,
      checkedIn: one("SELECT COUNT(*) AS n FROM bookings WHERE venue_id=? AND date=? AND checked_in_at IS NOT NULL", venue.id, today).n,
      pendingRefunds: one("SELECT COUNT(*) AS n FROM refunds r JOIN bookings b ON b.id=r.booking_id WHERE b.venue_id=? AND r.status='pending'", venue.id).n,
      openTickets: one("SELECT COUNT(*) AS n FROM support_tickets WHERE venue_id=? AND status='open'", venue.id).n,
      rating: one('SELECT ROUND(AVG(rating),1) AS r, COUNT(*) AS n FROM reviews WHERE venue_id=? AND hidden=0', venue.id),
    };
  });

  r.get('/owner/venues/:vid/reports', ({ u, params, query }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const { from, to } = range(query, venue);
    return venueReport(venue, from, to);
  });

  r.get('/owner/venues/:vid/customers', ({ u, params, query }) => {
    requireVenue(u, params.vid);
    const q = `%${(query.get('q') || '').trim()}%`;
    return all(`SELECT COALESCE(b.customer_id, 'walkin:' || b.customer_phone || b.customer_name) AS key, COALESCE(u.name, b.customer_name) AS name,
                COALESCE(u.phone, b.customer_phone) AS phone, u.email, COUNT(*) AS bookings, SUM(b.status='cancelled') AS cancellations,
                SUM(CASE WHEN b.status IN ('confirmed','completed') THEN b.amount ELSE 0 END) AS spend, MAX(b.date) AS last_visit, MIN(b.date) AS first_visit,
                SUM(b.no_show) AS no_shows
                FROM bookings b LEFT JOIN users u ON u.id=b.customer_id WHERE b.venue_id=? AND b.status IN ('confirmed','completed','cancelled')
                AND (COALESCE(u.name, b.customer_name) LIKE ? OR COALESCE(u.phone, b.customer_phone) LIKE ?)
                GROUP BY key ORDER BY bookings DESC, last_visit DESC LIMIT 300`, params.vid, q, q);
  });

  r.get('/owner/venues/:vid/reviews', ({ u, params }) => {
    requireVenue(u, params.vid);
    return all('SELECT r.*, u.name, b.ref, b.date FROM reviews r JOIN users u ON u.id=r.customer_id JOIN bookings b ON b.id=r.booking_id WHERE r.venue_id=? ORDER BY r.created_at DESC', params.vid);
  });
  r.post('/owner/venues/:vid/reviews/:rid/reply', ({ u, params, body }) => {
    requireVenue(u, params.vid, 'manager');
    const review = one('SELECT * FROM reviews WHERE id=? AND venue_id=?', params.rid, params.vid);
    if (!review) notFound('Review not found');
    const replyText = str(body.reply, 'Reply', { max: 1000 });
    run('UPDATE reviews SET owner_reply=? WHERE id=?', replyText, review.id);
    audit(u.id, 'review.replied', 'review', review.id, { venueId: params.vid });
    notify(review.customer_id, { kind: 'review_reply', title: 'The venue replied to your review', body: replyText.slice(0, 140), link: '#/bookings', channels: ['inapp'] });
    return { ok: true };
  });

  r.get('/owner/venues/:vid/payouts', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'owner');
    const settled = one("SELECT MAX(period_end) AS d FROM payouts WHERE venue_id=?", venue.id).d;
    const unsettled = one(`SELECT COALESCE(SUM(p.amount),0) AS gross, COALESCE(SUM(p.refunded),0) AS refunds FROM payments p JOIN bookings b ON b.id=p.booking_id
                           WHERE b.venue_id=? AND p.status IN ('succeeded','partially_refunded','refunded') AND b.date > ?`, venue.id, settled || '0000-00-00');
    return { payouts: all('SELECT * FROM payouts WHERE venue_id=? ORDER BY period_start DESC', venue.id), unsettled, settledThrough: settled,
      account: { holder: venue.payout_holder, bank: venue.payout_bank, last4: venue.payout_last4 } };
  });

  r.get('/owner/venues/:vid/audit', ({ u, params }) => {
    requireVenue(u, params.vid, 'owner');
    return all('SELECT a.*, u.name AS actor FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.venue_id=? ORDER BY a.created_at DESC LIMIT 300', params.vid)
      .map(a => ({ ...a, details: parseJson(a.details, {}) }));
  });
}
