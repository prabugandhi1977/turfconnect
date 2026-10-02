// Built-in assistant for instant questions. No outside AI service: it recognises what the player is asking (sport, day, time of
// day, topic), answers from live data (availability, bookings, policies, classes, coaches, machines) and offers quick replies.
// When it cannot help it searches answered Q&A and the blog, then hands over to support.
import { all, one, parseJson } from './db.js';
import { venueDay, isBookable } from './availability.js';
import { publicVenue, primaryVenue } from './routes/discovery.js';
import { refundQuote, money } from './bookings.js';
import { coachSlots, coachStats, nextFreeSlot } from './coaches.js';
import { seatsTaken } from './bookings.js';
import { machineStatus } from './vending.js';
import { SPORTS, WELLNESS_KINDS } from './validate.js';
import { addDays, weekday, zonedParts } from './time.js';

const TZ = 'Asia/Kolkata';
const norm = t => ` ${String(t).toLowerCase().replace(/[^a-z0-9:\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
const has = (t, ...words) => words.some(w => t.includes(` ${w} `) || (w.endsWith('*') && t.includes(` ${w.slice(0, -1)}`)));
const SPORT_WORDS = { football: ['football', 'soccer'], cricket: ['cricket', 'nets'], badminton: ['badminton', 'shuttle'], tennis: ['tennis'], pickleball: ['pickleball'], basketball: ['basketball'], volleyball: ['volleyball'], futsal: ['futsal'], swimming: ['swim*', 'pool', 'lane'] };
const KIND_WORDS = { yoga: ['yoga'], meditation: ['meditat*', 'mindful*'], zumba: ['zumba', 'dance'], fitness: ['fitness', 'hiit', 'workout'], aqua: ['aqua'], pilates: ['pilates', 'stretch*'], breathwork: ['breathwork', 'breathing'] };
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const hhmm12 = s => { const [h, m] = s.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'am' : 'pm'}`; };
const pretty = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function findSport(t) { for (const [sport, words] of Object.entries(SPORT_WORDS)) if (has(t, ...words)) return sport; return null; }
function findKind(t) { for (const [kind, words] of Object.entries(KIND_WORDS)) if (has(t, ...words)) return kind; return null; }
function findDate(t, today) {
  if (has(t, 'day after tomorrow')) return { date: addDays(today, 2), word: 'day after tomorrow' };
  if (has(t, 'tomorrow', 'tmrw', 'tomorow')) return { date: addDays(today, 1), word: 'tomorrow' };
  if (has(t, 'today', 'tonight', 'now', 'right now')) return { date: today, word: 'today' };
  if (has(t, 'weekend')) { const wd = weekday(today); return { date: addDays(today, (6 - wd + 7) % 7 || 7), word: 'this weekend' }; }
  for (const [i, name] of DAYS.entries()) if (has(t, name, name.slice(0, 3))) { const diff = (i - weekday(today) + 7) % 7 || 7; return { date: addDays(today, diff), word: name }; }
  return null;
}
function findBand(t) {
  const clock = t.match(/ (?:at |around |by )?(\d{1,2})(?::(\d\d))? ?(am|pm) /) || t.match(/ at (\d{1,2})(?::(\d\d))? /);
  if (clock) { let h = Number(clock[1]); const ap = clock[3]; if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; if (!ap && h < 6) h += 12; return { from: h * 60, to: (h + 2) * 60, word: `around ${hhmm12(String(h).padStart(2, '0') + ':00')}` }; }
  if (has(t, 'morning')) return { from: 360, to: 720, word: 'in the morning' };
  if (has(t, 'afternoon')) return { from: 720, to: 960, word: 'in the afternoon' };
  if (has(t, 'evening')) return { from: 960, to: 1260, word: 'in the evening' };
  if (has(t, 'night', 'tonight')) return { from: 1140, to: 1440, word: 'tonight' };
  return null;
}
const mins = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

const ask = (...quick) => quick;
const reply = (text, extra = {}) => ({ reply: text, cards: [], quick: [], ...extra });

