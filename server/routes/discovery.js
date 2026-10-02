import { config } from '../config.js';
import { all, one, parseJson } from '../db.js';
import { venueDay, venueSummary, isBookable } from '../availability.js';
import { venueToday, daysBetween } from '../time.js';
import { venueRole, verifyToken } from '../security.js';
import { subscribe } from '../events.js';
import { AMENITIES, COACH_SPECIALTIES, SPORTS, SURFACES, WELLNESS_KINDS, date as dateOf, time as timeOf, num, oneOf, bool, notFound, bad } from '../validate.js';

const R = 6371;
export function distanceKm(lat1, lng1, lat2, lng2) {
  const rad = d => d * Math.PI / 180, dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function publicVenue(v) {
  const courts = all('SELECT id,name,sports,surface,indoor,base_price FROM courts WHERE venue_id=? AND active=1 ORDER BY sort,name', v.id).map(c => ({ ...c, sports: parseJson(c.sports, []), indoor: !!c.indoor }));
  return {
    id: v.id, name: v.name, slug: v.slug, description: v.description, address: v.address, city: v.city, lat: v.lat, lng: v.lng, phone: v.phone,
    timezone: v.timezone, status: v.status, openTime: v.open_time, closeTime: v.close_time, slotMinutes: v.slot_minutes, holdMinutes: v.hold_minutes,
    bookingWindowDays: v.booking_window_days, amenities: parseJson(v.amenities, []), rules: v.rules, indoor: !!v.indoor, lighting: !!v.lighting, surface: v.surface,
    photos: parseJson(v.photos, []), videoUrl: v.video_url,
    policy: { fullHours: v.cancel_full_hours, partialHours: v.cancel_partial_hours, partialPercent: v.cancel_partial_percent },
    sports: [...new Set(courts.flatMap(c => c.sports))], courts, minPrice: courts.length ? Math.min(...courts.map(c => c.base_price)) : null,
    ...venueSummary(v.id),
  };
}

// One-turf mode: TURF_VENUE_SLUG, or the first active venue.
export function primaryVenue() {
  return (process.env.TURF_VENUE_SLUG && one("SELECT * FROM venues WHERE slug=? AND status='active'", process.env.TURF_VENUE_SLUG)) || one("SELECT * FROM venues WHERE status='active' ORDER BY rowid LIMIT 1");
}

export default function discoveryRoutes(r) {
  r.get('/meta', () => ({ sports: SPORTS, wellnessKinds: WELLNESS_KINDS, coachSpecialties: COACH_SPECIALTIES, surfaces: SURFACES, amenities: AMENITIES, currency: config.currency, devOtp: config.devOtp, paymentProvider: config.paymentProvider,
    cities: all("SELECT city, AVG(lat) AS lat, AVG(lng) AS lng, COUNT(*) AS venues FROM venues WHERE status='active' GROUP BY city ORDER BY venues DESC") }), { auth: 'none' });

  // How many venues have a bookable slot on a date, overall and per game. Feeds the count badges in the games menu.
  r.get('/sports/availability', ({ query }) => {
    const date = dateOf(query.get('date'));
    const sports = Object.fromEntries(SPORTS.map(s => [s, 0]));
    let any = 0;
    for (const row of all("SELECT * FROM venues WHERE status='active'")) {
      const open = sp => venueDay(row, date, { sport: sp }).some(c => c.slots.some(s => isBookable(s.state)));
      const offered = publicVenue(row).sports.filter(open);
      for (const sp of offered) sports[sp]++;
      if (offered.length) any++;
    }
    return { date, any, sports };
  }, { auth: 'none' });

  // One-turf mode: the app opens on this venue (TURF_VENUE_SLUG, or the first active venue).
  r.get('/site', () => {
    const row = primaryVenue();
    if (!row) notFound('No venue is open yet');
    const v = publicVenue(row);
    return { venue: { id: v.id, name: v.name, slug: v.slug, description: v.description, address: v.address, city: v.city, phone: v.phone, openTime: v.openTime, closeTime: v.closeTime, photos: v.photos, amenities: v.amenities, sports: v.sports, lat: v.lat, lng: v.lng, rating: v.rating, reviews: v.reviews },
      games: v.sports.map(sport => ({ sport, courts: v.courts.filter(c => c.sports.includes(sport)).length, fromPrice: Math.min(...v.courts.filter(c => c.sports.includes(sport)).map(c => c.base_price)) })) };
  }, { auth: 'none' });

  r.get('/venues', ({ query }) => {
    const q = Object.fromEntries(query);
    const sport = oneOf(q.sport || null, 'Sport', SPORTS, { optional: true });
    const lat = q.lat ? num(q.lat, 'Latitude', { min: -90, max: 90 }) : null, lng = q.lng ? num(q.lng, 'Longitude', { min: -180, max: 180 }) : null;
    const maxKm = q.maxKm ? num(q.maxKm, 'Distance', { min: 1, max: 500 }) : null;
    const maxPrice = q.maxPrice ? num(q.maxPrice, 'Price', { min: 0, max: 10000000 }) : null;
    const minRating = q.minRating ? num(q.minRating, 'Rating', { min: 0, max: 5 }) : null;
    const amenities = q.amenities ? q.amenities.split(',').filter(Boolean) : [];
    const time = q.time ? timeOf(q.time) : null;
    const text = (q.q || '').trim().toLowerCase();
    let venues = all("SELECT * FROM venues WHERE status='active'").map(publicVenue);
    venues = venues.filter(v =>
      (!sport || v.sports.includes(sport)) &&
      (!q.surface || v.courts.some(c => c.surface === q.surface)) &&
      (!q.indoor || (q.indoor === 'indoor' ? v.courts.some(c => c.indoor) : v.courts.some(c => !c.indoor))) &&
      (!bool(q.lighting) || v.lighting) &&
      amenities.every(a => v.amenities.includes(a)) &&
      (minRating == null || (v.rating || 0) >= minRating) &&
      (!text || `${v.name} ${v.city} ${v.address}`.toLowerCase().includes(text)));
    for (const v of venues) v.distanceKm = lat != null && lng != null ? Math.round(distanceKm(lat, lng, v.lat, v.lng) * 10) / 10 : null;
    if (maxKm != null) venues = venues.filter(v => v.distanceKm == null || v.distanceKm <= maxKm);

    // With a date, show what is actually bookable that day (optionally around the requested time).
    if (q.date) {
      const date = dateOf(q.date);
      for (const v of venues) {
        const venue = one('SELECT * FROM venues WHERE id=?', v.id);
        const courts = venueDay(venue, date, { sport });
        const open = courts.flatMap(c => c.slots.filter(s => isBookable(s.state)).map(s => ({ ...s, court: c.id })));
        const matching = time ? open.filter(s => s.start === time) : open;
        v.availableSlots = open.length;
        v.availableAtTime = time ? matching.length : null;
        v.fromPrice = (time ? matching : open).length ? Math.min(...(time ? matching : open).map(s => s.price)) : null;
        v.nextSlots = [...new Set((time ? open.filter(s => s.start >= time) : open).map(s => s.start))].sort().slice(0, 4);
      }
      if (time) venues = venues.filter(v => v.availableAtTime > 0);
    }
    if (maxPrice != null) venues = venues.filter(v => (v.fromPrice ?? v.minPrice) <= maxPrice);
    const sorters = {
      distance: (a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
      price: (a, b) => (a.fromPrice ?? a.minPrice) - (b.fromPrice ?? b.minPrice),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    };
    venues.sort(sorters[q.sort] || (lat != null ? sorters.distance : sorters.rating));
    return venues.map(({ courts, rules, ...v }) => ({ ...v, courtCount: courts.length, photos: v.photos.slice(0, 1) }));
  }, { auth: 'none' });

  r.get('/venues/:slug', ({ params, u }) => {
    const v = one('SELECT * FROM venues WHERE slug=? OR id=?', params.slug, params.slug);
    if (!v || (v.status !== 'active' && !venueRole(u, v))) notFound('Venue not found');
    const reviews = all(`SELECT r.id, r.rating, r.comment, r.owner_reply, r.created_at, u.name FROM reviews r JOIN users u ON u.id=r.customer_id
                         WHERE r.venue_id=? AND r.hidden=0 ORDER BY r.created_at DESC LIMIT 30`, v.id).map(x => ({ ...x, name: (x.name || 'Player').split(' ')[0] }));
    const histogram = [5, 4, 3, 2, 1].map(n => ({ stars: n, count: one('SELECT COUNT(*) AS c FROM reviews WHERE venue_id=? AND hidden=0 AND rating=?', v.id, n).c }));
    return { ...publicVenue(v), reviewList: reviews, histogram, today: venueToday(v) };
  }, { auth: 'optional' });

  r.get('/venues/:id/availability', ({ params, query, u }) => {
    const v = one('SELECT * FROM venues WHERE id=?', params.id);
    if (!v || (v.status !== 'active' && !venueRole(u, v))) notFound('Venue not found');
    const date = dateOf(query.get('date') || venueToday(v));
    const offset = daysBetween(venueToday(v), date);
    if (offset < -1 || offset > 120) bad('Pick a date within the booking window');
    const sport = oneOf(query.get('sport') || null, 'Sport', SPORTS, { optional: true });
    return { date, venueId: v.id, slotMinutes: v.slot_minutes, courts: venueDay(v, date, { sport }), serverTime: Date.now() };
  }, { auth: 'optional' });

  // EventSource cannot send headers, so the user channel authenticates with a short-lived stream ticket.
  r.get('/stream', ({ query, req, res }) => {
    const venueId = query.get('venue') || null;
    const user = query.get('ticket') ? verifyToken(query.get('ticket'), 'stream') : null;
    if (!venueId && !user) bad('Subscribe to a venue or pass a stream ticket');
    subscribe(req, res, { venueId, userId: user?.id || null });
  }, { auth: 'none' });
}
