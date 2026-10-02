// Vending machines: players browse machines and pre-order; venue managers register machines, set menus, restock and refund;
// machines report telemetry and redeem pickup codes with their own API key (no user session).
import { all, id, now, one, run } from '../db.js';
import { rateLimit, requireVenue } from '../security.js';
import {
  cancelOrder, createOrder, dispense, heartbeat, machineAuth, machineView, newMachineKey, orderView, refundOrder, startOrderPayment, vendingSummary,
} from '../vending.js';
import { audit } from '../audit.js';
import { created } from '../http.js';
import { bad, conflict, int, notFound, num, oneOf, str } from '../validate.js';

const KINDS = ['snacks', 'coffee', 'combo'], CATEGORIES = ['snack', 'coffee', 'drink'];
const paise = (v, name) => Math.round(num(v, name, { min: 0, max: 100000 }) * 100);
const publicMachines = venueId => all(`SELECT m.* FROM vending_machines m JOIN venues v ON v.id=m.venue_id WHERE m.active=1 AND v.status='active' ${venueId ? 'AND m.venue_id=?' : ''} ORDER BY m.name`, ...(venueId ? [venueId] : []));

function ownMachine(venue, mid) {
  const m = one('SELECT * FROM vending_machines WHERE id=? AND venue_id=?', mid, venue.id);
  if (!m) notFound('Machine not found');
  return m;
}

