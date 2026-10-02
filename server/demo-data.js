import { all, id, now, one, run, transaction } from './db.js';
import { slotStarts } from './availability.js';
import { addDays, toMin, toHHMM, weekday, zonedParts, zonedToEpoch } from './time.js';
import { randomCode } from './security.js';

const TZ = 'Asia/Kolkata';
let seed = 20261001;
const rand = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = arr => arr[Math.floor(rand() * arr.length)];
const ref = () => 'TC' + randomCode(8);

function user(name, { email = null, phone = null, role = 'customer', referredBy = null } = {}) {
  const uid = id();
  run('INSERT INTO users (id,name,email,phone,role,referral_code,referred_by,created_at) VALUES (?,?,?,?,?,?,?,?)', uid, name, email, phone, role, randomCode(6), referredBy, new Date(Date.now() - 60 * 86400000).toISOString());
  return uid;
}

const VENUES = [
  { key: 'kickoff', name: 'Kickoff Arena', city: 'Bengaluru', address: '80 Feet Road, 4th Block, Koramangala', lat: 12.9352, lng: 77.6245, surface: 'artificial_grass', indoor: 0,
    description: 'FIFA-quality artificial turf with two 5-a-side pitches, a 7-a-side pitch and a netted box-cricket arena. Floodlit until 11 pm.',
    amenities: ['parking', 'washroom', 'changing_room', 'drinking_water', 'first_aid', 'floodlights', 'seating', 'cctv'], photos: ['/img/venue-1.svg', '/img/venue-2.svg'],
    rules: 'Turf shoes or flat soles only — no metal studs.\nArrive 10 minutes early for check-in.\nNo food or glass bottles on the pitch.\nPlayers under 14 must be accompanied by an adult.',
    courts: [['Pitch A (5-a-side)', ['football'], 120000], ['Pitch B (5-a-side)', ['football'], 120000], ['Pitch C (7-a-side)', ['football'], 180000], ['Box Cricket Arena', ['cricket'], 110000]],
    rules_: [['Evening peak', '12345', '18:00', '23:00', 1.25], ['Weekend', '06', '06:00', '23:00', 1.4]], block: ['1', '06:00', '08:00', 'Turf maintenance'] },
  { key: 'smash', name: 'Smash Point Badminton', city: 'Bengaluru', address: '12th Main Road, HAL 2nd Stage, Indiranagar', lat: 12.9719, lng: 77.6412, surface: 'wooden', indoor: 1,
    description: 'Four BWF-standard wooden badminton courts with anti-glare lighting and air circulation. Racquet and shuttle rental at the desk.',
    amenities: ['parking', 'washroom', 'changing_room', 'drinking_water', 'equipment_rental', 'showers', 'wifi'], photos: ['/img/venue-3.svg'],
    rules: 'Non-marking shoes are mandatory.\nOne booking covers up to 4 players.\nShuttles are not included in the court fee.',
    courts: [['Court 1', ['badminton'], 40000], ['Court 2', ['badminton'], 40000], ['Court 3', ['badminton'], 40000], ['Court 4', ['badminton'], 40000]],
    rules_: [['Peak hours', '0123456', '17:00', '22:00', 1.35]] },
  { key: 'boundary', name: 'Boundary Box Cricket', city: 'Bengaluru', address: '27th Main, Sector 2, HSR Layout', lat: 12.9116, lng: 77.6474, surface: 'artificial_grass', indoor: 0,
    description: 'Two fully netted box-cricket arenas with bowling machines available on request. Great for corporate games.',
    amenities: ['parking', 'washroom', 'drinking_water', 'floodlights', 'seating', 'cafeteria'], photos: ['/img/venue-4.svg'],
    rules: 'Tennis or rubber balls only.\nMaximum 16 players per arena.',
    courts: [['Arena 1', ['cricket'], 100000], ['Arena 2', ['cricket', 'football'], 100000]],
    rules_: [['Weekend', '06', '06:00', '23:00', 1.3]] },
  { key: 'goal', name: 'Goal Street Futsal', city: 'Bengaluru', address: 'ITPL Main Road, Whitefield', lat: 12.9698, lng: 77.75, surface: 'synthetic', indoor: 1,
    description: 'Indoor futsal on a cushioned synthetic floor. Weatherproof, so monsoon games never get washed out.',
    amenities: ['parking', 'washroom', 'changing_room', 'drinking_water', 'showers', 'cafeteria', 'cctv'], photos: ['/img/venue-5.svg'],
    rules: 'Futsal balls provided.\nNo outdoor shoes on court.',
    courts: [['Court North', ['futsal', 'football'], 140000], ['Court South', ['futsal', 'football'], 140000]],
    rules_: [['Evening peak', '12345', '19:00', '23:00', 1.2]] },
  { key: 'rally', name: 'Rally Club', city: 'Bengaluru', address: '15th Cross, JP Nagar 6th Phase', lat: 12.9063, lng: 77.5857, surface: 'clay', indoor: 0,
    description: 'Two red-clay tennis courts and two pickleball courts in a quiet, tree-lined club. Coaching available.',
    amenities: ['parking', 'washroom', 'drinking_water', 'seating', 'equipment_rental', 'floodlights'], photos: ['/img/venue-6.svg'],
    rules: 'Tennis whites preferred on clay.\nCourts are swept between bookings.',
    courts: [['Clay Court 1', ['tennis'], 60000], ['Clay Court 2', ['tennis'], 60000], ['Pickleball 1', ['pickleball'], 50000], ['Pickleball 2', ['pickleball'], 50000]],
    rules_: [] },
  { key: 'marina', name: 'Marina Sports Hub', city: 'Chennai', address: 'Kamarajar Salai, Triplicane', lat: 13.05, lng: 80.2824, surface: 'artificial_grass', indoor: 0, pending: true,
    description: 'New multi-sport turf near the beach with football and cricket.', amenities: ['parking', 'washroom', 'floodlights'], photos: ['/img/venue-2.svg'],
    rules: '', courts: [['Main Turf', ['football', 'cricket'], 110000]], rules_: [] },
];

