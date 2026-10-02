-- Wellness sessions (yoga, meditation, fitness, aqua): scheduled classes with a seat limit, held in person at a venue
-- or online with a join link. A seat is an ordinary booking row (so payments, refunds, tickets and check-in all work);
-- bookings.session_id marks it, and capacity is enforced by counting live bookings inside a transaction.
CREATE TABLE wellness_sessions (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('in_person','online')),
  description TEXT NOT NULL DEFAULT '',
  trainer TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  price INTEGER NOT NULL CHECK (price >= 0),
  join_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX wellness_sessions_date ON wellness_sessions(date, status);
CREATE INDEX wellness_sessions_venue ON wellness_sessions(venue_id, date);

ALTER TABLE bookings ADD COLUMN session_id TEXT REFERENCES wellness_sessions(id);
CREATE INDEX bookings_session ON bookings(session_id, status);
