// Entry access control, surveillance and slot-exit alerts.
//  - Gate devices scan a booking QR (its reference) and report direction. The server decides: granted inside the booking's window
//    (15 minutes early until the slot ends), denied otherwise. It keeps a live headcount per booking.
//  - Cameras report events (motion, people count, unknown person, tamper). Head counts are compared with the gate headcount.
//  - A periodic sweep raises alerts: slot-end warnings, overstay, no-show, denied bursts, head-count mismatch, offline devices.
import { createHash, randomBytes } from 'node:crypto';
import { all, id, now, one, run, transaction } from './db.js';
import { safeEqual } from './security.js';
import { HttpError, bad } from './validate.js';
import { notify } from './notify.js';
import { publishVenue } from './events.js';
import { alertStaff } from './staff-alerts.js';
import { weekday, zonedParts } from './time.js';

export const EARLY_MS = 15 * 60000, OVERSTAY_GRACE_MS = 5 * 60000, NOSHOW_GRACE_MS = 15 * 60000, WARN_BEFORE_MS = 10 * 60000, OFFLINE_MS = 3 * 60000;
const MAX_INSIDE = 40, MISMATCH_SLACK = 3, SWEEP_EVERY_MS = 20000;
const hashKey = key => createHash('sha256').update(key).digest('hex');
export const newDeviceKey = prefix => { const key = prefix + randomBytes(18).toString('hex'); return { key, hash: hashKey(key) }; };

function deviceAuth(table, deviceId, key) {
  const d = one(`SELECT * FROM ${table} WHERE id=? AND active=1`, deviceId);
  if (!d || !key || !safeEqual(hashKey(String(key)), d.key_hash)) throw new HttpError(401, 'Invalid device key');
  return d;
}
export const pointAuth = (pid, key) => deviceAuth('access_points', pid, key);
export const cameraAuth = (cid, key) => deviceAuth('cameras', cid, key);

// ---- Alerts -------------------------------------------------------------------------------------------------------
// With a bookingId, each kind is raised only once per booking. Without one, once per device per 30 minutes.
export function raiseAlert(venueId, kind, { severity = 'warning', bookingId = null, deviceId = '', message, notifyStaff = true }) {
  const dup = bookingId
    ? one('SELECT 1 FROM venue_alerts WHERE booking_id=? AND kind=?', bookingId, kind)
    : one('SELECT 1 FROM venue_alerts WHERE venue_id=? AND kind=? AND device_id=? AND created_at>?', venueId, kind, deviceId, Date.now() - 30 * 60000);
  if (dup) return null;
  const aid = id();
  run('INSERT INTO venue_alerts (id,venue_id,kind,severity,booking_id,device_id,message,created_at) VALUES (?,?,?,?,?,?,?,?)', aid, venueId, kind, severity, bookingId, deviceId, message, Date.now());
  if (notifyStaff) alertStaff(venueId, TITLES[kind] || 'Venue alert', message, `#/owner/${venueId}/access`);
  publishVenue(venueId, { access: true });
  return aid;
}
const TITLES = { overstay: 'Slot overstay', no_show: 'No-show', denied_burst: 'Repeated denied entries', headcount: 'Head-count mismatch', unknown_person: 'Unknown person on camera', tamper: 'Camera tampering', device_offline: 'Device offline' };
const resolveAlerts = (bookingId, kind) => run('UPDATE venue_alerts SET resolved_at=? WHERE booking_id=? AND kind=? AND resolved_at IS NULL', Date.now(), bookingId, kind);

// ---- Gate scans ---------------------------------------------------------------------------------------------------
const DENY = {
  unknown: 'No booking found for that code at this venue',
  cancelled: 'This booking was cancelled',
  not_paid: 'This booking is not confirmed yet',
  too_early: 'Entry opens 15 minutes before the slot',
  ended: 'This slot has already ended',
  online_only: 'This is an online class: no entry needed',
  full: 'Maximum people already inside for this booking',
};

