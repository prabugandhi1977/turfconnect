// Customer support chat and disputes. A ticket can involve the customer, the venue team (when tied to a venue)
// and platform admins. Disputes are escalations that only admins resolve.
import { all, id, now, one, run, transaction } from '../db.js';
import { venueRole } from '../security.js';
import { bad, conflict, forbidden, int, notFound, oneOf, str } from '../validate.js';
import { created } from '../http.js';
import { issueRefund } from '../bookings.js';
import { notify } from '../notify.js';
import { audit } from '../audit.js';
import { publishUser } from '../events.js';

function access(u, t) {
  if (u.role === 'admin') return 'admin';
  if (t.user_id === u.id) return 'customer';
  if (t.venue_id && t.kind === 'support') { const v = one('SELECT * FROM venues WHERE id=?', t.venue_id); if (venueRole(u, v)) return 'venue'; }
  return null;
}
function load(u, ticketId) {
  const t = one('SELECT * FROM support_tickets WHERE id=?', ticketId);
  if (!t || !access(u, t)) notFound('Conversation not found');
  return t;
}
function participants(t) {
  const ids = new Set([t.user_id]);
  if (t.venue_id && t.kind === 'support') {
    const v = one('SELECT owner_id FROM venues WHERE id=?', t.venue_id); ids.add(v.owner_id);
    for (const s of all("SELECT user_id FROM venue_staff WHERE venue_id=? AND role='manager'", t.venue_id)) ids.add(s.user_id);
  }
  if (t.kind === 'dispute') for (const a of all("SELECT id FROM users WHERE role='admin' AND active=1")) ids.add(a.id);
  return ids;
}

