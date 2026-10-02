export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const bad = (message, code) => { throw new HttpError(400, message, code); };
export const forbidden = (message = 'You do not have access to this') => { throw new HttpError(403, message); };
export const notFound = (message = 'Not found') => { throw new HttpError(404, message); };
export const conflict = (message, code) => { throw new HttpError(409, message, code); };

export function str(value, name, { min = 0, max = 500, optional = false } = {}) {
  if (value === undefined || value === null || value === '') { if (optional) return ''; if (min > 0) bad(`${name} is required`); return ''; }
  if (typeof value !== 'string') bad(`${name} must be text`);
  const v = value.trim();
  if (v.length < min) bad(`${name} is required`);
  if (v.length > max) bad(`${name} is too long (max ${max} characters)`);
  return v;
}
export function int(value, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n)) bad(`${name} must be a whole number`);
  if (n < min || n > max) bad(`${name} must be between ${min} and ${max}`);
  return n;
}
export function num(value, name, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) bad(`${name} must be a number between ${min} and ${max}`);
  return n;
}
export function oneOf(value, name, options, { optional = false } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null;
  if (!options.includes(value)) bad(`${name} must be one of: ${options.join(', ')}`);
  return value;
}
export const bool = value => value === true || value === 1 || value === '1' || value === 'true';
export function date(value, name = 'Date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) bad(`${name} must be YYYY-MM-DD`);
  return value;
}
export function time(value, name = 'Time', { allow24 = false } = {}) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) bad(`${name} must be HH:MM`);
  const [h, m] = value.split(':').map(Number);
  if (m > 59 || h > 24 || (h === 24 && (m || !allow24))) bad(`${name} must be a valid time`);
  return value;
}
export function weekdays(value, name = 'Days') {
  const v = String(value ?? '');
  if (!/^[0-6]{1,7}$/.test(v) || new Set(v).size !== v.length) bad(`${name} must list weekdays 0 (Sun) to 6 (Sat)`);
  return [...v].sort().join('');
}
export const SPORTS = ['football', 'cricket', 'badminton', 'tennis', 'pickleball', 'basketball', 'volleyball', 'futsal'];
export const SURFACES = ['artificial_grass', 'natural_grass', 'synthetic', 'wooden', 'hard_court', 'clay', 'concrete'];
export const AMENITIES = ['parking', 'washroom', 'changing_room', 'drinking_water', 'first_aid', 'cafeteria', 'seating', 'equipment_rental', 'showers', 'wifi', 'cctv', 'floodlights'];
export function sportList(value) {
  if (!Array.isArray(value) || !value.length) bad('Pick at least one sport');
  for (const s of value) oneOf(s, 'Sport', SPORTS);
  return [...new Set(value)];
}
export function amenityList(value) {
  if (!Array.isArray(value)) return [];
  for (const a of value) oneOf(a, 'Amenity', AMENITIES);
  return [...new Set(value)];
}
export function email(value, { optional = false } = {}) {
  const v = str(value, 'Email', { max: 254, optional }).toLowerCase();
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) bad('Enter a valid email address');
  return v;
}
// Phone numbers are stored in E.164-like form. A bare 10-digit number is treated as Indian (+91).
export function phone(value, { optional = false } = {}) {
  const raw = str(value, 'Phone', { max: 20, optional });
  if (!raw) return '';
  let digits = raw.replace(/[\s()-]/g, '');
  if (/^\d{10}$/.test(digits)) digits = '+91' + digits;
  if (!/^\+\d{8,15}$/.test(digits)) bad('Enter a valid phone number, such as +91 98765 43210');
  return digits;
}
