-- Entry access control and surveillance. Gate/door devices scan booking QR codes and report who went in and out; cameras report
-- events and head counts. Both authenticate with their own API key. Alerts (overstay, no-show, denied bursts, head-count
-- mismatch, device offline) are raised by the periodic sweep or straight from a device event.
CREATE TABLE access_points (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('gate','door','court')),
  location TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL,
  last_seen_at INTEGER,
  alerted_offline INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX access_points_venue ON access_points(venue_id);

CREATE TABLE cameras (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  stream_url TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL,
  last_seen_at INTEGER,
  alerted_offline INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX cameras_venue ON cameras(venue_id);

CREATE TABLE access_events (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  point_id TEXT NOT NULL REFERENCES access_points(id),
  booking_id TEXT REFERENCES bookings(id),
  ref TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  result TEXT NOT NULL CHECK (result IN ('granted','denied')),
  reason TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX access_events_venue ON access_events(venue_id, at);
CREATE INDEX access_events_booking ON access_events(booking_id);

CREATE TABLE camera_events (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  camera_id TEXT NOT NULL REFERENCES cameras(id),
  kind TEXT NOT NULL CHECK (kind IN ('motion','people_count','unknown_person','tamper')),
  people INTEGER,
  note TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
CREATE INDEX camera_events_venue ON camera_events(venue_id, at);

CREATE TABLE venue_alerts (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  booking_id TEXT REFERENCES bookings(id),
  device_id TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  acked_by TEXT REFERENCES users(id),
  resolved_at INTEGER
);
CREATE INDEX venue_alerts_open ON venue_alerts(venue_id, resolved_at, created_at);

-- Live headcount per booking and one-shot flags for the slot-end warnings.
ALTER TABLE bookings ADD COLUMN inside_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN exit_warned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN overstay_alerted INTEGER NOT NULL DEFAULT 0;