// ---- Intents ------------------------------------------------------------------------------------------------------
function availability(t, ctx) {
  const sport = findSport(t), d = findDate(t, ctx.today) || { date: ctx.today, word: 'today' }, band = findBand(t);
  const rows = [];
  for (const venue of [primaryVenue()].filter(Boolean)) {
    if (sport && !publicVenue(venue).sports.includes(sport)) continue;
    const prices = new Map();
    for (const c of venueDay(venue, d.date, { sport })) for (const s of c.slots) {
      if (!isBookable(s.state)) continue;
      if (band && !(mins(s.start) >= band.from && mins(s.start) < band.to)) continue;
      prices.set(s.start, Math.min(prices.get(s.start) ?? Infinity, s.price));
    }
    if (prices.size) rows.push({ venue, starts: [...prices.keys()].sort(), from: Math.min(...prices.values()) });
  }
  rows.sort((a, b) => b.starts.length - a.starts.length);
  const label = `${sport ? sport + ' ' : ''}slots ${d.word}${band ? ' ' + band.word : ''}`;
  if (!rows.length) return reply(`I could not find free ${label}. Try another time or day.`, { quick: ask('Tomorrow evening', 'This weekend', 'Talk to a person') });
  return reply(`Here is what is free for ${label}:`, {
    cards: rows.slice(0, 4).map(r => ({ title: r.venue.name, subtitle: `From ${money(r.from)} · ${r.starts.slice(0, 4).map(hhmm12).join(', ')}${r.starts.length > 4 ? ` +${r.starts.length - 4} more` : ''}`, href: sport ? `#/game/${sport}?date=${d.date}` : `#/?date=${d.date}` })),
    quick: ask('Cancellation policy', 'Find a coach', 'Snacks & coffee'),
  });
}

function priceAnswer(t, ctx) {
  const sport = findSport(t), rows = [primaryVenue()].filter(Boolean).map(publicVenue).filter(v => !sport || v.sports.includes(sport));
  if (!rows.length) return reply('I could not find venues for that sport.');
  return reply(`${sport ? sport[0].toUpperCase() + sport.slice(1) + ' prices' : 'Prices'} start at ${money(rows[0].minPrice)} per slot at ${rows[0].name}. Peak evenings and weekends cost more.`, {
    cards: rows.flatMap(v => (sport ? [sport] : v.sports).map(sp => ({ title: `${sp[0].toUpperCase() + sp.slice(1)} at ${v.name}`, subtitle: `From ${money(Math.min(...v.courts.filter(c => c.sports.includes(sp)).map(c => c.base_price)))} per slot`, href: `#/game/${sp}?date=${ctx.today}` }))).slice(0, 5), quick: ask('What is free tomorrow evening?', 'Promo codes') });
}

function myBookings(t, ctx) {
  if (!ctx.user) return reply('Sign in and I can show your bookings.', { cards: [{ title: 'Sign in', subtitle: 'One-time code, no password', href: '#/login?next=%23%2Fbookings' }] });
  const list = all("SELECT * FROM bookings WHERE customer_id=? AND status IN ('held','confirmed') AND end_at>=? ORDER BY start_at LIMIT 4", ctx.user.id, Date.now());
  if (!list.length) return reply('You have no upcoming bookings.', { cards: [{ title: 'Find a turf', subtitle: 'Book in under two minutes', href: '#/' }], quick: ask('What is free today?', 'Find a coach') });
  return reply(`You have ${list.length} upcoming ${list.length === 1 ? 'booking' : 'bookings'}:`, {
    cards: list.map(b => ({ title: `${one('SELECT name FROM venues WHERE id=?', b.venue_id).name}`, subtitle: `${pretty(b.date)} · ${hhmm12(b.start_time)} to ${hhmm12(b.end_time)} · ${b.status === 'held' ? 'awaiting payment' : 'confirmed'} · ${b.ref}`, href: `#/booking/${b.id}` })), quick: ask('How do I cancel?', 'How do I enter the venue?') });
}

function cancelHelp(t, ctx) {
  const lines = ['You can cancel from your booking page. The refund depends on how early you cancel, using the venue\'s policy shown on its page, for example a full refund up to 24 hours before.'];
  const cards = [];
  if (ctx.user) {
    for (const b of all("SELECT * FROM bookings WHERE customer_id=? AND status='confirmed' AND start_at>? ORDER BY start_at LIMIT 3", ctx.user.id, Date.now())) {
      const q = refundQuote(b);
      cards.push({ title: `${pretty(b.date)} · ${hhmm12(b.start_time)} · ${b.ref}`, subtitle: q.percent ? `Cancel now: ${q.percent}% refund (${money(q.amount)})` : 'Cancelling now is not refundable', href: `#/booking/${b.id}` });
    }
  }
  return reply(lines[0] + (cards.length ? ' Here is what you would get for yours right now:' : ''), { cards, quick: ask('Refund status', 'Payment failed', 'Talk to a person') });
}

