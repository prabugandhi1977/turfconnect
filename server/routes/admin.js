import { config } from '../config.js';
import { all, id, now, one, parseJson, run, transaction } from '../db.js';
import { bad, conflict, date as dateOf, notFound, oneOf, str, bool } from '../validate.js';
import { audit } from '../audit.js';
import { notify } from '../notify.js';
import { publishVenue } from '../events.js';
import { daysBetween } from '../time.js';

export default function adminRoutes(r) {
  const admin = { roles: ['admin'] };

  r.get('/admin/overview', () => {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    return {
      venues: Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM venues GROUP BY status').map(x => [x.status, x.n])),
      users: one('SELECT COUNT(*) AS n FROM users').n,
      bookings30d: one("SELECT COUNT(*) AS n FROM bookings WHERE status IN ('confirmed','completed') AND confirmed_at>=?", since).n,
      gmv30d: one("SELECT COALESCE(SUM(p.amount - p.refunded),0) AS n FROM payments p WHERE p.status IN ('succeeded','partially_refunded','refunded') AND p.created_at>=?", since).n,
      failedPayments30d: one("SELECT COUNT(*) AS n FROM payments WHERE status='failed' AND created_at>=?", since).n,
      paymentAttempts30d: one("SELECT COUNT(*) AS n FROM payments WHERE provider<>'free' AND status<>'requires_payment' AND created_at>=?", since).n,
      abandoned30d: one("SELECT COUNT(*) AS n FROM bookings WHERE status='expired' AND created_at>=?", since).n,
      openDisputes: one("SELECT COUNT(*) AS n FROM support_tickets WHERE kind='dispute' AND status='open'").n,
      openTickets: one("SELECT COUNT(*) AS n FROM support_tickets WHERE status='open'").n,
      pendingPayouts: one("SELECT COUNT(*) AS n, COALESCE(SUM(net),0) AS amount FROM payouts WHERE status='pending'"),
      commissionPercent: config.commissionPercent,
    };
  }, admin);

  r.get('/admin/venues', ({ query }) => {
    const status = query.get('status');
    return all(`SELECT v.id, v.name, v.slug, v.city, v.address, v.status, v.status_note, v.business_name, v.tax_id, v.payout_holder, v.payout_bank, v.payout_last4, v.created_at, v.photos,
                u.name AS owner, u.email AS owner_email, u.phone AS owner_phone, (SELECT COUNT(*) FROM courts c WHERE c.venue_id=v.id) AS courts,
                (SELECT COUNT(*) FROM bookings b WHERE b.venue_id=v.id AND b.status IN ('confirmed','completed')) AS bookings
                FROM venues v JOIN users u ON u.id=v.owner_id ${status ? 'WHERE v.status=?' : ''} ORDER BY v.status='pending' DESC, v.created_at DESC`, ...(status ? [status] : []))
      .map(v => ({ ...v, photos: parseJson(v.photos, []).slice(0, 1) }));
  }, admin);

  r.post('/admin/venues/:vid/status', ({ u, params, body }) => {
    const v = one('SELECT * FROM venues WHERE id=?', params.vid);
    if (!v) notFound('Venue not found');
    const status = oneOf(body.status, 'Status', ['active', 'suspended', 'rejected']);
    const note = str(body.note, 'Note', { max: 300, optional: status === 'active' });
    if (status === 'active' && !one('SELECT 1 FROM courts WHERE venue_id=? AND active=1', v.id)) conflict('The venue needs at least one active court before it can go live');
    run('UPDATE venues SET status=?, status_note=?, updated_at=? WHERE id=?', status, note, now(), v.id);
    const msg = { active: v.status === 'pending' ? 'Your venue is verified and now bookable' : 'Your venue is live again', suspended: 'Your venue has been suspended', rejected: 'Your venue application needs changes' }[status];
    notify(v.owner_id, { kind: 'venue_status', title: msg, body: note || `${v.name} is now ${status}.`, link: `#/owner/${v.id}`, channels: ['inapp', 'email'] });
    audit(u.id, `venue.${status}`, 'venue', v.id, { venueId: v.id, from: v.status, note });
    publishVenue(v.id, { config: true });
    return { ok: true };
  }, admin);

  r.post('/admin/reviews/:rid/hidden', ({ u, params, body }) => {
    const review = one('SELECT * FROM reviews WHERE id=?', params.rid);
    if (!review) notFound('Review not found');
    run('UPDATE reviews SET hidden=? WHERE id=?', bool(body.hidden) ? 1 : 0, review.id);
    audit(u.id, bool(body.hidden) ? 'review.hidden' : 'review.restored', 'review', review.id, { venueId: review.venue_id, reason: str(body.reason, 'Reason', { max: 200, optional: true }) });
    return { ok: true };
  }, admin);

  // Settlement for a closed period: online takings for games in the period, minus refunds and platform commission.
  r.post('/admin/payouts/generate', ({ u, body }) => {
    const from = dateOf(body.periodStart, 'Period start'), to = dateOf(body.periodEnd, 'Period end');
    if (daysBetween(from, to) < 0 || daysBetween(from, to) > 31) bad('Pick a period of up to a month');
    const today = new Date().toISOString().slice(0, 10);
    if (to >= today) bad('Only finished periods can be settled');
    const created = [];
    transaction(() => {
      for (const v of all("SELECT id, owner_id, name FROM venues WHERE status IN ('active','suspended')")) {
        if (one('SELECT 1 FROM payouts WHERE venue_id=? AND NOT (period_end < ? OR period_start > ?)', v.id, from, to)) continue;
        const t = one(`SELECT COALESCE(SUM(p.amount),0) AS gross, COALESCE(SUM(p.refunded),0) AS refunds FROM payments p JOIN bookings b ON b.id=p.booking_id
                       WHERE b.venue_id=? AND b.date BETWEEN ? AND ? AND p.provider<>'free' AND p.status IN ('succeeded','partially_refunded','refunded')`, v.id, from, to);
        if (!t.gross) continue;
        const commission = Math.round((t.gross - t.refunds) * config.commissionPercent / 100);
        const p = { id: id(), venue: v.name, gross: t.gross, refunds: t.refunds, commission, net: t.gross - t.refunds - commission };
        run('INSERT INTO payouts (id,venue_id,period_start,period_end,gross,refunds,commission,net,created_at) VALUES (?,?,?,?,?,?,?,?,?)', p.id, v.id, from, to, p.gross, p.refunds, p.commission, p.net, now());
        audit(u.id, 'payout.created', 'payout', p.id, { venueId: v.id, from, to, net: p.net });
        created.push(p);
      }
    });
    return { created };
  }, admin);

  r.get('/admin/payouts', () => all('SELECT p.*, v.name AS venue, v.payout_holder, v.payout_bank, v.payout_last4 FROM payouts p JOIN venues v ON v.id=p.venue_id ORDER BY p.status=\'pending\' DESC, p.period_start DESC LIMIT 300'), admin);

  r.post('/admin/payouts/:pid/paid', ({ u, params, body }) => {
    const p = one('SELECT * FROM payouts WHERE id=?', params.pid);
    if (!p) notFound('Payout not found');
    if (p.status === 'paid') conflict('Already marked as paid');
    const reference = str(body.reference, 'Transfer reference', { min: 3, max: 80 });
    run("UPDATE payouts SET status='paid', reference=?, paid_at=? WHERE id=?", reference, now(), p.id);
    const v = one('SELECT owner_id FROM venues WHERE id=?', p.venue_id);
    notify(v.owner_id, { kind: 'payout', title: 'Payout sent', body: `Settlement for ${p.period_start} to ${p.period_end} has been transferred (ref ${reference}).`, link: `#/owner/${p.venue_id}/payouts`, channels: ['inapp', 'email'] });
    audit(u.id, 'payout.paid', 'payout', p.id, { venueId: p.venue_id, reference, net: p.net });
    return { ok: true };
  }, admin);

  r.get('/admin/audit', ({ query }) => {
    const q = query.get('q');
    return all(`SELECT a.*, u.name AS actor, v.name AS venue FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN venues v ON v.id=a.venue_id
                ${q ? 'WHERE a.action LIKE ? OR a.entity_id LIKE ?' : ''} ORDER BY a.created_at DESC LIMIT 300`, ...(q ? [`%${q}%`, `%${q}%`] : []))
      .map(a => ({ ...a, details: parseJson(a.details, {}) }));
  }, admin);
}