export default function vendingRoutes(r) {
  // ---- Players ----
  r.get('/vending/machines', ({ query }) => publicMachines(query.get('venueId')).map(m => machineView(m)), { auth: 'none' });
  r.get('/vending/machines/:id', ({ params }) => {
    const m = one("SELECT m.* FROM vending_machines m JOIN venues v ON v.id=m.venue_id WHERE m.id=? AND m.active=1 AND v.status='active'", params.id);
    if (!m) notFound('Machine not found');
    return machineView(m);
  }, { auth: 'none' });

  r.post('/vending/orders', ({ u, body }) => {
    rateLimit(`order:${u.id}`, 20, 60 * 1000);
    return created(createOrder(u, str(body.machineId, 'Machine', { min: 1, max: 64 }), body.items));
  });
  r.get('/vending/orders/mine', ({ u }) => all('SELECT * FROM vending_orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 50', u.id).map(o => orderView(o)));
  r.get('/vending/orders/:id', ({ u, params }) => {
    const o = one('SELECT * FROM vending_orders WHERE id=? AND customer_id=?', params.id, u.id);
    if (!o) notFound('Order not found');
    return orderView(o);
  });
  r.post('/vending/orders/:id/pay', ({ u, params }) => { rateLimit(`order:${u.id}`, 20, 60 * 1000); return startOrderPayment(u, params.id); });
  r.post('/vending/orders/:id/cancel', ({ u, params }) => cancelOrder(u, params.id));

  // ---- Venue staff ----
  r.get('/owner/venues/:vid/vending', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const machines = all('SELECT * FROM vending_machines WHERE venue_id=? ORDER BY name', venue.id).map(m => machineView(m, { staff: true }));
    const orders = all('SELECT * FROM vending_orders WHERE venue_id=? ORDER BY created_at DESC LIMIT 40', venue.id).map(o => ({ ...orderView(o, { forStaff: true }), customer: one('SELECT name FROM users WHERE id=?', o.customer_id)?.name || 'Player' }));
    return { machines, orders, summary: vendingSummary(venue.id, 7) };
  });

  r.post('/owner/venues/:vid/vending/machines', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const mid = id(), { key, hash } = newMachineKey(), ts = now();
    run('INSERT INTO vending_machines (id,venue_id,name,kind,location,key_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      mid, venue.id, str(body.name, 'Name', { min: 2, max: 60 }), oneOf(body.kind || 'combo', 'Type', KINDS), str(body.location, 'Location', { max: 100, optional: true }), hash, ts, ts);
    audit(u.id, 'vending.machine_created', 'vending_machine', mid, { venueId: venue.id });
    // The key is shown once; only its hash is stored.
    return created({ machine: machineView(one('SELECT * FROM vending_machines WHERE id=?', mid), { staff: true }), key });
  });

  r.patch('/owner/venues/:vid/vending/machines/:mid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const m = ownMachine(venue, params.mid);
    run('UPDATE vending_machines SET name=?, location=?, active=?, updated_at=? WHERE id=?', body.name === undefined ? m.name : str(body.name, 'Name', { min: 2, max: 60 }),
      body.location === undefined ? m.location : str(body.location, 'Location', { max: 100, optional: true }), body.active === undefined ? m.active : (body.active ? 1 : 0), now(), m.id);
    return machineView(one('SELECT * FROM vending_machines WHERE id=?', m.id), { staff: true });
  });

  r.post('/owner/venues/:vid/vending/machines/:mid/key', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const m = ownMachine(venue, params.mid), { key, hash } = newMachineKey();
    run('UPDATE vending_machines SET key_hash=?, updated_at=? WHERE id=?', hash, now(), m.id);
    audit(u.id, 'vending.key_rotated', 'vending_machine', m.id, { venueId: venue.id });
    return { key };
  });

  const itemFields = (body, cur = {}) => ({
    slot: str(body.slot ?? cur.slot, 'Slot', { min: 1, max: 8 }).toUpperCase(), name: str(body.name ?? cur.name, 'Name', { min: 1, max: 60 }),
    category: oneOf(body.category ?? cur.category, 'Category', CATEGORIES), price: body.price === undefined ? cur.price : paise(body.price, 'Price'),
    stock: int(body.stock ?? cur.stock ?? 0, 'Stock', { min: 0, max: 1000 }), capacity: int(body.capacity ?? cur.capacity ?? 10, 'Capacity', { min: 1, max: 1000 }),
    low_at: int(body.lowAt ?? cur.low_at ?? 3, 'Low-stock level', { min: 0, max: 1000 }),
  });
  r.post('/owner/venues/:vid/vending/machines/:mid/items', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const m = ownMachine(venue, params.mid), f = itemFields({ ...body, price: body.price ?? bad('Price is required') });
    if (one('SELECT 1 FROM vending_items WHERE machine_id=? AND slot=?', m.id, f.slot)) conflict(`Slot ${f.slot} is already in use`);
    const iid = id();
    run('INSERT INTO vending_items (id,machine_id,slot,name,category,price,stock,capacity,low_at) VALUES (?,?,?,?,?,?,?,?,?)', iid, m.id, f.slot, f.name, f.category, f.price, f.stock, f.capacity, f.low_at);
    return created(machineView(m, { staff: true }));
  });
  r.patch('/owner/venues/:vid/vending/machines/:mid/items/:iid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const m = ownMachine(venue, params.mid), cur = one('SELECT * FROM vending_items WHERE id=? AND machine_id=?', params.iid, m.id);
    if (!cur) notFound('Item not found');
    const f = itemFields(body, cur);
    if (f.slot !== cur.slot && one('SELECT 1 FROM vending_items WHERE machine_id=? AND slot=?', m.id, f.slot)) conflict(`Slot ${f.slot} is already in use`);
    run('UPDATE vending_items SET slot=?, name=?, category=?, price=?, stock=?, capacity=?, low_at=?, active=? WHERE id=?', f.slot, f.name, f.category, f.price, f.stock, f.capacity, f.low_at, body.active === undefined ? cur.active : (body.active ? 1 : 0), cur.id);
    audit(u.id, 'vending.item_updated', 'vending_item', cur.id, { venueId: venue.id, stock: f.stock, price: f.price });
    return machineView(m, { staff: true });
  });

  r.post('/owner/venues/:vid/vending/machines/:mid/faults/:fid/resolve', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const m = ownMachine(venue, params.mid);
    run('UPDATE vending_faults SET resolved_at=? WHERE id=? AND machine_id=? AND resolved_at IS NULL', Date.now(), params.fid, m.id);
    return machineView(m, { staff: true });
  });

  r.post('/owner/venues/:vid/vending/orders/:oid/refund', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const o = one('SELECT * FROM vending_orders WHERE id=? AND venue_id=?', params.oid, venue.id);
    if (!o) notFound('Order not found');
    if (o.status !== 'paid') conflict('Only paid orders that are not yet collected can be refunded here');
    refundOrder(o, { actorId: u.id, reason: str(body.reason, 'Reason', { max: 200, optional: true }) });
    return orderView(one('SELECT * FROM vending_orders WHERE id=?', o.id), { forStaff: true });
  });

  // ---- Machines (API key in the x-machine-key header) ----
  r.post('/device/vending/:id/heartbeat', ({ params, body, req }) => {
    rateLimit(`vm:${params.id}`, 120, 60 * 1000);
    return heartbeat(machineAuth(params.id, req.headers['x-machine-key']), body || {});
  }, { auth: 'none' });
  r.post('/device/vending/:id/dispense', ({ params, body, req }) => {
    rateLimit(`vmd:${params.id}`, 30, 60 * 1000);
    return dispense(machineAuth(params.id, req.headers['x-machine-key']), body?.code);
  }, { auth: 'none' });

}
