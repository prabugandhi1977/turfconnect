// Offline support: the app shell is cached on install; venue pages, images and the player's bookings are cached as
// they are viewed (network first, cache as fallback) so tickets still open with no signal at the venue.
const VERSION = 'tc-v25';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/lib.js', '/qr.js', '/views/customer.js', '/views/wellness.js', '/views/vending.js', '/views/community.js', '/views/coaches.js', '/views/turf.js', '/views/gallery.js', '/chat.js', '/views/owner.js', '/views/admin.js', '/views/support.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

const CACHEABLE_API = [/^\/api\/venues\/[^/]+$/, /^\/api\/meta$/];
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname === '/api/stream') return;
  // Personal API data is never stored by the service worker (the page keeps its own per-user copy of tickets).
  if (url.pathname.startsWith('/api/') && !CACHEABLE_API.some(re => re.test(url.pathname))) return;
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(async () => (await caches.match(e.request)) || (e.request.mode === 'navigate' ? caches.match('/index.html') : Response.error())));
});
