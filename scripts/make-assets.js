// Generates the app icons (SVG + PNG, no dependencies) and the illustrated venue placeholder images in web/.
// Run: node scripts/make-assets.js
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'web');
mkdirSync(join(WEB, 'img'), { recursive: true });

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#0d7a3e"/><g fill="none" stroke="#fff" stroke-width="1.6"><path d="M6 10h20v12H6zM16 10v12"/><circle cx="16" cy="16" r="3"/><path d="M6 13.5h3v5H6M26 13.5h-3v5h3"/></g></svg>`;
writeFileSync(join(WEB, 'icon.svg'), ICON);

// Raster icon: rasterise the same pitch mark with simple geometry (maskable: content inside the 80% safe zone).
function png(size) {
  const px = new Uint8Array(size * size * 4), s = size / 32;
  const set = (x, y, [r, g, b]) => { if (x < 0 || y < 0 || x >= size || y >= size) return; const i = (y * size + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };
  const green = [13, 122, 62], white = [255, 255, 255];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, green);
  const line = (x0, y0, x1, y1) => { const w = Math.max(1, Math.round(1.6 * s * 0.8)); for (let t = 0; t <= 1; t += 1 / (size * 2)) { const x = Math.round((x0 + (x1 - x0) * t) * s * 0.8 + size * 0.1), y = Math.round((y0 + (y1 - y0) * t) * s * 0.8 + size * 0.1); for (let dx = -w / 2; dx < w / 2; dx++) for (let dy = -w / 2; dy < w / 2; dy++) set(Math.round(x + dx), Math.round(y + dy), white); } };
  [[6, 10, 26, 10], [26, 10, 26, 22], [26, 22, 6, 22], [6, 22, 6, 10], [16, 10, 16, 22], [6, 13.5, 9, 13.5], [9, 13.5, 9, 18.5], [9, 18.5, 6, 18.5], [26, 13.5, 23, 13.5], [23, 13.5, 23, 18.5], [23, 18.5, 26, 18.5]].forEach(l => line(...l));
  for (let a = 0; a < Math.PI * 2; a += 0.02) line(16 + 3 * Math.cos(a), 16 + 3 * Math.sin(a), 16 + 3 * Math.cos(a + 0.02), 16 + 3 * Math.sin(a + 0.02));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(join(WEB, 'icon-192.png'), png(192));
writeFileSync(join(WEB, 'icon-512.png'), png(512));

// Venue illustrations: aerial views of a pitch or court, 16:9.
const scene = (bg, surface, lines, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient>
<pattern id="s" width="80" height="360" patternUnits="userSpaceOnUse"><rect width="40" height="360" fill="${surface[0]}"/><rect x="40" width="40" height="360" fill="${surface[1]}"/></pattern></defs>
<rect width="640" height="360" fill="url(#g)"/><g transform="translate(320 190) scale(1 .62) rotate(0)"><rect x="-260" y="-200" width="520" height="400" rx="6" fill="url(#s)"/>
<g fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="4">${lines}</g></g>${extra}</svg>`;
const football = `<rect x="-240" y="-180" width="480" height="360"/><path d="M0-180V180"/><circle r="50"/><rect x="-240" y="-80" width="60" height="160"/><rect x="180" y="-80" width="60" height="160"/>`;
const lights = `<g fill="#fff8d6" opacity=".9"><circle cx="40" cy="40" r="10"/><circle cx="600" cy="40" r="10"/></g><g fill="#fff8d6" opacity=".15"><path d="M40 40 220 330H0z"/><path d="M600 40 640 330H420z"/></g>`;
const images = {
  'venue-1.svg': scene(['#0b2a1a', '#123d27'], ['#2f9a52', '#2a8c4a'], football, lights),
  'venue-2.svg': scene(['#1b3045', '#2a4b66'], ['#3aa35d', '#35965a'], football + '<path d="M-240 0H240" stroke-dasharray="12 12"/>'),
  'venue-3.svg': scene(['#2d2116', '#3e2f20'], ['#c8915a', '#be8752'], `<rect x="-200" y="-180" width="400" height="360"/><path d="M-200 0H200M0-180V180M-200-130H200M-200 130H200"/><path d="M-230 0H230" stroke="#eee" stroke-width="7"/>`),
  'venue-4.svg': scene(['#132431', '#1d3546'], ['#3b9e5c', '#35915a'], `<rect x="-240" y="-180" width="480" height="360" stroke-dasharray="14 10"/><rect x="-30" y="-120" width="60" height="240" fill="#d9c79a" stroke="none"/><path d="M-30-90H30M-30 90H30"/>`, lights),
  'venue-5.svg': scene(['#1c1c2e', '#2b2b45'], ['#2f6fb0', '#2b66a3'], football),
  'venue-6.svg': scene(['#2a1c14', '#3a271b'], ['#b5532d', '#aa4c29'], `<rect x="-220" y="-180" width="440" height="360"/><path d="M-160-180V180M160-180V180M-160-90H160M-160 90H160M0-90V90"/><path d="M-250 0H250" stroke-width="6"/>`),
};
for (const [name, svg] of Object.entries(images)) writeFileSync(join(WEB, 'img', name), svg);
console.log('Assets written to web/');
