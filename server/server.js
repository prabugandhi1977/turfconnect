import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { ROOT } from './db.js';
import { createRouter, json, parseBody, readBody, Reply } from './http.js';
import { authenticate } from './security.js';
import { HttpError } from './validate.js';
import { expireHolds, completeFinished } from './bookings.js';
import { deliverDue } from './notify.js';
import { setSelfBaseUrl } from './payments.js';
import authRoutes from './routes/auth.js';
import discoveryRoutes from './routes/discovery.js';
import bookingRoutes from './routes/bookings.js';
import ownerRoutes, { UPLOAD_DIR } from './routes/owner.js';
import supportRoutes from './routes/support.js';
import adminRoutes from './routes/admin.js';

const router = createRouter();
router.get('/health', () => ({ ok: true, time: new Date().toISOString() }), { auth: 'none' });
for (const register of [authRoutes, discoveryRoutes, bookingRoutes, ownerRoutes, supportRoutes, adminRoutes]) register(router);

const WEB = join(ROOT, 'web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(self), geolocation=(self), microphone=()',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

async function serveFile(res, base, rel, { fallback = null, cache = 'no-cache' } = {}) {
  const file = normalize(join(base, rel));
  if (!file.startsWith(base + sep) && file !== base) { res.writeHead(403); return res.end(); }
  try {
    const s = await stat(file); if (!s.isFile()) throw new Error('not a file');
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': cache });
    res.end(await readFile(file));
  } catch {
    if (fallback) return serveFile(res, base, fallback);
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (url.pathname.startsWith('/uploads/')) return serveFile(res, UPLOAD_DIR, decodeURIComponent(url.pathname.slice(9)), { cache: 'public, max-age=86400' });
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    return serveFile(res, WEB, rel, { fallback: extname(rel) ? null : 'index.html' });
  }
  const { route, params, pathExists } = router.match(req.method, url.pathname);
  if (!route) return json(res, pathExists ? 405 : 404, { error: pathExists ? 'Method not allowed' : 'Not found' });
  try {
    const u = route.auth === 'none' ? null : authenticate(req);
    if (route.auth === 'required' && !u) throw new HttpError(401, 'Please sign in to continue');
    if (route.roles && !route.roles.includes(u.role)) throw new HttpError(403, 'You do not have access to this');
    const raw = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req, route.limit) : '';
    const body = route.raw ? {} : parseBody(raw);
    let result = await route.handler({ u, body, raw, params, query: url.searchParams, req, res });
    if (res.headersSent) return;
    if (result instanceof HttpError) throw result;
    if (result instanceof Reply) return json(res, result.status, result.value);
    json(res, 200, result ?? { ok: true });
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof HttpError) return json(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
    console.error(`${req.method} ${url.pathname}`, e);
    json(res, 500, { error: 'Something went wrong on our side. Please try again.' });
  }
}

export function sweep() {
  try { expireHolds(); completeFinished(); deliverDue(); } catch (e) { console.error('Sweep failed:', e); }
}

export function start(port = config.port, host = '0.0.0.0') {
  const server = createServer(handle);
  return new Promise(resolve => server.listen(port, host, () => {
    const actual = server.address().port;
    setSelfBaseUrl(`http://127.0.0.1:${actual}`);
    const timer = setInterval(sweep, 5000); timer.unref();
    server.on('close', () => clearInterval(timer));
    sweep();
    resolve(server);
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await start();
  console.log(`TurfConnect running on http://localhost:${server.address().port} (payments: ${config.paymentProvider}${config.devOtp ? ', dev OTP on' : ''})`);
}
