// Shop and rentals: players browse, order and pay; front desk hands over and takes returns; managers run the catalogue.
import { all, id, now, one, run } from '../db.js';
import { rateLimit, requireVenue } from '../security.js';
import { CATEGORIES, cancelStoreOrder, catalogue, createStoreOrder, handOver, itemView, markReturned, orderView, refundStoreOrder, startStorePayment, storeSummary } from '../store.js';
import { audit } from '../audit.js';
import { created } from '../http.js';
import { SPORTS, bad, bool, date as dateOf, int, notFound, num, oneOf, str } from '../validate.js';

const paise = (v, name) => Math.round(num(v, name, { min: 0, max: 1000000 }) * 100);
const optionalPaise = (v, name) => v === undefined || v === null || v === '' ? null : paise(v, name);

function itemInput(body, current = {}) {
  const has = k => body[k] !== undefined;
  const sizes = has('sizes') ? (Array.isArray(body.sizes) ? body.sizes : String(body.sizes).split(',')).map(s => String(s).trim()).filter(Boolean).slice(0, 12) : JSON.parse(current.sizes || '[]');
  if (sizes.some(s => s.length > 12)) bad('Sizes must be short, such as S, M, L or 8');
  const v = {
    category: has('category') ? oneOf(body.category, 'Category', CATEGORIES) : current.category,
    name: has('name') ? str(body.name, 'Name', { min: 2, max: 80 }) : current.name,
    description: has('description') ? str(body.description, 'Description', { max: 300, optional: true }) : current.description ?? '',
    emoji: has('emoji') ? str(body.emoji, 'Icon', { max: 8, optional: true }) : current.emoji ?? '',
    sport: has('sport') ? oneOf(body.sport || null, 'Sport', SPORTS, { optional: true }) : current.sport ?? null,
    sizes: JSON.stringify(sizes),
    sale_price: has('salePrice') ? optionalPaise(body.salePrice, 'Sale price') : current.sale_price ?? null,
    stock: has('stock') ? int(Number(body.stock || 0), 'Stock', { min: 0, max: 10000 }) : current.stock ?? 0,
    rent_price: has('rentPrice') ? optionalPaise(body.rentPrice, 'Hire price') : current.rent_price ?? null,
    rent_unit: has('rentUnit') ? oneOf(body.rentUnit, 'Hire per', ['game', 'day']) : current.rent_unit ?? 'game',
    deposit: has('deposit') ? (optionalPaise(body.deposit, 'Deposit') ?? 0) : current.deposit ?? 0,
    rent_stock: has('rentStock') ? int(Number(body.rentStock || 0), 'Units for hire', { min: 0, max: 1000 }) : current.rent_stock ?? 0,
  };
  if (!v.category || !v.name) bad('Category and name are required');
  if (v.sale_price == null && v.rent_price == null) bad('Set a sale price, a hire price, or both');
  return v;
}

