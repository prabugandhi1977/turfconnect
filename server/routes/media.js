// Photos and videos for the turf: shown on each game's page (sport set) and in Learn (all games = sport empty).
// The owner uploads images (up to 3 MB) and short videos (up to 25 MB), or adds a YouTube link.
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, id, now, one, run } from '../db.js';
import { requireVenue } from '../security.js';
import { UPLOAD_DIR } from './owner.js';
import { audit } from '../audit.js';
import { created } from '../http.js';
import { COACH_SPECIALTIES, SPORTS, bad, notFound, oneOf, str } from '../validate.js';

mkdirSync(UPLOAD_DIR, { recursive: true });
const IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/, VIDEO = /^data:video\/(mp4|webm);base64,([A-Za-z0-9+/=]+)$/;
const LIMITS = { image: 3 * 1024 * 1024, video: 25 * 1024 * 1024 }, MAX_ITEMS = 60;
const TOPICS = [...new Set([...SPORTS, ...COACH_SPECIALTIES])];

// Accepts watch, short and embed links; returns the 11-character video id or null.
export function youtubeId(url) {
  const m = /^https:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&#/].*)?$/.exec(String(url).trim());
  return m ? m[1] : null;
}
const view = m => ({ id: m.id, sport: m.sport, kind: m.kind, url: m.url, caption: m.caption, ...(m.kind === 'youtube' ? { youtubeId: m.url } : {}) });

export default function mediaRoutes(r) {
  // Public: everything for a venue, optionally one game (that game's media plus the ones shared by all games).
  r.get('/media', ({ query }) => {
    const venueId = query.get('venueId'), sport = query.get('sport');
    if (!venueId) bad('venueId is required');
    return all('SELECT * FROM media WHERE venue_id=? ORDER BY sort, created_at', venueId).filter(m => !sport || !m.sport || m.sport === sport).map(view);
  }, { auth: 'none' });

  r.get('/owner/venues/:vid/media', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    return all('SELECT * FROM media WHERE venue_id=? ORDER BY sort, created_at', venue.id).map(view);
  });

  r.post('/owner/venues/:vid/media', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    if (one('SELECT COUNT(*) AS n FROM media WHERE venue_id=?', venue.id).n >= MAX_ITEMS) bad(`A venue can have up to ${MAX_ITEMS} photos and videos`);
    const sport = body.sport ? oneOf(body.sport, 'Game', TOPICS) : null, caption = str(body.caption, 'Caption', { max: 140, optional: true }), mid = id();
    let kind, url;
    if (body.youtubeUrl) {
      const yt = youtubeId(body.youtubeUrl);
      if (!yt) bad('Paste a YouTube link (youtube.com/watch?v=... or youtu.be/...)');
      kind = 'youtube'; url = yt;
    } else {
      const data = String(body.dataUrl || ''), img = IMAGE.exec(data), vid = img ? null : VIDEO.exec(data);
      if (!img && !vid) bad('Upload a PNG, JPEG or WebP image, an MP4 or WebM video, or paste a YouTube link');
      kind = img ? 'image' : 'video';
      const buf = Buffer.from((img || vid)[2], 'base64');
      if (buf.length > LIMITS[kind]) bad(kind === 'image' ? 'Images must be 3 MB or smaller' : 'Videos must be 25 MB or smaller');
      const ext = (img || vid)[1] === 'jpeg' ? 'jpg' : (img || vid)[1], name = `${mid}.${ext}`;
      writeFileSync(join(UPLOAD_DIR, name), buf);
      url = `/uploads/${name}`;
    }
    run('INSERT INTO media (id,venue_id,sport,kind,url,caption,sort,created_at) VALUES (?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM media WHERE venue_id=?),?)', mid, venue.id, sport, kind, url, caption, venue.id, now());
    audit(u.id, 'media.added', 'media', mid, { venueId: venue.id, kind, sport });
    return created(view(one('SELECT * FROM media WHERE id=?', mid)));
  }, { limit: 36 * 1024 * 1024 });

  r.patch('/owner/venues/:vid/media/:mid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const m = one('SELECT * FROM media WHERE id=? AND venue_id=?', params.mid, venue.id);
    if (!m) notFound('Item not found');
    run('UPDATE media SET sport=?, caption=? WHERE id=?', body.sport === undefined ? m.sport : (body.sport ? oneOf(body.sport, 'Game', TOPICS) : null), body.caption === undefined ? m.caption : str(body.caption, 'Caption', { max: 140, optional: true }), m.id);
    return view(one('SELECT * FROM media WHERE id=?', m.id));
  });

  r.delete('/owner/venues/:vid/media/:mid', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const m = one('SELECT * FROM media WHERE id=? AND venue_id=?', params.mid, venue.id);
    if (!m) notFound('Item not found');
    run('DELETE FROM media WHERE id=?', m.id);
    if (m.url.startsWith('/uploads/')) { try { unlinkSync(join(UPLOAD_DIR, m.url.slice(9))); } catch { /* already gone */ } }
    audit(u.id, 'media.removed', 'media', m.id, { venueId: venue.id });
    return { deleted: true };
  });
}