export default function supportRoutes(r) {
  r.get('/support/tickets', ({ u, query }) => {
    const view = query.get('view') || 'mine';
    let rows;
    if (view === 'admin') { if (u.role !== 'admin') forbidden(); rows = all("SELECT * FROM support_tickets ORDER BY status='open' DESC, updated_at DESC LIMIT 200"); }
    else if (view === 'venue') {
      const vid = query.get('venue'); const v = one('SELECT * FROM venues WHERE id=?', vid);
      if (!v || !venueRole(u, v)) notFound('Venue not found');
      rows = all("SELECT * FROM support_tickets WHERE venue_id=? AND kind='support' ORDER BY status='open' DESC, updated_at DESC LIMIT 200", vid);
    } else rows = all('SELECT * FROM support_tickets WHERE user_id=? ORDER BY updated_at DESC LIMIT 100', u.id);
    return rows.map(t => ({ ...t, venue: t.venue_id ? one('SELECT name FROM venues WHERE id=?', t.venue_id)?.name : null,
      customer: one('SELECT name FROM users WHERE id=?', t.user_id)?.name,
      last: one('SELECT body, created_at FROM support_messages WHERE ticket_id=? ORDER BY created_at DESC LIMIT 1', t.id) }));
  });

  r.post('/support/tickets', ({ u, body }) => transaction(() => {
    const kind = oneOf(body.kind || 'support', 'Type', ['support', 'dispute']);
    let venueId = null, bookingId = null;
    if (body.bookingId) {
      const b = one('SELECT * FROM bookings WHERE id=? AND customer_id=?', body.bookingId, u.id);
      if (!b) notFound('Booking not found');
      venueId = b.venue_id; bookingId = b.id;
      if (kind === 'dispute' && one("SELECT 1 FROM support_tickets WHERE booking_id=? AND kind='dispute' AND status='open'", b.id)) conflict('A dispute for this booking is already open');
    } else if (kind === 'dispute') bad('Pick the booking you want to dispute');
    const t = { id: id(), subject: str(body.subject, 'Subject', { min: 3, max: 120 }) };
    const message = str(body.message, 'Message', { min: 2, max: 2000 });
    run('INSERT INTO support_tickets (id,user_id,venue_id,booking_id,kind,subject,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', t.id, u.id, venueId, bookingId, kind, t.subject, now(), now());
    run('INSERT INTO support_messages (id,ticket_id,author_id,body,created_at) VALUES (?,?,?,?,?)', id(), t.id, u.id, message, now());
    const ticket = one('SELECT * FROM support_tickets WHERE id=?', t.id);
    for (const pid of participants(ticket)) if (pid !== u.id) notify(pid, { kind: 'support', title: kind === 'dispute' ? 'New dispute' : 'New support message', body: `${t.subject}: ${message.slice(0, 120)}`, link: `#/support/${t.id}`, channels: ['inapp'] });
    audit(u.id, `support.${kind}_opened`, 'ticket', t.id, { venueId, bookingId });
    return created(ticket);
  }));

  r.get('/support/tickets/:id', ({ u, params }) => {
    const t = load(u, params.id);
    const booking = t.booking_id ? one('SELECT id, ref, date, start_time, end_time, amount, status FROM bookings WHERE id=?', t.booking_id) : null;
    const messages = all(`SELECT m.id, m.body, m.created_at, m.author_id, u.name, u.role FROM support_messages m JOIN users u ON u.id=m.author_id WHERE m.ticket_id=? ORDER BY m.created_at`, t.id)
      .map(m => ({ ...m, mine: m.author_id === u.id, side: m.author_id === t.user_id ? 'customer' : m.role === 'admin' ? 'TurfConnect support' : 'Venue team' }));
    return { ...t, access: access(u, t), booking, messages, venue: t.venue_id ? one('SELECT name FROM venues WHERE id=?', t.venue_id)?.name : null };
  });

  r.post('/support/tickets/:id/messages', ({ u, params, body }) => {
    const t = load(u, params.id);
    if (t.status !== 'open') conflict('This conversation is closed. Start a new one if you still need help.');
    const text = str(body.body, 'Message', { min: 1, max: 2000 });
    run('INSERT INTO support_messages (id,ticket_id,author_id,body,created_at) VALUES (?,?,?,?,?)', id(), t.id, u.id, text, now());
    run('UPDATE support_tickets SET updated_at=? WHERE id=?', now(), t.id);
    for (const pid of participants(t)) if (pid !== u.id) { publishUser(pid, 'support', { ticketId: t.id }); notify(pid, { kind: 'support', title: `Reply: ${t.subject}`, body: text.slice(0, 140), link: `#/support/${t.id}`, channels: ['inapp'] }); }
    return created({ ok: true });
  });

  r.post('/support/tickets/:id/resolve', ({ u, params, body }) => transaction(() => {
    const t = load(u, params.id);
    const role = access(u, t);
    if (t.kind === 'dispute' && role !== 'admin') forbidden('Only TurfConnect support can resolve a dispute');
    if (t.status !== 'open') conflict('Already resolved');
    const resolution = str(body.resolution, 'Resolution', { min: 3, max: 1000 });
    let refund = null;
    if (body.refundAmount) {
      if (role !== 'admin') forbidden('Only TurfConnect support can issue refunds from a conversation');
      const b = one('SELECT * FROM bookings WHERE id=?', t.booking_id);
      if (!b) bad('This conversation is not linked to a booking');
      refund = issueRefund(b, int(Math.round(Number(body.refundAmount) * 100), 'Refund', { min: 1 }), { origin: 'admin', actorId: u.id, reason: `Dispute resolution: ${resolution}` });
    }
    run("UPDATE support_tickets SET status='resolved', resolution=?, updated_at=? WHERE id=?", resolution, now(), t.id);
    run('INSERT INTO support_messages (id,ticket_id,author_id,body,created_at) VALUES (?,?,?,?,?)', id(), t.id, u.id, `Resolved: ${resolution}`, now());
    notify(t.user_id, { kind: 'support', title: 'Your request was resolved', body: resolution.slice(0, 160), link: `#/support/${t.id}`, channels: ['inapp', 'email'] });
    audit(u.id, `support.${t.kind}_resolved`, 'ticket', t.id, { venueId: t.venue_id, resolution, refund: refund?.amount || 0 });
    return { ok: true, refund };
  }));
}
