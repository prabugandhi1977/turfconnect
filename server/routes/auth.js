import { config } from '../config.js';
import { all, id, now, one, run, transaction } from '../db.js';
import { hashOtp, newOtp, randomCode, rateLimit, safeEqual, tokenFor } from '../security.js';
import { bad, email as emailOf, phone as phoneOf, str, HttpError } from '../validate.js';
import { audit } from '../audit.js';

const OTP_TTL = 10 * 60 * 1000, OTP_ATTEMPTS = 5;

function parseIdentifier(value) {
  const v = String(value || '').trim();
  if (!v) bad('Enter your phone number or email');
  return v.includes('@') ? { kind: 'email', value: emailOf(v) } : { kind: 'phone', value: phoneOf(v) };
}

export function userView(u) {
  const owned = all("SELECT id, name, slug, status, 'owner' AS role FROM venues WHERE owner_id=? ORDER BY name", u.id);
  const staffed = all('SELECT v.id, v.name, v.slug, v.status, s.role FROM venue_staff s JOIN venues v ON v.id=s.venue_id WHERE s.user_id=? ORDER BY v.name', u.id);
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, referralCode: u.referral_code, venues: [...owned, ...staffed] };
}

export default function authRoutes(r) {
  r.post('/auth/otp/request', ({ body, req }) => {
    rateLimit(`otp-ip:${req.socket.remoteAddress}`, 20, 10 * 60 * 1000);
    const ident = parseIdentifier(body.identifier);
    rateLimit(`otp-id:${ident.value}`, 5, 10 * 60 * 1000);
    const code = newOtp();
    run('INSERT INTO otp_codes (id,identifier,code_hash,expires_at,created_at) VALUES (?,?,?,?,?)', id(), ident.value, hashOtp(ident.value, code), Date.now() + OTP_TTL, Date.now());
    // Delivery adapter: replace with SMS/WhatsApp/email providers in production.
    console.log(`[otp] ${ident.kind}=${ident.value} code=${config.devOtp ? code : '******'}`);
    return { sent: true, channel: ident.kind, identifier: ident.value, ...(config.devOtp ? { devCode: code } : {}) };
  }, { auth: 'none' });

  r.post('/auth/otp/verify', ({ body, req }) => {
    rateLimit(`otp-verify-ip:${req.socket.remoteAddress}`, 30, 10 * 60 * 1000);
    const ident = parseIdentifier(body.identifier);
    const code = str(body.code, 'Code', { min: 6, max: 6 });
    return transaction(() => {
      const otp = one('SELECT * FROM otp_codes WHERE identifier=? AND used=0 AND expires_at>? ORDER BY created_at DESC LIMIT 1', ident.value, Date.now());
      if (!otp) bad('That code has expired. Request a new one.', 'otp_expired');
      if (otp.attempts >= OTP_ATTEMPTS) bad('Too many wrong attempts. Request a new code.', 'otp_locked');
      if (!safeEqual(otp.code_hash, hashOtp(ident.value, code))) {
        run('UPDATE otp_codes SET attempts=attempts+1 WHERE id=?', otp.id);
        // Thrown errors roll the transaction back, so return the failure as a reply instead to keep the attempt count.
        return new HttpError(400, `Incorrect code. ${OTP_ATTEMPTS - otp.attempts - 1} attempts left.`, 'otp_wrong');
      }
      run('UPDATE otp_codes SET used=1 WHERE id=?', otp.id);
      let user = one(`SELECT * FROM users WHERE ${ident.kind}=?`, ident.value);
      let isNew = false;
      if (!user) {
        isNew = true;
        const referrer = body.referralCode ? one('SELECT id FROM users WHERE referral_code=?', String(body.referralCode).trim().toUpperCase()) : null;
        let referral; do { referral = randomCode(6); } while (one('SELECT 1 FROM users WHERE referral_code=?', referral));
        const uid = id();
        run(`INSERT INTO users (id,name,${ident.kind},role,referral_code,referred_by,created_at) VALUES (?,?,?,?,?,?,?)`,
          uid, str(body.name, 'Name', { max: 80, optional: true }), ident.value, 'customer', referral, referrer?.id || null, now());
        user = one('SELECT * FROM users WHERE id=?', uid);
        audit(uid, 'user.signup', 'user', uid, { via: ident.kind, referred: !!referrer });
      }
      if (!user.active) bad('This account is disabled. Contact support.');
      return { token: tokenFor(user), user: userView(user), isNew };
    });
  }, { auth: 'none' });

  r.get('/me', ({ u }) => userView(one('SELECT * FROM users WHERE id=?', u.id)));
  r.patch('/me', ({ u, body }) => {
    const name = str(body.name, 'Name', { min: 1, max: 80 });
    run('UPDATE users SET name=? WHERE id=?', name, u.id);
    run("UPDATE bookings SET customer_name=? WHERE customer_id=? AND status='held'", name, u.id);
    return userView(one('SELECT * FROM users WHERE id=?', u.id));
  });
  r.post('/auth/logout-all', ({ u }) => { run('UPDATE users SET session_version=session_version+1 WHERE id=?', u.id); audit(u.id, 'user.logout_all', 'user', u.id); return { ok: true }; });
  r.post('/me/stream-ticket', ({ u }) => ({ ticket: tokenFor(u, 2 * 60 * 1000, 'stream') }));

  r.get('/me/notifications', ({ u }) => all("SELECT id,kind,title,body,link,read_at,created_at FROM notifications WHERE user_id=? AND channel='inapp' AND status='sent' ORDER BY created_at DESC LIMIT 50", u.id));
  r.post('/me/notifications/read', ({ u }) => { run("UPDATE notifications SET read_at=? WHERE user_id=? AND channel='inapp' AND read_at IS NULL", now(), u.id); return { ok: true }; });
  r.get('/me/coupons', ({ u }) => all(`SELECT c.code, c.kind, c.value, c.max_discount, c.min_amount, c.valid_until, c.description, v.name AS venue FROM coupons c LEFT JOIN venues v ON v.id=c.venue_id
      WHERE c.active=1 AND (c.owner_user_id=? OR (c.owner_user_id IS NULL AND c.venue_id IS NULL)) AND (c.valid_until IS NULL OR c.valid_until>=?)
      AND (SELECT COUNT(*) FROM bookings b WHERE b.coupon_id=c.id AND b.customer_id=? AND b.status IN ('held','confirmed','completed')) < c.per_user_limit
      ORDER BY c.created_at DESC`, u.id, new Date().toISOString().slice(0, 10), u.id));
}