function refundHelp(t, ctx) {
  const text = 'Refunds go back to your original payment method, usually in 5 to 7 working days. If a payment fails you are not charged and the slot is released. If your payment lands after the slot was taken, it is refunded in full automatically.';
  const cards = ctx.user ? all(`SELECT r.amount, r.status, b.ref, b.id FROM refunds r JOIN bookings b ON b.id=r.booking_id WHERE b.customer_id=? ORDER BY r.created_at DESC LIMIT 3`, ctx.user.id)
    .map(r => ({ title: `${money(r.amount)} · ${r.status === 'processed' ? 'refunded' : r.status}`, subtitle: `Booking ${r.ref}`, href: `#/booking/${r.id}` })) : [];
  return reply(text + (cards.length ? ' Your latest refunds:' : ''), { cards, quick: ask('Talk to a person', 'How do I cancel?') });
}

function classes(t, ctx) {
  const kind = findKind(t), d = findDate(t, ctx.today), online = has(t, 'online', 'live', 'remote', 'zoom'), inPerson = has(t, 'in person', 'studio');
  const rows = all("SELECT s.* FROM wellness_sessions s JOIN venues v ON v.id=s.venue_id WHERE s.status='scheduled' AND v.status='active' AND v.id=? AND s.start_at>? ORDER BY s.start_at LIMIT 100", primaryVenue()?.id, Date.now())
    .filter(s => (!kind || s.kind === kind) && (!d || s.date === d.date) && (!online || s.mode === 'online') && (!inPerson || s.mode === 'in_person')).slice(0, 4);
  if (!rows.length) return reply('I could not find a matching class. Try a different day or type.', { cards: [{ title: 'Browse wellness classes', subtitle: 'In person and live online', href: '#/wellness' }] });
  return reply(`Upcoming ${kind ? kind + ' ' : ''}classes${d ? ' ' + d.word : ''}:`, { cards: rows.map(s => ({ title: s.title, subtitle: `${pretty(s.date)} · ${hhmm12(s.start_time)} · ${s.mode === 'online' ? 'Online' : one('SELECT name FROM venues WHERE id=?', s.venue_id).name} · ${money(s.price)} · ${Math.max(0, s.capacity - seatsTaken(s.id))} seats`, href: `#/session/${s.id}` })), quick: ask('Online classes', 'Find a coach') });
}

function coaches(t, ctx) {
  const sport = findSport(t) || findKind(t);
  const rows = all("SELECT c.* FROM coaches c JOIN venues v ON v.id=c.venue_id WHERE c.active=1 AND v.status='active' AND v.id=?", primaryVenue()?.id).filter(c => !sport || c.specialty === sport || c.scope === 'all')
    .map(c => ({ c, ...coachStats(c.id), next: nextFreeSlot(c) })).sort((a, b) => (b.c.specialty === sport) - (a.c.specialty === sport) || (b.rating || 0) - (a.rating || 0)).slice(0, 4);
  if (!rows.length) return reply('There are no coaches listed for that yet.', { cards: [{ title: 'See all coaches', subtitle: 'Profiles, ratings and slots', href: '#/coaches' }] });
  return reply(`${sport ? sport[0].toUpperCase() + sport.slice(1) + ' coaches' : 'Top coaches'}:`, { cards: rows.map(r => ({ title: `${r.c.name} · ${r.c.specialty}`, subtitle: `${r.rating ? '★ ' + r.rating : 'New'} (${r.reviews}) · ${money(r.c.price)} per ${r.c.session_minutes} min${r.next ? ' · next ' + pretty(r.next.date) + ' ' + hhmm12(r.next.start) : ''}`, href: `#/coach/${r.c.id}` })), quick: ask('Cricket coach', 'Swimming coach', 'Yoga classes') });
}