const COMMENTS = ['Great turf, well maintained and the lights are excellent.', 'Staff were friendly and check-in took a minute.', 'Good surface but parking gets crowded on weekends.',
  'Perfect for our office games. Will book again.', 'Clean washrooms and plenty of drinking water.', 'Slightly pricey at peak time but worth it.', 'The booking QR made entry really quick.', ''];
const PLAYERS = ['Karthik Raman', 'Priya Nair', 'Rahul Menon', 'Divya Shetty', 'Vikram Rao', 'Sneha Iyer', 'Aditya Bhat', 'Neha Gowda', 'Rohit Das', 'Ananya Reddy', 'Siddharth Jain', 'Pooja Kulkarni', 'Farhan Ali'];

export function seedDemo() {
  if (one('SELECT COUNT(*) AS n FROM venues').n) return 'Demo data already present (use --reset to start over).';
  const today = zonedParts(Date.now(), TZ);
  return transaction(() => {
    user('Asha (TurfConnect admin)', { email: 'admin@turfconnect.test', role: 'admin' });
    const owner = user('Ravi Kumar', { email: 'owner@turfconnect.test', phone: '+919800000001', role: 'owner' });
    const owner2 = user('Lakshmi Sundaram', { email: 'owner2@turfconnect.test', role: 'owner' });
    const manager = user('Meena Pillai', { email: 'manager@turfconnect.test' });
    const desk = user('Arjun Desk', { email: 'desk@turfconnect.test' });
    const players = PLAYERS.map((n, i) => user(n, i === 0 ? { email: 'player@turfconnect.test', phone: '+919800000010' } : { phone: `+9198000001${String(i).padStart(2, '0')}` }));
    const player = players[0];
    run('UPDATE users SET referred_by=? WHERE id=?', player, players[1]);

    const venues = {};
    for (const [i, v] of VENUES.entries()) {
      const vid = id();
      run(`INSERT INTO venues (id,owner_id,name,slug,description,address,city,lat,lng,phone,timezone,status,amenities,rules,indoor,lighting,surface,photos,business_name,tax_id,payout_holder,payout_bank,payout_last4,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        vid, v.pending ? owner2 : owner, v.name, v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), v.description, v.address, v.city, v.lat, v.lng, `+91 80 4${i}00 12${i}4`, TZ,
        v.pending ? 'pending' : 'active', JSON.stringify(v.amenities), v.rules, v.indoor, 1, v.surface, JSON.stringify(v.photos),
        v.pending ? 'Marina Sports LLP' : 'Kumar Sports Ventures', v.pending ? '' : '29ABCDE1234F1Z5', v.pending ? 'Lakshmi Sundaram' : 'Ravi Kumar', 'HDFC Bank', String(4321 + i), now(), now());
      const courts = v.courts.map(([name, sports, price], n) => {
        const cid = id();
        run('INSERT INTO courts (id,venue_id,name,sports,surface,indoor,base_price,sort) VALUES (?,?,?,?,?,?,?,?)', cid, vid, name, JSON.stringify(sports), v.surface, v.indoor, price, n);
        return { id: cid, sports, price };
      });
      for (const [label, days, from, to, mult] of v.rules_) run('INSERT INTO price_rules (id,venue_id,label,weekdays,start_time,end_time,price,created_at) VALUES (?,?,?,?,?,?,?,?)',
        id(), vid, label, days, from, to, Math.round(courts[0].price * mult / 1000) * 1000, now());
      if (v.block) run('INSERT INTO recurring_blocks (id,venue_id,weekdays,start_time,end_time,reason,created_at) VALUES (?,?,?,?,?,?,?)', id(), vid, ...v.block, now());
      venues[v.key] = { id: vid, ...v, courts, venue: one('SELECT * FROM venues WHERE id=?', vid) };
    }
    run("INSERT INTO venue_staff (venue_id,user_id,role,created_at) VALUES (?,?,'manager',?)", venues.kickoff.id, manager, now());
    run("INSERT INTO venue_staff (venue_id,user_id,role,created_at) VALUES (?,?,'front_desk',?)", venues.kickoff.id, desk, now());

    run(`INSERT INTO coupons (id,code,kind,value,max_discount,per_user_limit,description,created_at) VALUES (?,?,?,?,?,?,?,?)`, id(), 'WELCOME20', 'percent', 20, 20000, 1, '20% off your first booking (up to ₹200)', now());
    run(`INSERT INTO coupons (id,venue_id,code,kind,value,min_amount,per_user_limit,description,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, id(), venues.kickoff.id, 'KICKOFF100', 'flat', 10000, 100000, 3, '₹100 off bookings of ₹1,000+', now());

    // Booking history: busier evenings and weekends, a few cancellations, mostly online payments.
    const priceFor = (v, court, date, start) => {
      const rules = all('SELECT * FROM price_rules WHERE venue_id=?', v.id).filter(r => r.weekdays.includes(String(weekday(date))) && toMin(start) >= toMin(r.start_time) && toMin(start) < toMin(r.end_time));
      return rules.length ? Math.round(rules[0].price * court.price / v.courts[0].price / 1000) * 1000 : court.price;
    };
    let count = 0;
    const book = ({ v, court, date, start, customer, status, source = 'online', review = null, refund = 0 }) => {
      const venue = v.venue, end = toHHMM(toMin(start) + venue.slot_minutes), price = priceFor(v, court, date, start), bid = id(), r = ref();
      const startAt = zonedToEpoch(date, toMin(start), TZ), endAt = zonedToEpoch(date, toMin(end), TZ);
      const createdAt = new Date(startAt - (1 + rand() * 72) * 3600000).toISOString();
      const name = source === 'manual' ? pick(['Walk-in team', 'Corporate group', 'Academy batch', 'Regular – Sunil']) : '';
      run(`INSERT INTO bookings (id,ref,venue_id,court_id,customer_id,customer_name,customer_phone,sport,date,start_time,end_time,start_at,end_at,slots,status,source,subtotal,discount,amount,price_snapshot,policy_snapshot,offline_method,checked_in_at,created_at,confirmed_at,cancelled_at,cancel_reason,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?)`,
        bid, r, venue.id, court.id, source === 'manual' ? null : customer, name, source === 'manual' ? '+9190000' + String(Math.floor(rand() * 99999)).padStart(5, '0') : '',
        court.sports[0], date, start, end, startAt, endAt, JSON.stringify([start]), status, source, price, price,
        JSON.stringify([{ start, end, price }]), JSON.stringify({ fullHours: venue.cancel_full_hours, partialHours: venue.cancel_partial_hours, partialPercent: venue.cancel_partial_percent }),
        source === 'manual' ? 'cash' : '', status === 'completed' && rand() < 0.9 ? new Date(startAt - 600000).toISOString() : null,
        createdAt, createdAt, status === 'cancelled' ? new Date(startAt - 30 * 3600000).toISOString() : null, status === 'cancelled' ? 'Plans changed' : '', createdAt);
      if (status !== 'cancelled') run('INSERT INTO slot_claims (court_id,date,start_time,booking_id) VALUES (?,?,?,?)', court.id, date, start, bid);
      if (source === 'online') {
        const pid = id();
        run(`INSERT INTO payments (id,booking_id,provider,intent_id,amount,refunded,currency,status,created_at,updated_at) VALUES (?,?,'sandbox',?,?,?,'INR',?,?,?)`,
          pid, bid, 'pi_seed_' + bid.slice(0, 12), price, refund, refund ? (refund >= price ? 'refunded' : 'partially_refunded') : 'succeeded', createdAt, createdAt);
        if (refund) run(`INSERT INTO refunds (id,booking_id,payment_id,amount,status,reason,origin,requested_by,provider_ref,created_at,decided_at) VALUES (?,?,?,?,'processed','Cancellation policy 100%','policy',?,?,?,?)`,
          id(), bid, pid, refund, customer, 're_seed_' + bid.slice(0, 8), createdAt, createdAt);
      }
      if (review) run('INSERT INTO reviews (id,venue_id,booking_id,customer_id,rating,comment,created_at) VALUES (?,?,?,?,?,?,?)', id(), venue.id, bid, customer, review.rating, review.comment, new Date(endAt + 3 * 3600000).toISOString());
      count++;
      return { id: bid, ref: r, price };
    };

    const active = Object.values(venues).filter(v => !v.pending);
    for (let d = -42; d <= 6; d++) {
      const date = addDays(today.date, d), weekend = [0, 6].includes(weekday(date));
      for (const v of active) for (const court of v.courts) for (const start of slotStarts(v.venue)) {
        const hour = toMin(start) / 60;
        if (v.block && weekday(date) === 1 && hour < 8) continue;
        if (d === 0 && toMin(start) <= today.minutes + 60) continue;
        const demand = (hour >= 18 ? 0.62 : hour >= 16 ? 0.4 : hour < 9 ? 0.28 : 0.12) * (weekend ? 1.35 : 1) * (d > 0 ? 0.55 - d * 0.06 : 1);
        if (rand() > demand) continue;
        const customer = pick(players.slice(1));
        if (d < 0) {
          const cancelled = rand() < 0.05;
          const manual = !cancelled && rand() < 0.2;
          const b = book({ v, court, date, start, customer, status: cancelled ? 'cancelled' : 'completed', source: manual ? 'manual' : 'online',
            review: !cancelled && !manual && rand() < 0.3 ? { rating: pick([5, 5, 5, 4, 4, 4, 3]), comment: pick(COMMENTS) } : null, refund: 0 });
          if (cancelled) { const p = one('SELECT * FROM payments WHERE booking_id=?', b.id); if (p) { run("UPDATE payments SET refunded=amount, status='refunded' WHERE id=?", p.id);
            run(`INSERT INTO refunds (id,booking_id,payment_id,amount,status,reason,origin,provider_ref,created_at,decided_at) VALUES (?,?,?,?,'processed','Cancellation policy 100%','policy','re_seed',?,?)`, id(), b.id, p.id, p.amount, now(), now()); } }
        } else book({ v, court, date, start, customer, status: 'confirmed', source: rand() < 0.25 ? 'manual' : 'online' });
      }
    }

    // The demo player's own history.
    const k = venues.kickoff, pitch = k.courts[0];
    const free = (court, date, from) => slotStarts(k.venue).find(s => s >= from && !one('SELECT 1 FROM slot_claims WHERE court_id=? AND date=? AND start_time=?', court.id, date, s));
    const past1 = book({ v: k, court: pitch, date: addDays(today.date, -9), start: free(pitch, addDays(today.date, -9), '08:00'), customer: player, status: 'completed', review: { rating: 5, comment: 'Brilliant pitch and quick check-in with the QR code.' } });
    run("UPDATE reviews SET owner_reply='Thanks Karthik! See you on the pitch again soon.' WHERE booking_id=?", past1.id);
    book({ v: venues.smash, court: venues.smash.courts[1], date: addDays(today.date, -4), start: '10:00', customer: player, status: 'completed' });
    const disputed = book({ v: k, court: k.courts[2], date: addDays(today.date, -2), start: free(k.courts[2], addDays(today.date, -2), '09:00'), customer: player, status: 'completed' });
    book({ v: k, court: pitch, date: addDays(today.date, 2), start: free(pitch, addDays(today.date, 2), '08:00'), customer: player, status: 'confirmed' });
    book({ v: venues.rally, court: venues.rally.courts[0], date: addDays(today.date, 4), start: free(venues.rally.courts[0], addDays(today.date, 4), '07:00') || '07:00', customer: player, status: 'confirmed' });

    // A pending refund request and support conversations to triage.
    const rq = all("SELECT b.*, p.id AS pid, p.amount AS paid FROM bookings b JOIN payments p ON p.booking_id=b.id WHERE b.venue_id=? AND b.status='completed' ORDER BY b.date DESC LIMIT 1", k.id)[0];
    run(`INSERT INTO refunds (id,booking_id,payment_id,amount,status,reason,origin,requested_by,created_at) VALUES (?,?,?,?,'pending',?,'customer_request',?,?)`,
      id(), rq.id, rq.pid, Math.round(rq.paid / 2), 'Floodlights on half the pitch were off for the first 20 minutes.', rq.customer_id, now());
    const t1 = id();
    run("INSERT INTO support_tickets (id,user_id,venue_id,kind,subject,created_at,updated_at) VALUES (?,?,?,'support',?,?,?)", t1, player, k.id, 'Can we bring our own goalkeeper gloves and ball?', now(), now());
    run('INSERT INTO support_messages (id,ticket_id,author_id,body,created_at) VALUES (?,?,?,?,?)', id(), t1, player, 'Hi! Planning a game this weekend — is it fine to bring our own ball and gloves?', now());
    run('INSERT INTO support_messages (id,ticket_id,author_id,body,created_at) VALUES (?,?,?,?,?)', id(), t1, manager, 'Absolutely — your own equipment is welcome. Just no metal studs on the turf please!', now());
    const t2 = id();
    run("INSERT INTO support_tickets (id,user_id,venue_id,booking_id,kind,subject,created_at,updated_at) VALUES (?,?,?,?,'dispute',?,?,?)", t2, player, k.id, disputed.id, 'Pitch was double-booked with an academy session', now(), now());
    run('INSERT INTO support_messages (id,ticket_id,author_id,body,created_at) VALUES (?,?,?,?,?)', id(), t2, player, 'When we arrived an academy batch was using half the pitch for 30 minutes. Requesting a partial refund.', now());

    // A settled payout from a month ago.
    const ps = addDays(today.date, -35), pe = addDays(today.date, -29);
    const t = one(`SELECT COALESCE(SUM(p.amount),0) AS gross, COALESCE(SUM(p.refunded),0) AS refunds FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE b.venue_id=? AND b.date BETWEEN ? AND ?`, k.id, ps, pe);
    const commission = Math.round((t.gross - t.refunds) * 0.1);
    run("INSERT INTO payouts (id,venue_id,period_start,period_end,gross,refunds,commission,net,status,reference,created_at,paid_at) VALUES (?,?,?,?,?,?,?,?,'paid','NEFT-DEMO-0001',?,?)",
      id(), k.id, ps, pe, t.gross, t.refunds, commission, t.gross - t.refunds - commission, now(), now());

    run("INSERT INTO notifications (id,user_id,channel,kind,title,body,link,status,send_after,sent_at,created_at) VALUES (?,?,'inapp','welcome','Welcome to TurfConnect','Use code WELCOME20 for 20% off your next booking.','#/profile','sent',?,?,?)", id(), player, Date.now(), now(), now());
    return `Seeded ${Object.keys(venues).length} venues, ${players.length} players and ${count} bookings.`;
  });
}