export default function storeRoutes(r) {
  // ---- Players ----
  r.get('/store/items', ({ query }) => {
    const venueId = query.get('venueId');
    const venue = one("SELECT id FROM venues WHERE id=? AND status='active'", venueId);
    if (!venue) notFound('Venue not found');
    const mode = oneOf(query.get('mode') || null, 'Mode', ['buy', 'rent'], { optional: true });
    const category = oneOf(query.get('category') || null, 'Category', CATEGORIES, { optional: true });
    const day = query.get('date') ? dateOf(query.get('date')) : null;
    return { categories: CATEGORIES, items: catalogue(venue.id, { mode, category, date: day }) };
  }, { auth: 'none' });

  r.post('/store/orders', ({ u, body }) => {
    rateLimit(`store:${u.id}`, 20, 60 * 1000);
    return created(createStoreOrder(u, { venueId: str(body.venueId, 'Venue', { min: 1, max: 64 }), kind: body.kind, items: body.items, startDate: body.startDate, days: body.days }));
  });
  r.get('/store/orders/mine', ({ u }) => all('SELECT * FROM store_orders WHERE customer_id=? ORDER BY created_at DESC LIMIT 50', u.id).map(o => orderView(o)));
  r.get('/store/orders/:id', ({ u, params }) => {
    const o = one('SELECT * FROM store_orders WHERE id=? AND customer_id=?', params.id, u.id);
    if (!o) notFound('Order not found');
    return orderView(o);
  });
  r.post('/store/orders/:id/pay', ({ u, params }) => { rateLimit(`store:${u.id}`, 20, 60 * 1000); return startStorePayment(u, params.id); });
  r.post('/store/orders/:id/cancel', ({ u, params }) => cancelStoreOrder(u, params.id));

  // ---- Venue staff: front desk hands over and takes returns; managers edit the catalogue and refund ----
  r.get('/owner/venues/:vid/store', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid);
    const orders = all("SELECT * FROM store_orders WHERE venue_id=? AND status NOT IN ('held','expired','failed','cancelled') ORDER BY CASE status WHEN 'out' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END, created_at DESC LIMIT 60", venue.id)
      .map(o => orderView(o, { staff: true }));
    return { items: catalogue(venue.id, { staff: true }), orders, summary: storeSummary(venue.id) };
  });
  r.post('/owner/venues/:vid/store/handover', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid);
    return handOver(u, venue, str(body.code, 'Code', { min: 4, max: 20 }));
  });
  r.post('/owner/venues/:vid/store/orders/:oid/return', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid);
    return markReturned(u, venue, params.oid, { keep: body.keep ? paise(body.keep, 'Amount kept') : 0, note: str(body.note, 'Note', { max: 200, optional: true }) });
  });
  r.post('/owner/venues/:vid/store/orders/:oid/refund', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const o = one('SELECT * FROM store_orders WHERE id=? AND venue_id=?', params.oid, venue.id);
    if (!o) notFound('Order not found');
    refundStoreOrder(o, { actorId: u.id, reason: str(body.reason, 'Reason', { min: 3, max: 200 }) });
    return orderView(one('SELECT * FROM store_orders WHERE id=?', o.id), { staff: true });
  });
  r.post('/owner/venues/:vid/store/items', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const v = itemInput(body), iid = id(), ts = now();
    run(`INSERT INTO store_items (id,venue_id,category,name,description,emoji,sport,sizes,sale_price,stock,rent_price,rent_unit,deposit,rent_stock,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, iid, venue.id, v.category, v.name, v.description, v.emoji, v.sport, v.sizes, v.sale_price, v.stock, v.rent_price, v.rent_unit, v.deposit, v.rent_stock, ts, ts);
    audit(u.id, 'store.item_created', 'store_item', iid, { venueId: venue.id, name: v.name });
    return created(itemView(one('SELECT * FROM store_items WHERE id=?', iid), { staff: true }));
  });
  r.patch('/owner/venues/:vid/store/items/:iid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const cur = one('SELECT * FROM store_items WHERE id=? AND venue_id=?', params.iid, venue.id);
    if (!cur) notFound('Item not found');
    const v = itemInput(body, cur), active = body.active === undefined ? cur.active : bool(body.active) ? 1 : 0;
    run(`UPDATE store_items SET category=?, name=?, description=?, emoji=?, sport=?, sizes=?, sale_price=?, stock=?, rent_price=?, rent_unit=?, deposit=?, rent_stock=?, active=?, updated_at=? WHERE id=?`,
      v.category, v.name, v.description, v.emoji, v.sport, v.sizes, v.sale_price, v.stock, v.rent_price, v.rent_unit, v.deposit, v.rent_stock, active, now(), cur.id);
    audit(u.id, 'store.item_updated', 'store_item', cur.id, { venueId: venue.id, name: v.name, active: !!active });
    return itemView(one('SELECT * FROM store_items WHERE id=?', cur.id), { staff: true });
  });
}