function machines(t, ctx) {
  if (ctx.user && has(t, 'pickup', 'code', 'my order', 'collect')) {
    const open = all("SELECT * FROM vending_orders WHERE customer_id=? AND status='paid' ORDER BY created_at DESC LIMIT 3", ctx.user.id);
    if (open.length) return reply('Your orders ready to collect:', { cards: open.map(o => ({ title: `Code ${o.pickup_code}`, subtitle: `${parseJson(o.items, []).map(i => `${i.qty}× ${i.name}`).join(', ')} · ${one('SELECT name FROM vending_machines WHERE id=?', o.machine_id).name}`, href: `#/order/${o.id}` })) });
    return reply('You have no paid orders waiting. Order from a machine and pay in the app to get a code.', { cards: [{ title: 'Snacks & coffee machines', subtitle: 'Order ahead, collect with a code', href: '#/vending' }] });
  }
  const list = all("SELECT m.* FROM vending_machines m JOIN venues v ON v.id=m.venue_id WHERE m.active=1 AND v.status='active' AND v.id=? ORDER BY m.name", primaryVenue()?.id).map(m => ({ m, status: machineStatus(m), venue: one('SELECT name FROM venues WHERE id=?', m.venue_id).name }));
  const word = has(t, 'coffee', 'chai', 'tea') ? 'coffee' : null, pool = word ? list.filter(x => x.m.kind !== 'snacks') : list;
  const working = pool.filter(x => x.status === 'online').length;
  return reply(`${working} of ${pool.length} ${word ? 'coffee ' : ''}machines are working right now.`, { cards: pool.slice(0, 5).map(x => ({ title: `${x.m.name} · ${x.venue}`, subtitle: x.status === 'online' ? 'Working: order ahead and collect with a code' : x.status === 'fault' ? 'Out of order' : 'Offline', href: `#/vending/${x.m.id}` })), quick: ask('My pickup code', 'Find a turf') });
}

const FAQ = [
  [['enter', 'entry', 'gate', 'qr', 'check in', 'checkin', 'arrive', 'ticket'], 'Open your booking and show the QR code at the gate or front desk. Entry opens 15 minutes before your slot and closes when it ends. Please make sure everyone exits on time: you get a reminder 10 minutes before the end.'],
  [['reschedule', 'change time', 'move my', 'postpone'], 'Bookings cannot be moved yet. Cancel it (refund follows the venue policy) and book a new slot. Cancelling early gets the best refund.'],
  [['rain', 'weather', 'monsoon'], 'If a venue closes because of weather you are refunded in full automatically. Otherwise the normal cancellation policy applies, so check your booking page. Indoor venues like Goal Street Futsal are weatherproof.'],
  [['coupon', 'promo', 'discount', 'offer', 'code'], 'Try WELCOME20 for 20% off your first booking, and KICKOFF100 for 100 rupees off at Kickoff Arena. Invite friends and you both earn rewards. Enter the code at checkout.'],
  [['otp', 'login', 'log in', 'sign in', 'password', 'account'], 'There is no password. Enter your mobile number or email and we send a one-time code. If it does not arrive, wait a minute and try again.'],
  [['payment', 'paid', 'charged', 'deducted', 'upi', 'card'], 'Your slot is held while you pay (a few minutes). If payment fails you are not charged and the slot is released. If money was deducted but the booking did not confirm, it is refunded automatically. Tell me your booking reference if you still need help.'],
  [['parking', 'washroom', 'toilet', 'changing', 'shower', 'floodlight', 'amenit*', 'facilit*'], 'Each venue page lists its amenities, rules and cancellation policy. Tell me the venue name and I will check.'],
  [['rule', 'shoes', 'studs', 'bring', 'wear'], 'Rules differ by venue and are on each venue page. As a guide: turf shoes or flat soles on artificial grass, non-marking shoes indoors, swim caps in the pool.'],
];
function faq(t) { for (const [words, answer] of FAQ) if (has(t, ...words)) return reply(answer, { quick: ask('How do I cancel?', 'Talk to a person') }); return null; }

function venueInfo(t) {
  const venue = primaryVenue();
  if (!venue || !(has(t, 'parking', 'washroom', 'amenit*', 'facilit*', 'timing*', 'hours', 'open', 'address', 'location', 'where') || t.includes(venue.name.toLowerCase()))) return null;
  const v = publicVenue(venue);
  return reply(`${v.name}: ${v.description} It is open ${hhmm12(v.openTime)} to ${hhmm12(v.closeTime)} at ${v.address}, ${v.city}. Amenities: ${v.amenities.map(a => a.replace('_', ' ')).join(', ') || 'none listed'}.`, { cards: [{ title: `Open ${v.name}`, subtitle: 'Games, slots, photos and reviews', href: '#/' }], quick: ask('What is free today?') });
}