export function scan(point, { credential, direction }) {
  if (!['in', 'out'].includes(direction)) bad('direction must be "in" or "out"');
  const ref = String(credential || '').trim().toUpperCase().slice(0, 40);
  if (!ref) bad('A credential is required');
  const out = transaction(() => {
    run('UPDATE access_points SET last_seen_at=?, alerted_offline=0, updated_at=? WHERE id=?', Date.now(), now(), point.id);
    const b = one('SELECT * FROM bookings WHERE ref=? AND venue_id=?', ref, point.venue_id);
    const t = Date.now();
    let reason = '';
    if (!b) reason = 'unknown';
    else if (direction === 'in') {
      const sess = b.session_id ? one('SELECT mode FROM wellness_sessions WHERE id=?', b.session_id) : null;
      if (b.status === 'cancelled' || b.status === 'failed' || b.status === 'expired') reason = 'cancelled';
      else if (b.status === 'held') reason = 'not_paid';
      else if (sess?.mode === 'online') reason = 'online_only';
      else if (t < b.start_at - EARLY_MS) reason = 'too_early';
      else if (t > b.end_at) reason = 'ended';
      else if (b.inside_count >= MAX_INSIDE) reason = 'full';
    }
    const granted = !reason;
    run('INSERT INTO access_events (id,venue_id,point_id,booking_id,ref,direction,result,reason,at) VALUES (?,?,?,?,?,?,?,?,?)', id(), point.venue_id, point.id, b?.id || null, ref, direction, granted ? 'granted' : 'denied', reason, t);
    let inside = b?.inside_count || 0;
    if (granted && b) {
      inside = Math.max(0, inside + (direction === 'in' ? 1 : -1));
      run('UPDATE bookings SET inside_count=?, checked_in_at=COALESCE(checked_in_at, ?), updated_at=? WHERE id=?', inside, direction === 'in' ? now() : null, now(), b.id);
      if (direction === 'out' && inside === 0) resolveAlerts(b.id, 'overstay');
    }
    return { result: granted ? 'granted' : 'denied', reason, message: granted ? (direction === 'in' ? 'Welcome' : 'Goodbye') : DENY[reason], ref, inside, name: granted && b ? b.customer_name : '' };
  });
  publishVenue(point.venue_id, { access: true });
  return out;
}

export function pointHeartbeat(point) {
  run('UPDATE access_points SET last_seen_at=?, alerted_offline=0, updated_at=? WHERE id=?', Date.now(), now(), point.id);
  return { ok: true, serverTime: Date.now() };
}

// ---- Camera events ------------------------------------------------------------------------------------------------
const CAMERA_KINDS = ['motion', 'people_count', 'unknown_person', 'tamper'];
export function cameraEvent(cam, { kind, people, note }) {
  if (!CAMERA_KINDS.includes(kind)) bad(`kind must be one of: ${CAMERA_KINDS.join(', ')}`);
  let count = null;
  if (kind === 'people_count') {
    count = Number(people);
    if (!Number.isInteger(count) || count < 0 || count > 1000) bad('people must be a whole number from 0 to 1000');
  }
  transaction(() => {
    run('UPDATE cameras SET last_seen_at=?, alerted_offline=0, updated_at=? WHERE id=?', Date.now(), now(), cam.id);
    run('INSERT INTO camera_events (id,venue_id,camera_id,kind,people,note,at) VALUES (?,?,?,?,?,?,?)', id(), cam.venue_id, cam.id, kind, count, String(note || '').slice(0, 200), Date.now());
    if (kind === 'unknown_person') raiseAlert(cam.venue_id, 'unknown_person', { severity: 'critical', deviceId: cam.id, message: `${cam.name}${cam.location ? ' (' + cam.location + ')' : ''}: unknown person detected${note ? '. ' + String(note).slice(0, 100) : ''}` });
    if (kind === 'tamper') raiseAlert(cam.venue_id, 'tamper', { severity: 'critical', deviceId: cam.id, message: `${cam.name}: possible camera tampering or blocked lens` });
  });
  publishVenue(cam.venue_id, { access: true });
  return { ok: true };
}
export function cameraHeartbeat(cam) {
  run('UPDATE cameras SET last_seen_at=?, alerted_offline=0, updated_at=? WHERE id=?', Date.now(), now(), cam.id);
  return { ok: true, serverTime: Date.now() };
}

