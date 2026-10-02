// Entry access control and surveillance. Gate and camera devices report with their own key; venue staff see the live picture,
// manage devices, acknowledge alerts and read the analysis report.
import { id, now, one, run, transaction } from '../db.js';
import { config } from '../config.js';
import { rateLimit, requireVenue } from '../security.js';
import { accessOverview, accessReport, cameraAuth, cameraEvent, cameraHeartbeat, newDeviceKey, pointAuth, pointHeartbeat, scan, sweepAccess } from '../access.js';
import { audit } from '../audit.js';
import { created } from '../http.js';
import { bad, conflict, int, notFound, oneOf, str } from '../validate.js';

const POINT_KINDS = ['gate', 'door', 'court'], VIEW_MODES = ['image', 'page', 'link'];

export default function accessRoutes(r) {
  // ---- Devices (key in the x-device-key header) ----
  r.post('/device/access/:id/scan', ({ params, body, req }) => {
    rateLimit(`gate:${params.id}`, 240, 60 * 1000);
    return scan(pointAuth(params.id, req.headers['x-device-key']), body || {});
  }, { auth: 'none' });
  r.post('/device/access/:id/heartbeat', ({ params, req }) => pointHeartbeat(pointAuth(params.id, req.headers['x-device-key'])), { auth: 'none' });
  r.post('/device/camera/:id/event', ({ params, body, req }) => {
    rateLimit(`cam:${params.id}`, 240, 60 * 1000);
    return cameraEvent(cameraAuth(params.id, req.headers['x-device-key']), body || {});
  }, { auth: 'none' });
  r.post('/device/camera/:id/heartbeat', ({ params, req }) => cameraHeartbeat(cameraAuth(params.id, req.headers['x-device-key'])), { auth: 'none' });

  // ---- Venue staff ----
  r.get('/owner/venues/:vid/access', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'front_desk');
    sweepAccess({ force: true });
    return accessOverview(venue.id);
  });

  r.get('/owner/venues/:vid/access/report', ({ u, params, query }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    return accessReport(venue, int(query.get('days') || 7, 'Days', { min: 1, max: 90 }));
  });

  r.post('/owner/venues/:vid/access/points', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const pid = id(), { key, hash } = newDeviceKey('ax_'), ts = now();
    run('INSERT INTO access_points (id,venue_id,name,kind,location,key_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, venue.id,
      str(body.name, 'Name', { min: 2, max: 60 }), oneOf(body.kind || 'gate', 'Type', POINT_KINDS), str(body.location, 'Location', { max: 100, optional: true }), hash, ts, ts);
    audit(u.id, 'access.point_created', 'access_point', pid, { venueId: venue.id });
    return created({ id: pid, key });
  });
  r.patch('/owner/venues/:vid/access/points/:pid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const p = one('SELECT * FROM access_points WHERE id=? AND venue_id=?', params.pid, venue.id);
    if (!p) notFound('Gate not found');
    run('UPDATE access_points SET name=?, location=?, active=?, updated_at=? WHERE id=?', body.name === undefined ? p.name : str(body.name, 'Name', { min: 2, max: 60 }),
      body.location === undefined ? p.location : str(body.location, 'Location', { max: 100, optional: true }), body.active === undefined ? p.active : (body.active ? 1 : 0), now(), p.id);
    return { ok: true };
  });
  r.post('/owner/venues/:vid/access/points/:pid/key', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    if (!one('SELECT 1 FROM access_points WHERE id=? AND venue_id=?', params.pid, venue.id)) notFound('Gate not found');
    const { key, hash } = newDeviceKey('ax_');
    run('UPDATE access_points SET key_hash=?, updated_at=? WHERE id=?', hash, now(), params.pid);
    audit(u.id, 'access.key_rotated', 'access_point', params.pid, { venueId: venue.id });
    return { key };
  });

  r.post('/owner/venues/:vid/access/cameras', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const cid = id(), { key, hash } = newDeviceKey('cm_'), ts = now(), url = str(body.streamUrl, 'Stream link', { max: 300, optional: true });
    if (url && !/^https?:\/\/\S+$/i.test(url)) bad('The stream link must start with http:// or https://');
    run('INSERT INTO cameras (id,venue_id,name,location,stream_url,view_mode,source,key_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', cid, venue.id,
      str(body.name, 'Name', { min: 2, max: 60 }), str(body.location, 'Location', { max: 100, optional: true }), url, oneOf(body.viewMode || 'link', 'View mode', VIEW_MODES), oneOf(body.source || 'stream', 'Source', ['stream', 'webcam']), hash, ts, ts);
    audit(u.id, 'access.camera_created', 'camera', cid, { venueId: venue.id });
    return created({ id: cid, key });
  });
  r.patch('/owner/venues/:vid/access/cameras/:cid', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const c = one('SELECT * FROM cameras WHERE id=? AND venue_id=?', params.cid, venue.id);
    if (!c) notFound('Camera not found');
    const url = body.streamUrl === undefined ? c.stream_url : str(body.streamUrl, 'Stream link', { max: 300, optional: true });
    if (url && !/^https?:\/\/\S+$/i.test(url)) bad('The stream link must start with http:// or https://');
    run('UPDATE cameras SET name=?, location=?, stream_url=?, view_mode=?, active=?, updated_at=? WHERE id=?', body.name === undefined ? c.name : str(body.name, 'Name', { min: 2, max: 60 }),
      body.location === undefined ? c.location : str(body.location, 'Location', { max: 100, optional: true }), url, body.viewMode === undefined ? c.view_mode : oneOf(body.viewMode, 'View mode', VIEW_MODES), body.active === undefined ? c.active : (body.active ? 1 : 0), now(), c.id);
    return { ok: true };
  });
  r.post('/owner/venues/:vid/access/cameras/:cid/key', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    if (!one('SELECT 1 FROM cameras WHERE id=? AND venue_id=?', params.cid, venue.id)) notFound('Camera not found');
    const { key, hash } = newDeviceKey('cm_');
    run('UPDATE cameras SET key_hash=?, updated_at=? WHERE id=?', hash, now(), params.cid);
    audit(u.id, 'access.key_rotated', 'camera', params.cid, { venueId: venue.id });
    return { key };
  });

  // Deleting a camera also removes the events it reported. Past alerts stay in the history.
  r.delete('/owner/venues/:vid/access/cameras/:cid', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const c = one('SELECT * FROM cameras WHERE id=? AND venue_id=?', params.cid, venue.id);
    if (!c) notFound('Camera not found');
    transaction(() => { run('DELETE FROM camera_events WHERE camera_id=?', c.id); run('DELETE FROM cameras WHERE id=?', c.id); });
    audit(u.id, 'access.camera_deleted', 'camera', c.id, { venueId: venue.id, name: c.name });
    return { deleted: true };
  });
  // A gate with scan history cannot be deleted without rewriting the analysis, so turn it off instead.
  r.delete('/owner/venues/:vid/access/points/:pid', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    const p = one('SELECT * FROM access_points WHERE id=? AND venue_id=?', params.pid, venue.id);
    if (!p) notFound('Gate not found');
    if (one('SELECT 1 FROM access_events WHERE point_id=?', p.id)) conflict('This gate has scan history that the reports use, so it cannot be deleted. Turn it off instead.', 'has_history');
    run('DELETE FROM access_points WHERE id=?', p.id);
    audit(u.id, 'access.point_deleted', 'access_point', p.id, { venueId: venue.id, name: p.name });
    return { deleted: true };
  });

  r.post('/owner/venues/:vid/access/alerts/:aid/ack', ({ u, params }) => {
    const { venue } = requireVenue(u, params.vid, 'front_desk');
    const a = one('SELECT id FROM venue_alerts WHERE id=? AND venue_id=?', params.aid, venue.id);
    if (!a) notFound('Alert not found');
    run('UPDATE venue_alerts SET acked_at=?, acked_by=?, resolved_at=? WHERE id=?', Date.now(), u.id, Date.now(), a.id);
    return { ok: true };
  });

  // Demo only: try the gate and camera flows without hardware. Runs through exactly the same code as a real device.
  r.post('/owner/venues/:vid/access/simulate', ({ u, params, body }) => {
    const { venue } = requireVenue(u, params.vid, 'manager');
    if (!config.vendingSim) notFound();
    let out;
    if (body.type === 'scan') {
      const p = one('SELECT * FROM access_points WHERE id=? AND venue_id=? AND active=1', body.deviceId, venue.id);
      if (!p) notFound('Gate not found');
      out = scan(p, { credential: body.credential, direction: body.direction });
    } else if (body.type === 'camera') {
      const c = one('SELECT * FROM cameras WHERE id=? AND venue_id=? AND active=1', body.deviceId, venue.id);
      if (!c) notFound('Camera not found');
      out = cameraEvent(c, { kind: body.kind, people: body.people, note: body.note });
    } else bad('type must be "scan" or "camera"');
    sweepAccess({ force: true });
    return out;
  });
}