function search(text) {
  const words = norm(text).split(' ').filter(w => w.length > 3);
  if (!words.length) return [];
  const score = s => words.filter(w => s.toLowerCase().includes(w)).length;
  const qa = all('SELECT q.id, q.title FROM questions q WHERE q.hidden=0 AND EXISTS (SELECT 1 FROM answers a WHERE a.question_id=q.id AND a.hidden=0)').map(q => ({ title: q.title, subtitle: 'Answered question', href: `#/questions/${q.id}`, s: score(q.title) }));
  const posts = all("SELECT slug, title FROM blog_posts WHERE status='published'").map(p => ({ title: p.title, subtitle: 'Article', href: `#/blog/${p.slug}`, s: score(p.title) }));
  return [...qa, ...posts].filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3).map(({ s, ...c }) => c);
}

const MENU = ['Find a turf', 'My next booking', 'Find a coach', 'Snacks & coffee', 'Yoga classes', 'Talk to a person'];

export function respond(text, user) {
  const raw = String(text || '').trim().slice(0, 300), t = norm(raw), ctx = { user, today: zonedParts(Date.now(), TZ).date };
  if (!raw) return reply('Ask me anything about bookings, slots, classes, coaches or snacks.', { quick: MENU });
  if (has(t, 'human', 'person', 'agent', 'someone', 'support', 'complaint', 'complain', 'call me', 'representative')) return reply('I will connect you with our team. You can write to them and they will reply here in the app.', { cards: [{ title: 'Contact support', subtitle: 'Usually replies within a few hours', href: '#/support/new' }], handoff: true });
  if (has(t, 'hi', 'hello', 'hey', 'hii', 'namaste', 'help', 'menu', 'start', 'what can you do') && t.trim().split(' ').length <= 3) return reply('Hi! I can check slots, show your bookings, explain refunds, find coaches and classes, and see if a machine is working. What do you need?', { quick: MENU });
  if (has(t, 'thanks', 'thank you', 'thx', 'ok thanks')) return reply('Happy to help! Anything else?', { quick: MENU });
  if (has(t, 'cancel*') && !has(t, 'policy')) return cancelHelp(t, ctx);
  if (has(t, 'policy') && has(t, 'cancel*', 'refund*')) return cancelHelp(t, ctx);
  if (has(t, 'refund*', 'money back', 'refund status')) return refundHelp(t, ctx);
  if (has(t, 'my booking', 'my bookings', 'next booking', 'my game', 'upcoming', 'my next') || (has(t, 'booking', 'bookings') && has(t, 'my', 'show', 'upcoming', 'next'))) return myBookings(t, ctx);
  if (has(t, 'coach*', 'trainer', 'lesson*', 'coaching', 'tutor')) return coaches(t, ctx);
  if (has(t, 'pickup', 'my order', 'collect') || has(t, 'coffee', 'chai', 'snack*', 'vending', 'machine*', 'cappuccino', 'latte', 'chips', 'biscuit*')) return machines(t, ctx);
  if (findKind(t) || has(t, 'class', 'classes', 'wellness', 'session', 'sessions')) return classes(t, ctx);
  if (has(t, 'price', 'prices', 'cost', 'how much', 'cheap*', 'rate', 'rates', 'fee', 'fees', 'charges')) return priceAnswer(t, ctx);
  if (has(t, 'free', 'available', 'availability', 'slot*', 'book', 'booking', 'play', 'court*', 'turf*', 'pitch*', 'find') || findSport(t) || findDate(t, ctx.today)) {
    const v = venueInfo(t); if (v && !findDate(t, ctx.today)) return v;
    return availability(t, ctx);
  }
  return faq(t) || venueInfo(t) || (() => {
    const found = search(raw);
    return found.length ? reply('I am not sure, but these may help:', { cards: found, quick: ask('Talk to a person', 'Find a turf') })
      : reply('Sorry, I did not catch that. I can help with slots, bookings, refunds, coaches, classes and machines. Or I can connect you with our team.', { quick: MENU });
  })();
}