// ---- Periodic checks ----------------------------------------------------------------------------------------------
let lastSweep = 0;
export function sweepAccess({ force = false } = {}) {
  if (!force && Date.now() - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = Date.now();
  const t = Date.now();
  // 1. Slot ending soon: ask people inside to wrap up.
  for (const b of all("SELECT * FROM bookings WHERE status='confirmed' AND inside_count>0 AND exit_warned=0 AND end_at>? AND end_at<=?", t, t + WARN_BEFORE_MS)) {
    run('UPDATE bookings SET exit_warned=1 WHERE id=?', b.id);
    notify(b.customer_id, { kind: 'slot_ending', title: 'Your slot ends soon', body: `Your slot at ${one('SELECT name FROM venues WHERE id=?', b.venue_id).name} ends at ${b.end_time}. Please wrap up and make sure everyone exits on time.`, link: `#/booking/${b.id}`, bookingId: b.id, channels: ['inapp'] });
  }
  // 2. Overstay: people still inside after the slot ended.
  for (const b of all("SELECT * FROM bookings WHERE inside_count>0 AND overstay_alerted=0 AND end_at<?", t - OVERSTAY_GRACE_MS)) {
    run('UPDATE bookings SET overstay_alerted=1 WHERE id=?', b.id);
    const court = one('SELECT name FROM courts WHERE id=?', b.court_id)?.name || 'court';
    const mins = Math.round((t - b.end_at) / 60000);
    raiseAlert(b.venue_id, 'overstay', { severity: 'warning', bookingId: b.id, message: `${b.inside_count} ${b.inside_count === 1 ? 'person is' : 'people are'} still inside ${mins} min after the slot ended: ${court}, booking ${b.ref}.` });
    if (b.customer_id) notify(b.customer_id, { kind: 'slot_ended', title: 'Your slot has ended', body: 'Please exit the venue so the next players can start on time.', link: `#/booking/${b.id}`, bookingId: b.id, channels: ['inapp'] });
  }
  // 3. No-show: paid booking, nobody came through a gate within 15 minutes of the start (only at venues that have gates).
  for (const b of all(`SELECT b.* FROM bookings b WHERE b.status='confirmed' AND b.inside_count=0 AND b.start_at<? AND b.end_at>? AND b.session_id IS NULL
                       AND EXISTS (SELECT 1 FROM access_points p WHERE p.venue_id=b.venue_id AND p.active=1)
                       AND NOT EXISTS (SELECT 1 FROM access_events e WHERE e.booking_id=b.id AND e.result='granted')`, t - NOSHOW_GRACE_MS, t)) {
    const court = one('SELECT name FROM courts WHERE id=?', b.court_id)?.name || 'court';
    raiseAlert(b.venue_id, 'no_show', { severity: 'info', bookingId: b.id, message: `Nobody has arrived for ${court}, booking ${b.ref} (${b.start_time}-${b.end_time}). The slot is paid for.` });
  }
  // 4. Denied bursts: three or more refused scans at one gate in ten minutes.
  for (const r of all("SELECT point_id, venue_id, COUNT(*) AS n FROM access_events WHERE result='denied' AND at>? GROUP BY point_id HAVING n>=3", t - 10 * 60000)) {
    const p = one('SELECT name FROM access_points WHERE id=?', r.point_id);
    raiseAlert(r.venue_id, 'denied_burst', { severity: 'warning', deviceId: r.point_id, message: `${r.n} entry attempts were refused at ${p.name} in the last 10 minutes.` });
  }
  // 5. Head-count mismatch: cameras see clearly more people than the gates let in.
  for (const v of all('SELECT DISTINCT venue_id FROM cameras WHERE active=1')) {
    const latest = all(`SELECT camera_id, people FROM camera_events e WHERE venue_id=? AND kind='people_count' AND at>? AND at=(SELECT MAX(at) FROM camera_events WHERE camera_id=e.camera_id AND kind='people_count')`, v.venue_id, t - 3 * 60000);
    if (!latest.length) continue;
    const seen = latest.reduce((s, r) => s + r.people, 0), inside = one("SELECT COALESCE(SUM(inside_count),0) AS n FROM bookings WHERE venue_id=? AND status IN ('confirmed','completed')", v.venue_id).n;
    if (seen > inside + MISMATCH_SLACK) raiseAlert(v.venue_id, 'headcount', { severity: 'warning', message: `Cameras count ${seen} people but only ${inside} entered through the gates. Someone may have bypassed entry.` });
  }
  // 6. Devices that stopped reporting.
  for (const [table, label] of [['access_points', 'Gate'], ['cameras', 'Camera']]) {
    for (const d of all(`SELECT * FROM ${table} WHERE active=1 AND last_seen_at IS NOT NULL AND alerted_offline=0 AND last_seen_at<?`, t - OFFLINE_MS)) {
      run(`UPDATE ${table} SET alerted_offline=1 WHERE id=?`, d.id);
      raiseAlert(d.venue_id, 'device_offline', { severity: 'warning', deviceId: d.id, message: `${label} "${d.name}" has not reported for over 3 minutes.` });
    }
  }
}

export function simulateDevices() {
  run("UPDATE access_points SET last_seen_at=?, alerted_offline=0 WHERE active=1", Date.now());
  run("UPDATE cameras SET last_seen_at=?, alerted_offline=0 WHERE active=1 AND source!='webcam' AND last_seen_at IS NOT NULL", Date.now());
}

// ---- Dashboard views ----------------------------------------------------------------------------------------------
const status = d => !d.last_seen_at || Date.now() - d.last_seen_at > OFFLINE_MS ? 'offline' : 'online';
export function accessOverview(venueId) {
  const points = all('SELECT * FROM access_points WHERE venue_id=? ORDER BY name', venueId).map(p => ({ id: p.id, name: p.name, kind: p.kind, location: p.location, active: !!p.active, status: status(p), lastSeenAt: p.last_seen_at }));
  const cameras = all('SELECT * FROM cameras WHERE venue_id=? ORDER BY name', venueId).map(c => {
    const last = one("SELECT people, at FROM camera_events WHERE camera_id=? AND kind='people_count' ORDER BY at DESC LIMIT 1", c.id);
    return { id: c.id, name: c.name, location: c.location, streamUrl: c.stream_url, viewMode: c.view_mode, source: c.source, active: !!c.active, status: status(c), lastSeenAt: c.last_seen_at, people: last && Date.now() - last.at < 5 * 60000 ? last.people : null };
  });
  const inside = all(`SELECT b.id, b.ref, COALESCE(NULLIF(b.customer_name,''), u.name, '') AS customer_name, b.inside_count, b.start_time, b.end_time, b.end_at, c.name AS court FROM bookings b JOIN courts c ON c.id=b.court_id
                      LEFT JOIN users u ON u.id=b.customer_id WHERE b.venue_id=? AND b.inside_count>0 ORDER BY b.end_at`, venueId).map(b => ({ id: b.id, ref: b.ref, name: b.customer_name, inside: b.inside_count, court: b.court, startTime: b.start_time, endTime: b.end_time, overdue: b.end_at < Date.now() }));
  const alerts = all('SELECT * FROM venue_alerts WHERE venue_id=? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 50', venueId);
  const events = [
    ...all(`SELECT e.at, e.direction, e.result, e.reason, e.ref, p.name AS device FROM access_events e JOIN access_points p ON p.id=e.point_id WHERE e.venue_id=? ORDER BY e.at DESC LIMIT 30`, venueId)
      .map(e => ({ at: e.at, type: 'gate', text: `${e.device}: ${e.result === 'granted' ? (e.direction === 'in' ? 'entry' : 'exit') : 'refused ' + e.direction}${e.ref ? ' · ' + e.ref : ''}${e.reason ? ' · ' + (DENY[e.reason] || e.reason) : ''}`, ok: e.result === 'granted' })),
    ...all(`SELECT e.at, e.kind, e.people, e.note, c.name AS device FROM camera_events e JOIN cameras c ON c.id=e.camera_id WHERE e.venue_id=? AND e.kind!='people_count' ORDER BY e.at DESC LIMIT 20`, venueId)
      .map(e => ({ at: e.at, type: 'camera', text: `${e.device}: ${e.kind.replace('_', ' ')}${e.note ? ' · ' + e.note : ''}`, ok: e.kind === 'motion' })),
  ].sort((a, b) => b.at - a.at).slice(0, 40);
  return { points, cameras, inside, insideTotal: inside.reduce((s, b) => s + b.inside, 0), alerts, events };
}

// ---- Analysis report ----------------------------------------------------------------------------------------------
export function accessReport(venue, days = 7) {
  const since = Date.now() - days * 86400000;
  const events = all('SELECT * FROM access_events WHERE venue_id=? AND at>=? ORDER BY at', venue.id, since);
  const granted = events.filter(e => e.result === 'granted'), denied = events.filter(e => e.result === 'denied');
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const dailyPeak = new Map();
  let occupancy = 0;
  for (const e of granted) {
    const z = zonedParts(e.at, venue.timezone);
    if (e.direction === 'in') heat[weekday(z.date)][Math.floor(z.minutes / 60)]++;
    occupancy = Math.max(0, occupancy + (e.direction === 'in' ? 1 : -1));
    dailyPeak.set(z.date, Math.max(dailyPeak.get(z.date) || 0, occupancy));
  }
  const reasons = {};
  for (const e of denied) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  // Attendance and dwell: for each finished paid booking, did anyone come, and for how much of the booked time?
  const bookings = all("SELECT * FROM bookings WHERE venue_id=? AND status IN ('confirmed','completed') AND end_at<? AND end_at>=? AND session_id IS NULL", venue.id, Date.now(), since);
  let attended = 0, dwellSum = 0, dwellN = 0;
  for (const b of bookings) {
    const evs = granted.filter(e => e.booking_id === b.id);
    const first = evs.find(e => e.direction === 'in');
    if (!first) continue;
    attended++;
    const lastOut = [...evs].reverse().find(e => e.direction === 'out');
    const end = lastOut ? lastOut.at : b.end_at;
    dwellSum += Math.min(1.5, Math.max(0, (end - first.at) / (b.end_at - b.start_at))); dwellN++;
  }
  const alertRows = all('SELECT kind, severity, created_at FROM venue_alerts WHERE venue_id=? AND created_at>=?', venue.id, since);
  const alertsByKind = {};
  for (const a of alertRows) alertsByKind[a.kind] = (alertsByKind[a.kind] || 0) + 1;
  const camEvents = all('SELECT kind, people, at FROM camera_events WHERE venue_id=? AND at>=?', venue.id, since);
  const camByKind = {}, peakByHour = Array(24).fill(0);
  for (const e of camEvents) {
    camByKind[e.kind] = (camByKind[e.kind] || 0) + 1;
    if (e.kind === 'people_count') { const h = Math.floor(zonedParts(e.at, venue.timezone).minutes / 60); peakByHour[h] = Math.max(peakByHour[h], e.people); }
  }
  return {
    days, entries: granted.filter(e => e.direction === 'in').length, exits: granted.filter(e => e.direction === 'out').length, denied: denied.length, deniedReasons: Object.entries(reasons).map(([reason, n]) => ({ reason, label: DENY[reason] || reason, n })),
    bookingsFinished: bookings.length, attended, attendanceRate: bookings.length ? Math.round(attended / bookings.length * 100) : null,
    avgDwellPercent: dwellN ? Math.round(dwellSum / dwellN * 100) : null,
    overstays: alertsByKind.overstay || 0, noShows: alertsByKind.no_show || 0, alertsByKind, heat, peakOccupancy: Math.max(0, ...dailyPeak.values()),
    dailyPeak: [...dailyPeak].sort().map(([date, peak]) => ({ date, peak })), camera: { byKind: camByKind, peakByHour },
  };
}
