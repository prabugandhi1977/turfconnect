import { all, id, now, one, run, transaction } from './db.js';
import { slotStarts } from './availability.js';
import { addDays, toMin, toHHMM, weekday, zonedParts, zonedToEpoch } from './time.js';
import { randomCode } from './security.js';
import { createHash } from 'node:crypto';

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
    courts: [['Pitch A (5-a-side)', ['football'], 120000], ['Pitch B (5-a-side)', ['football'], 120000], ['Pitch C (7-a-side)', ['football'], 180000], ['Box Cricket Arena', ['cricket'], 110000], ['Badminton Hall 1', ['badminton'], 50000, 'wooden', 1], ['Badminton Hall 2', ['badminton'], 50000, 'wooden', 1], ['Tennis Court', ['tennis'], 70000, 'hard_court', 0], ['Pool Lane 1', ['swimming'], 30000, 'pool', 0], ['Pool Lane 2', ['swimming'], 30000, 'pool', 0]],
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
  { key: 'aqua', name: 'Aqua Arena Pool', city: 'Bengaluru', address: '5th Block, Jayanagar', lat: 12.925, lng: 77.5938, surface: 'pool', indoor: 0,
    description: 'A heated 25-metre, four-lane pool with a shallow end for kids, lifeguards on duty and lane booking by the hour. Aqua aerobics and wellness classes run through the week.',
    amenities: ['parking', 'washroom', 'changing_room', 'drinking_water', 'first_aid', 'showers', 'seating', 'cctv'], photos: ['/img/venue-7.svg'],
    rules: 'Swim caps are mandatory.\nShower before entering the pool.\nUp to 4 swimmers per lane booking.\nChildren under 12 need an adult in the water.',
    courts: [['Lane 1 (lap)', ['swimming'], 30000], ['Lane 2 (lap)', ['swimming'], 30000], ['Lane 3 (family)', ['swimming'], 40000], ['Lane 4 (coaching)', ['swimming'], 50000]],
    rules_: [['Weekend', '06', '06:00', '22:00', 1.3]] },
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
    user('Asha (Thidal admin)', { email: 'admin@turfconnect.test', role: 'admin' });
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
      const courts = v.courts.map(([name, sports, price, surface, indoor], n) => {
        const cid = id();
        run('INSERT INTO courts (id,venue_id,name,sports,surface,indoor,base_price,sort) VALUES (?,?,?,?,?,?,?,?)', cid, vid, name, JSON.stringify(sports), surface ?? v.surface, indoor ?? v.indoor, price, n);
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

    // Wellness sessions for the next ten days: a mix of in-person classes and online ones with a join link.
    const CLASSES = [
      ['kickoff', 'Aqua aerobics', 'aqua', 'in_person', 'Low-impact, full-body workout in the pool. Suitable for all ages and fitness levels.', 'Coach Divya', '07:00', '08:00', 16, 25000],
      ['kickoff', 'Evening lap clinic', 'fitness', 'in_person', 'Technique drills and pacing for lap swimmers. Bring a cap and goggles.', 'Coach Imran', '18:30', '19:30', 10, 35000],
      ['kickoff', 'Morning vinyasa yoga', 'yoga', 'in_person', 'A flowing sequence to wake up the body and steady the breath. Mats provided.', 'Anjali Rao', '06:30', '07:30', 14, 30000],
      ['kickoff', 'Football conditioning', 'fitness', 'in_person', 'Agility, stamina and injury-prevention circuits on the turf.', 'Coach Sameer', '17:30', '18:30', 20, 20000],
      ['kickoff', 'Breathwork and mobility', 'breathwork', 'in_person', 'Guided breathing and gentle mobility to recover between games.', 'Meera Nair', '19:00', '20:00', 12, 25000],
      ['kickoff', 'Live guided meditation', 'meditation', 'online', 'Twenty minutes of guided meditation followed by a short Q&A. Join from anywhere.', 'Swami Kiran', '06:00', '06:45', 200, 9900],
      ['kickoff', 'Online mobility and stretch', 'pilates', 'online', 'A live streamed stretch routine for swimmers and runners. No equipment needed.', 'Anjali Rao', '20:00', '20:45', 150, 14900],
      ['kickoff', 'Online HIIT live', 'fitness', 'online', 'A 30-minute high-intensity interval session you can do in your living room.', 'Coach Sameer', '07:00', '07:45', 100, 12900],
    ];
    for (let d = 0; d < 10; d++) {
      const date = addDays(today.date, d);
      for (const [i, [key, title, kind, mode, desc, trainer, from, to, capacity, price]] of CLASSES.entries()) {
        if ((d + i) % 3 === 2) continue; // not every class runs every day
        const startAt = zonedToEpoch(date, toMin(from), TZ);
        if (startAt <= Date.now() + 3600000) continue;
        run(`INSERT INTO wellness_sessions (id,venue_id,title,kind,mode,description,trainer,date,start_time,end_time,start_at,end_at,capacity,price,join_url,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id(), venues[key].id, title, kind, mode, desc, trainer, date, from, to, startAt, zonedToEpoch(date, toMin(to), TZ), capacity, price,
          mode === 'online' ? `https://meet.example.com/turfconnect/${kind}-${date}` : '', now(), now());
      }
    }

    // Vending machines. Demo API keys are fixed (vm_demo_<slug>) so the device API can be tried with curl.
    const MACHINES = [
      ['kickoff', 'Snack Point', 'snacks', 'Near the main entrance', 'online', [['A1', 'Classic chips', 'snack', 20, 14], ['A2', 'Masala puffs', 'snack', 20, 11], ['A3', 'Choco cream biscuits', 'snack', 25, 9], ['A4', 'Protein bar', 'snack', 80, 6],
        ['B1', 'Mineral water 500ml', 'drink', 20, 18], ['B2', 'Energy drink', 'drink', 125, 2], ['B3', 'Electrolyte drink', 'drink', 60, 8]]],
      ['kickoff', 'Barista Bot', 'coffee', 'Clubhouse lobby', 'online', [['C1', 'Espresso', 'coffee', 60, 40], ['C2', 'Cappuccino', 'coffee', 90, 35], ['C3', 'Latte', 'coffee', 100, 30], ['C4', 'Masala chai', 'coffee', 40, 45], ['C5', 'Hot chocolate', 'coffee', 90, 18]]],
      ['smash', 'Court Corner', 'combo', 'Beside Court 1', 'online', [['A1', 'Banana chips', 'snack', 30, 10], ['A2', 'Trail mix', 'snack', 70, 8], ['B1', 'Mineral water 500ml', 'drink', 20, 20], ['C1', 'Filter coffee', 'coffee', 40, 30], ['C2', 'Green tea', 'coffee', 40, 28]]],
      ['aqua', 'Poolside Brew', 'coffee', 'Pool deck', 'warning', [['C1', 'Cappuccino', 'coffee', 90, 25], ['C2', 'Iced coffee', 'coffee', 110, 0], ['C3', 'Masala chai', 'coffee', 40, 30], ['A1', 'Fruit bar', 'snack', 50, 12]]],
      ['goal', 'Futsal Snacks', 'snacks', 'Court entrance', 'fault', [['A1', 'Classic chips', 'snack', 20, 12], ['A2', 'Nachos', 'snack', 45, 7], ['B1', 'Mineral water 500ml', 'drink', 20, 15]]],
      ['rally', 'Clubhouse Snacks', 'snacks', 'Veranda', 'offline', [['A1', 'Roasted nuts', 'snack', 60, 9], ['B1', 'Mineral water 500ml', 'drink', 20, 14]]],
    ];
    for (const [key, name, kind, location, state, items] of MACHINES) {
      const mid = id(), slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
      run('INSERT INTO vending_machines (id,venue_id,name,kind,location,key_hash,temperature,last_seen_at,alerted_offline,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', mid, venues[key].id, name, kind, location,
        createHash('sha256').update('vm_demo_' + slug).digest('hex'), kind === 'coffee' ? 84 : 4.2, state === 'offline' ? Date.now() - 25 * 60000 : Date.now(), state === 'offline' ? 1 : 0, now(), now());
      for (const [slot, iname, category, rupees, stock] of items) run('INSERT INTO vending_items (id,machine_id,slot,name,category,price,stock,capacity,low_at) VALUES (?,?,?,?,?,?,?,?,3)', id(), mid, slot, iname, category, rupees * 100, stock, Math.max(stock, 20));
      if (state === 'warning') run("INSERT INTO vending_faults (id,machine_id,code,message,severity,opened_at) VALUES (?,?,'LOW_MILK','Milk reservoir below 15%','warning',?)", id(), mid, Date.now() - 40 * 60000);
      if (state === 'fault') run("INSERT INTO vending_faults (id,machine_id,code,message,severity,opened_at) VALUES (?,?,'COIL_JAM','Spiral A2 is jammed','critical',?)", id(), mid, Date.now() - 12 * 60000);
    }

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
    book({ v: venues.smash, court: venues.smash.courts[1], date: addDays(today.date, -4), start: free(venues.smash.courts[1], addDays(today.date, -4), '10:00'), customer: player, status: 'completed' });
    const disputed = book({ v: k, court: k.courts[2], date: addDays(today.date, -2), start: free(k.courts[2], addDays(today.date, -2), '09:00'), customer: player, status: 'completed' });
    book({ v: k, court: pitch, date: addDays(today.date, 2), start: free(pitch, addDays(today.date, 2), '08:00'), customer: player, status: 'confirmed' });
    book({ v: venues.rally, court: venues.rally.courts[0], date: addDays(today.date, 4), start: free(venues.rally.courts[0], addDays(today.date, 4), '07:00') || '07:00', customer: player, status: 'confirmed' });

    // Entry gates and cameras at two venues, a week of gate and camera history, and a live scenario for today.
    const sha = s => createHash('sha256').update(s).digest('hex');
    const gateIds = {}, camIds = {};
    const GATES = { kickoff: [['Main Gate', 'gate', 'Front entrance'], ['Pitch Door', 'door', 'Pitch side']], smash: [['Court Entrance', 'gate', 'Reception']] };
    const CAMS = { kickoff: [['Gate camera', 'Front entrance'], ['Pitch camera', 'Pitches A-C'], ['Parking camera', 'Parking lot']], smash: [['Courts camera', 'Courts 1-4']] };
    const slugOf = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
    for (const [key, list] of Object.entries(GATES)) {
      gateIds[key] = list.map(([name, kind, location]) => {
        const gid = id();
        run('INSERT INTO access_points (id,venue_id,name,kind,location,key_hash,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', gid, venues[key].id, name, kind, location, sha('ax_demo_' + slugOf(name)), Date.now(), now(), now());
        return gid;
      });
    }
    for (const [key, list] of Object.entries(CAMS)) {
      camIds[key] = list.map(([name, location]) => {
        const cid = id();
        run('INSERT INTO cameras (id,venue_id,name,location,stream_url,key_hash,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', cid, venues[key].id, name, location,
          key === 'kickoff' ? `/img/cam-${slugOf(name).split('-')[0]}.svg` : `https://cams.example.com/${key}/${slugOf(name)}.m3u8`, sha('cm_demo_' + slugOf(name)), Date.now(), now(), now());
        if (key === 'kickoff') run("UPDATE cameras SET view_mode='image' WHERE id=?", cid);
        return cid;
      });
    }
    const gateEvent = (key, bookingId, ref, direction, at, result = 'granted', reason = '') =>
      run('INSERT INTO access_events (id,venue_id,point_id,booking_id,ref,direction,result,reason,at) VALUES (?,?,?,?,?,?,?,?,?)', id(), venues[key].id, pick(gateIds[key]), bookingId, ref, direction, result, reason, at);
    for (const key of ['kickoff', 'smash']) {
      const past = all("SELECT * FROM bookings WHERE venue_id=? AND status='completed' AND date>=? AND date<? AND session_id IS NULL", venues[key].id, addDays(today.date, -7), today.date);
      for (const b of past) {
        const roll = rand();
        if (roll < 0.12) {                                           // no-show: nobody came through the gate
          run("INSERT INTO venue_alerts (id,venue_id,kind,severity,booking_id,message,created_at,resolved_at) VALUES (?,?,'no_show','info',?,?,?,?)", id(), venues[key].id, b.id, `Nobody arrived for booking ${b.ref} (${b.start_time}-${b.end_time}).`, b.start_at + 15 * 60000, b.start_at + 45 * 60000);
          continue;
        }
        const people = key === 'kickoff' ? 6 + Math.floor(rand() * 8) : 2 + Math.floor(rand() * 3);
        const early = Math.floor(rand() * 9) * 60000, late = rand() < 0.12 ? (6 + Math.floor(rand() * 12)) * 60000 : -Math.floor(rand() * 5) * 60000;
        for (let i = 0; i < people; i++) {
          gateEvent(key, b.id, b.ref, 'in', b.start_at - early + i * 7000);
          gateEvent(key, b.id, b.ref, 'out', b.end_at + late + i * 9000);
        }
        if (rand() < 0.1) gateEvent(key, null, 'TCXXXXXX', 'in', b.start_at - 120000, 'denied', 'unknown');
        if (late > 5 * 60000) run("INSERT INTO venue_alerts (id,venue_id,kind,severity,booking_id,message,created_at,resolved_at) VALUES (?,?,'overstay','warning',?,?,?,?)", id(), venues[key].id, b.id, `${Math.max(1, Math.round(people / 3))} people stayed ${Math.round(late / 60000)} min past the end of booking ${b.ref}.`, b.end_at + late, b.end_at + late + 600000);
      }
    }
    for (let d = 7; d >= 1; d--) {
      const day = addDays(today.date, -d);
      for (let h = 7; h <= 22; h++) {
        const at = zonedToEpoch(day, h * 60 + 5, TZ), busy = h >= 17 ? 1 : h < 9 ? 0.5 : 0.2;
        run("INSERT INTO camera_events (id,venue_id,camera_id,kind,people,at) VALUES (?,?,?,'people_count',?,?)", id(), venues.kickoff.id, camIds.kickoff[1], Math.round(rand() * 22 * busy * (weekday(day) % 6 === 0 ? 1.4 : 1)), at);
        run("INSERT INTO camera_events (id,venue_id,camera_id,kind,people,at) VALUES (?,?,?,'people_count',?,?)", id(), venues.smash.id, camIds.smash[0], Math.round(rand() * 8 * busy), at);
      }
      if (rand() < 0.5) run("INSERT INTO camera_events (id,venue_id,camera_id,kind,note,at) VALUES (?,?,?,'motion','After-hours motion near parking',?)", id(), venues.kickoff.id, camIds.kickoff[2], zonedToEpoch(day, 23 * 60 + 40, TZ));
    }
    // Live today: a game in progress with people inside, and a booking that has just run over time.
    const hourStart = Math.floor(today.minutes / 60) * 60;
    if (hourStart >= 7 * 60 && hourStart < 21 * 60) {
      const kk = venues.kickoff, startNow = toHHMM(hourStart), startPrev = toHHMM(hourStart - 60);
      const live = book({ v: kk, court: kk.courts[1], date: today.date, start: startNow, customer: players[3], status: 'confirmed' });
      run('UPDATE bookings SET inside_count=9, checked_in_at=? WHERE id=?', new Date().toISOString(), live.id);
      for (let i = 0; i < 9; i++) gateEvent('kickoff', live.id, live.ref, 'in', zonedToEpoch(today.date, hourStart, TZ) - 120000 + i * 8000);
      const over = book({ v: kk, court: kk.courts[2], date: today.date, start: startPrev, customer: players[4], status: 'confirmed' });
      run('UPDATE bookings SET inside_count=3, checked_in_at=? WHERE id=?', new Date(Date.now() - 3600000).toISOString(), over.id);
      for (let i = 0; i < 3; i++) gateEvent('kickoff', over.id, over.ref, 'in', zonedToEpoch(today.date, hourStart - 60, TZ) - 60000 + i * 8000);
      run("INSERT INTO camera_events (id,venue_id,camera_id,kind,people,at) VALUES (?,?,?,'people_count',?,?)", id(), kk.id, camIds.kickoff[1], 12, Date.now() - 30000);
      run("INSERT INTO camera_events (id,venue_id,camera_id,kind,note,at) VALUES (?,?,?,'unknown_person','Person near the back fence, not in any booking',?)", id(), kk.id, camIds.kickoff[0], Date.now() - 20 * 60000);
      run("INSERT INTO venue_alerts (id,venue_id,kind,severity,device_id,message,created_at) VALUES (?,?,'unknown_person','critical',?,?,?)", id(), kk.id, camIds.kickoff[0], 'Gate camera (Front entrance): unknown person detected. Person near the back fence, not in any booking', Date.now() - 20 * 60000);
    }

    // Blog posts and Q&A.
    const adminId = one("SELECT id FROM users WHERE role='admin'").id;
    const POSTS = [
      ['5 warm-up drills to prevent injuries before a turf game', 'tips', 'Ten minutes of the right movement before kick-off cuts the risk of the most common sports injuries.', 6,
        `Most turf injuries happen in the first fifteen minutes, when cold muscles meet sudden sprints. A short, structured warm-up fixes that.\n\n## The five drills\n\n- **Jog and mobilise (3 min):** easy laps of the pitch, adding leg swings and hip circles.\n- **Dynamic stretches (2 min):** walking lunges with a twist, high knees and butt kicks.\n- **Ankle and calf prep (1 min):** skipping and pogo hops. Artificial grass grips, so strong ankles matter.\n- **Short sprints (2 min):** three 20-metre build-ups at 60, 80 and 90 percent effort.\n- **Ball work (2 min):** passing in pairs at game pace so your eyes and feet sync up.\n\n## Common mistakes\n\nStatic stretching on cold muscles feels good but does little. Save long holds for after the game. And do not skip the warm-up because the slot is short: arrive ten minutes early, the entry gate opens fifteen minutes before your slot.\n\n## After the game\n\nWalk for five minutes, stretch your calves, quads and hamstrings for 30 seconds each, and drink water.`],
      ['Yoga for footballers: why flexibility wins matches', 'wellness', 'Hip and hamstring mobility keeps you faster, steadier and injury free. Three poses to start with.', 5,
        `Elite players spend a surprising amount of time on a yoga mat. It is not about touching your toes; it is about moving through your full range without pain.\n\n## Three poses to start with\n\n- **Low lunge:** opens the hip flexors that tighten from sprinting and sitting.\n- **Pigeon pose:** releases the deep hip rotators that protect your knees.\n- **Downward dog:** lengthens the hamstrings and calves together.\n\nHold each for a slow minute, breathing through the nose.\n\n## How often\n\nTwo twenty-minute sessions a week is enough to notice a difference within a month. Our wellness classes run in the morning and evening, in person and online, so you can fit them around training.`],
      ['How to choose the right turf for your team', 'venues', 'Surface, size, lighting and booking rules: a quick checklist before you reserve.', 4,
        `Not every pitch suits every game. Use this checklist before you book.\n\n## Surface\n\n- **Artificial grass:** forgiving on joints, plays well in all weather. Wear turf shoes, not metal studs.\n- **Synthetic indoor:** best in the monsoon, slightly faster ball speed.\n- **Clay or hard court:** for tennis and pickleball, check the maintenance schedule.\n\n## Size and format\n\nFive-a-side needs about 40 by 25 metres, seven-a-side roughly 60 by 40. Box cricket arenas are netted, so check the ball rules.\n\n## Lighting and timing\n\nFloodlit pitches let you play after work. Peak slots cost more, so try early mornings or weekday afternoons for the best price.`],
      ['Hydration on game day: how much is enough?', 'fitness', 'A simple plan for before, during and after a match in Indian summer heat.', 4,
        `Even mild dehydration slows you down and clouds decisions. In summer heat the effect is bigger.\n\n## A simple plan\n\n- **Two hours before:** drink 500 ml of water.\n- **During:** small sips every 15 minutes, about 150 to 250 ml.\n- **After:** replace what you lost, plus a pinch of salt or an electrolyte drink if you played more than an hour.\n\n## Signs to stop\n\nDizziness, headache, cramps or stopping sweating are signals to leave the pitch and rest in the shade.\n\nOur vending machines stock water and electrolyte drinks: pre-order in the app and collect with a code, no coins needed.`],
      ['Introducing wellness classes, snacks and smarter entry', 'news', 'What is new at Thidal: classes, pools, pre-order vending and QR entry.', 3,
        `We have added a few things players have been asking for.\n\n## What is new\n\n- **Swimming pools:** book lanes by the hour, just like a turf.\n- **Wellness classes:** yoga, meditation, fitness and aqua, in person or live online.\n- **Snacks and coffee:** pre-order from machines at your venue and collect with a code.\n- **QR entry:** scan your booking at the gate. Venues get alerts if a slot overruns or nobody turns up.\n\nTell us what to build next in the Q&A section.`],
      ['Draft: monsoon game-day guide', 'tips', 'Coming soon.', 0, 'Notes for the monsoon guide. Not published yet and long enough to save as a draft.'],
    ];
    for (const [i, [title, category, summary, daysAgo, body]] of POSTS.entries()) {
      const when = new Date(Date.now() - (daysAgo + i) * 86400000).toISOString(), draft = title.startsWith('Draft');
      run('INSERT INTO blog_posts (id,slug,title,summary,body,category,author_id,status,views,published_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        id(), title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70), title, summary, body, category, adminId, draft ? 'draft' : 'published', draft ? 0 : 40 + Math.floor(rand() * 400), draft ? null : when, when, when);
    }
    const ask = (userId, venueKey, title, body, daysAgo) => {
      const qid = id();
      run('INSERT INTO questions (id,user_id,venue_id,title,body,created_at) VALUES (?,?,?,?,?,?)', qid, userId, venueKey ? venues[venueKey].id : null, title, body, new Date(Date.now() - daysAgo * 86400000).toISOString());
      return qid;
    };
    const reply = (qid, userId, label, body, daysAgo) => run('INSERT INTO answers (id,question_id,user_id,author_label,body,created_at) VALUES (?,?,?,?,?,?)', id(), qid, userId, label, body, new Date(Date.now() - daysAgo * 86400000).toISOString());
    const q1 = ask(players[2], 'kickoff', 'Are metal studs allowed on the turf?', 'Our team usually wears studded boots. Is that fine at Kickoff Arena?', 6);
    reply(q1, owner, 'Kickoff Arena team', 'Turf shoes or flat soles only please. Metal studs damage the surface and are not allowed. Moulded rubber studs are fine.', 5);
    const q2 = ask(players[5], 'kickoff', 'Is there parking for 20 people on Saturday evenings?', '', 3);
    reply(q2, owner, 'Kickoff Arena team', 'Yes, we have around 40 two-wheeler and 15 car spots. It fills by 7 pm on Saturdays, so arrive a little early.', 2);
    ask(players[6], 'smash', 'Do you rent rackets and shuttles?', 'Visiting from out of town and would like to rent for two hours.', 1);
    const q4 = ask(players[3], 'aqua', 'Is the pool heated, and what is the water temperature?', '', 4);
    reply(q4, owner, 'Aqua Arena Pool team', 'The pool is heated and held at around 28°C all year. The shallow end is 1.0 m and the deep end 1.8 m.', 3);
    const q5 = ask(players[7], null, 'How do refunds work if it rains?', 'I booked an outdoor pitch and the forecast looks bad. Can I cancel for free?', 2);
    reply(q5, adminId, 'Thidal team', 'Cancellation follows each venue\'s policy shown on its page, for example a full refund up to 24 hours before the game. If the venue closes because of weather, you are refunded in full automatically.', 1);
    ask(players[8], null, 'Can I book a pool lane for my kids\' swim class?', 'Looking for a coach-led session for children aged 8 to 10.', 0);

    // Coaches with weekly availability, likes, ratings and comments.
    const COACHES = [
      ['kickoff', 'Sameer Khan', 'football', 'Former state-level midfielder. Small-group and one-to-one sessions on first touch, passing and match fitness for ages 8 to 40.', 12, 'English, Hindi, Kannada', 800, 60, 'game'],
      ['kickoff', 'Rajesh Iyer', 'cricket', 'Level-2 certified batting and bowling coach. Net sessions with video analysis of your technique.', 15, 'English, Tamil, Hindi', 900, 60, 'game'],
      ['kickoff', 'Anil Gopal', 'badminton', 'National-circuit player turned coach. Footwork, smash power and doubles tactics for juniors and adults.', 9, 'English, Kannada', 600, 60, 'game'],
      ['kickoff', 'Maria D\'Souza', 'tennis', 'Certified tennis coach who has trained academy juniors for a decade. Strokes, serve and match play.', 11, 'English, Konkani, Hindi', 1200, 60, 'game'],
      ['kickoff', 'Imran Qureshi', 'swimming', 'Lifesaver-certified swim coach. Stroke correction, breathing and confidence for beginners and triathletes.', 10, 'English, Hindi, Urdu', 700, 60, 'game'],
      ['kickoff', 'Rohit Menon', 'fitness', 'Strength and conditioning coach who works with players of every game: warm-ups, mobility and injury prevention. Common coach for all games, available whenever the turf is open.', 10, 'English, Hindi, Malayalam', 600, 60, 'all'],
      ['kickoff', 'Anjali Rao', 'yoga', 'Registered yoga teacher focused on mobility and recovery for athletes. Common coach for all games, available whenever the turf is open.', 8, 'English, Kannada, Telugu', 500, 60, 'all'],
      ['rally', 'Karan Shah', 'pickleball', 'Pickleball ambassador. Learn the rules, dinks and third-shot drops in one relaxed hour.', 4, 'English, Hindi, Gujarati', 700, 45, 'game'],
      ['aqua', 'Divya Nair', 'aqua', 'Aqua fitness instructor. Gentle, joint-friendly conditioning and rehab in the pool.', 6, 'English, Malayalam', 600, 45, 'game'],
    ];
    const COACH_COMMENTS = [
      [5, 'Spotted my mistake in the first ten minutes. My game improved in two weeks.'], [5, 'Patient, clear and encouraging. My son looks forward to every session.'], [5, 'Brilliant coach, very professional and always on time.'],
      [4, 'Great drills and feedback. Wish the slots were available on more weekdays.'], [5, 'Worth every rupee. Customised the session around my weak points.'], [4, 'Good session, a bit short on time. Would book again.'],
      [5, 'Made a complete beginner feel at ease. Highly recommend.'], [3, 'Knowledgeable, but the session started ten minutes late.'], [5, 'Fitness levels went up and so did my confidence.'], [4, 'Friendly and easy to understand. Clear takeaways to practise.'],
    ];
    const WEEK = [[1, 2, 3, 4, 5], [0, 6]];
    COACHES.forEach(([key, name, specialty, bio, years, languages, rupees, minutes, scope], i) => {
      const cid = id(), court = id();
      run("INSERT INTO courts (id,venue_id,name,sports,surface,indoor,base_price,active,sort) VALUES (?,?,?,?,'concrete',1,0,0,998)", court, venues[key].id, `Coach: ${name}`, '[]');
      run('INSERT INTO coaches (id,venue_id,court_id,name,specialty,scope,bio,experience_years,languages,price,session_minutes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', cid, venues[key].id, court, name, specialty, scope, bio, years, languages, rupees * 100, minutes, now(), now());
      const windows = scope === 'all' ? [] : specialty === 'yoga' || specialty === 'swimming' ? [['06:00', '09:00'], ['17:00', '20:00']] : i % 2 ? [['06:00', '09:00'], ['16:30', '20:30']] : [['07:00', '10:00'], ['17:00', '21:00']];
      for (const day of WEEK[0]) for (const [from, to] of windows) run('INSERT INTO coach_availability (id,coach_id,weekday,start_time,end_time) VALUES (?,?,?,?,?)', id(), cid, day, from, to);
      if (scope !== 'all') for (const day of WEEK[1]) run('INSERT INTO coach_availability (id,coach_id,weekday,start_time,end_time) VALUES (?,?,?,?,?)', id(), cid, day, '07:00', '12:00');
      const fans = players.slice().sort(() => rand() - 0.5).slice(0, 3 + Math.floor(rand() * 8));
      for (const p of fans) run('INSERT INTO coach_likes (coach_id,user_id,created_at) VALUES (?,?,?)', cid, p, now());
      const reviewers = players.slice(1).sort(() => rand() - 0.5).slice(0, 4 + Math.floor(rand() * 7));
      reviewers.forEach((p, n) => {
        const [rating, comment] = COACH_COMMENTS[(n + i) % COACH_COMMENTS.length];
        const reply = n === 0 && rating >= 4 ? 'Thank you! Looking forward to your next session.' : '';
        run('INSERT INTO coach_reviews (id,coach_id,customer_id,rating,comment,reply,created_at) VALUES (?,?,?,?,?,?,?)', id(), cid, p, rating, comment, reply, new Date(Date.now() - (n * 4 + 2) * 86400000).toISOString());
      });
    });

    // Photos and videos for the turf's games (sport NULL = shown for every game and in Learn).
    const MEDIA = [
      [null, 'image', '/img/venue-1.svg', 'The main pitch under floodlights'], [null, 'video', '/media/demo-football.webm', 'A quick tour of the pitches'],
      ['football', 'image', '/img/venue-2.svg', '5-a-side pitch, artificial grass'], ['football', 'video', '/media/demo-football.webm', 'Football drills with Coach Sameer'], ['football', 'image', '/img/venue-1.svg', '7-a-side pitch'],
      ['cricket', 'image', '/img/venue-4.svg', 'Netted box cricket arena'], ['cricket', 'image', '/img/venue-2.svg', 'Nets at dusk'],
      ['badminton', 'image', '/img/venue-3.svg', 'Wooden indoor courts with anti-glare lighting'],
      ['tennis', 'image', '/img/venue-6.svg', 'Hard court with night lighting'],
      ['swimming', 'image', '/img/venue-7.svg', 'Heated pool, two lap lanes'], ['swimming', 'video', '/media/demo-pool.webm', 'Lap swimming technique'],
    ];
    MEDIA.forEach(([sport, kind, url, caption], n) => run('INSERT INTO media (id,venue_id,sport,kind,url,caption,sort,created_at) VALUES (?,?,?,?,?,?,?,?)', id(), venues.kickoff.id, sport, kind, url, caption, n, now()));

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

    run("INSERT INTO notifications (id,user_id,channel,kind,title,body,link,status,send_after,sent_at,created_at) VALUES (?,?,'inapp','welcome','Welcome to Thidal','Use code WELCOME20 for 20% off your next booking.','#/profile','sent',?,?,?)", id(), player, Date.now(), now(), now());
    return `Seeded ${Object.keys(venues).length} venues, ${players.length} players and ${count} bookings.`;
  });
}
