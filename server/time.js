// Venue-local time helpers. Bookings are planned in the venue's wall-clock time and converted to epoch
// milliseconds once (start_at/end_at), so policies and reminders never re-derive time zones.
const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) formatters.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  return formatters.get(tz);
}
export function zonedParts(epochMs, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(epochMs)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
export function zonedToEpoch(date, minutes, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, 0, minutes);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz); const [py, pm, pd] = p.date.split('-').map(Number);
    const diff = target - Date.UTC(py, pm - 1, pd, 0, p.minutes);
    if (!diff) break; guess += diff;
  }
  return guess;
}
export const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const toHHMM = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const weekday = date => new Date(date + 'T00:00:00Z').getUTCDay();
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
export const venueToday = venue => zonedParts(Date.now(), venue.timezone).date;
