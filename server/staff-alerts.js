// Tells the people who run a venue (owner and managers) about something that needs attention.
import { all, one } from './db.js';
import { notify } from './notify.js';

export function alertStaff(venueId, title, body, link) {
  const venue = one('SELECT owner_id FROM venues WHERE id=?', venueId);
  const managers = all("SELECT user_id FROM venue_staff WHERE venue_id=? AND role='manager'", venueId).map(r => r.user_id);
  for (const uid of new Set([venue?.owner_id, ...managers].filter(Boolean))) notify(uid, { kind: 'venue_alert', title, body, link: link || `#/owner/${venueId}`, channels: ['inapp', 'email'] });
}
