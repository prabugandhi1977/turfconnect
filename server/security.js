import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { one } from './db.js';
import { HttpError, forbidden, notFound } from './validate.js';

const sign = data => createHmac('sha256', config.secret).update(data).digest('base64url');
export const hmacHex = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');
export function safeEqual(a, b) { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }

// Stateless signed tokens carrying the user's session version: signing out everywhere bumps the version.
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;
export function tokenFor(user, ttl = TOKEN_TTL, purpose = 'session') {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, sv: user.session_version ?? 0, exp: Date.now() + ttl, p: purpose })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function verifyToken(token, purpose = 'session') {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (claims.exp < Date.now() || claims.p !== purpose) return null;
    const user = one('SELECT id,name,email,phone,role,referral_code,session_version FROM users WHERE id=? AND active=1', claims.sub);
    return user && claims.sv === user.session_version ? user : null;
  } catch { return null; }
}
export const authenticate = req => verifyToken((req.headers.authorization || '').replace(/^Bearer /, ''));

export const newOtp = () => String(randomInt(0, 1000000)).padStart(6, '0');
export const hashOtp = (identifier, code) => sign(`otp:${identifier}:${code}`);

const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const randomCode = (length) => Array.from({ length }, () => REF_ALPHABET[randomInt(0, REF_ALPHABET.length)]).join('');

// In-memory fixed-window rate limiting per key. Good enough for one instance; move to Redis when scaling out.
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const t = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < t) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  if (++b.count > limit) throw new HttpError(429, `Too many requests. Try again in ${Math.ceil((b.reset - t) / 1000)} seconds.`);
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

// Venue access. Staff levels nest: front desk < manager < owner < platform admin.
const LEVEL = { front_desk: 1, manager: 2, owner: 3, admin: 4 };
export function venueRole(u, venue) {
  if (!u) return null;
  if (u.role === 'admin') return 'admin';
  if (venue.owner_id === u.id) return 'owner';
  return one('SELECT role FROM venue_staff WHERE venue_id=? AND user_id=?', venue.id, u.id)?.role || null;
}
export function requireVenue(u, venueId, min = 'front_desk') {
  const venue = one('SELECT * FROM venues WHERE id=?', venueId);
  if (!venue) notFound('Venue not found');
  const role = venueRole(u, venue);
  if (!role) notFound('Venue not found');
  if (LEVEL[role] < LEVEL[min]) forbidden(`This needs ${min.replace('_', ' ')} access or higher`);
  return { venue, role };
}
export const canAtLeast = (role, min) => LEVEL[role] >= LEVEL[min];
