import { id, now, run } from './db.js';

export function audit(actorId, action, entity, entityId = '', { venueId = null, ...details } = {}) {
  run('INSERT INTO audit_events (id,actor_id,venue_id,action,entity,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?,?)',
    id(), actorId || null, venueId, action, entity, entityId, JSON.stringify(details), now());
}
