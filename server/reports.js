// Venue analytics over a date range: revenue, bookings, cancellations, occupancy and peak hours.
// Occupancy = booked slots / bookable slots, where bookable excludes recurring closures and manual blocks.
import { all, parseJson } from './db.js';
import { slotStarts } from './availability.js';
import { addDays, daysBetween, toMin, weekday } from './time.js';

export function venueReport(venue, from, to) {
  const days = daysBetween(from, to) + 1;
  const courts = all('SELECT id, name FROM courts WHERE venue_id=? AND active=1', venue.id);
  const starts = slotStarts(venue);
  const blocks = all('SELECT * FROM recurring_blocks WHERE venue_id=?', venue.id);
  const overrides = new Map(all('SELECT o.* FROM slot_overrides o JOIN courts c ON c.id=o.court_id WHERE c.venue_id=? AND o.date BETWEEN ? AND ?', venue.id, from, to)
    .map(o => [`${o.court_id}|${o.date}|${o.start_time}`, o]));
  const bookings = all(`SELECT b.*, p.amount AS paid, p.refunded, p.status AS pay_status FROM bookings b
      LEFT JOIN payments p ON p.booking_id=b.id AND p.status IN ('succeeded','partially_refunded','refunded')
      WHERE b.venue_id=? AND b.date BETWEEN ? AND ? AND b.status IN ('confirmed','completed','cancelled')`, venue.id, from, to);

  const series = new Map();
  for (let i = 0; i < days; i++) series.set(addDays(from, i), { date: addDays(from, i), bookings: 0, revenue: 0, bookedSlots: 0, capacity: 0, cancellations: 0 });
  for (const [date, row] of series) {
    const day = String(weekday(date));
    for (const c of courts) for (const s of starts) {
      const o = overrides.get(`${c.id}|${date}|${s}`);
      const recurring = blocks.some(b => (!b.court_id || b.court_id === c.id) && b.weekdays.includes(day) && toMin(s) >= toMin(b.start_time) && toMin(s) < toMin(b.end_time));
      if (o?.state === 'blocked' || (recurring && o?.state !== 'open')) continue;
      row.capacity++;
    }
  }
  const hours = Array.from({ length: 7 }, () => Array(24).fill(0));
  const byCourt = new Map(courts.map(c => [c.id, { court: c.name, bookings: 0, revenue: 0, bookedSlots: 0 }]));
  const customers = new Map();
  let online = 0, offline = 0, refunds = 0, cancellations = 0;
  for (const b of bookings) {
    const row = series.get(b.date);
    // Cash collected online minus refunds already given back; manual bookings count what the desk recorded.
    const revenue = b.source === 'manual' ? (b.status === 'cancelled' ? 0 : b.amount) : (b.paid || 0) - (b.refunded || 0);
    refunds += b.refunded || 0;
    row.revenue += revenue;
    if (b.source === 'manual') offline += revenue; else online += revenue;
    const court = byCourt.get(b.court_id);
    if (court) court.revenue += revenue;
    if (b.status === 'cancelled') { row.cancellations++; cancellations++; continue; }
    const slots = parseJson(b.slots, []);
    row.bookings++; row.bookedSlots += slots.length;
    if (court) { court.bookings++; court.bookedSlots += slots.length; }
    for (const s of slots) hours[weekday(b.date)][Math.floor(toMin(s) / 60)]++;
    const key = b.customer_id || b.customer_phone || b.customer_name;
    if (key) customers.set(key, (customers.get(key) || 0) + 1);
  }
  const rows = [...series.values()].map(r => ({ ...r, occupancy: r.capacity ? Math.round(r.bookedSlots / r.capacity * 1000) / 10 : 0 }));
  const total = rows.reduce((a, r) => ({ bookings: a.bookings + r.bookings, revenue: a.revenue + r.revenue, bookedSlots: a.bookedSlots + r.bookedSlots, capacity: a.capacity + r.capacity }), { bookings: 0, revenue: 0, bookedSlots: 0, capacity: 0 });
  const repeat = [...customers.values()].filter(n => n > 1).length;
  return {
    from, to,
    totals: {
      ...total, online, offline, refunds, cancellations,
      occupancy: total.capacity ? Math.round(total.bookedSlots / total.capacity * 1000) / 10 : 0,
      cancellationRate: total.bookings + cancellations ? Math.round(cancellations / (total.bookings + cancellations) * 1000) / 10 : 0,
      averageBooking: total.bookings ? Math.round(total.revenue / total.bookings) : 0,
      revenuePerSlot: total.capacity ? Math.round(total.revenue / total.capacity) : 0,
      customers: customers.size, repeatCustomers: repeat,
    },
    series: rows, byCourt: [...byCourt.values()], hours,
  };
}
