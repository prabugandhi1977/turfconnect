-- Coaches: bookable one-to-one sessions. A coach belongs to a venue, publishes weekly availability, and each session is an
-- ordinary booking row (so payments, refunds, tickets and check-in work). Each coach owns a hidden court so the slot_claims
-- guard also prevents double-booking a coach. Players can like coaches and, after a completed session, rate and comment.
CREATE TABLE coaches (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  court_id TEXT NOT NULL REFERENCES courts(id),
  name TEXT NOT NULL,
  specialty TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  experience_years INTEGER NOT NULL DEFAULT 0,
  languages TEXT NOT NULL DEFAULT 'English',
  price INTEGER NOT NULL CHECK (price >= 0),
  session_minutes INTEGER NOT NULL DEFAULT 60 CHECK (session_minutes BETWEEN 15 AND 240),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX coaches_venue ON coaches(venue_id, active);

CREATE TABLE coach_availability (
  id TEXT PRIMARY KEY,
  coach_id TEXT NOT NULL REFERENCES coaches(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);
CREATE INDEX coach_availability_coach ON coach_availability(coach_id, weekday);

CREATE TABLE coach_likes (
  coach_id TEXT NOT NULL REFERENCES coaches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (coach_id, user_id)
);

CREATE TABLE coach_reviews (
  id TEXT PRIMARY KEY,
  coach_id TEXT NOT NULL REFERENCES coaches(id),
  booking_id TEXT UNIQUE REFERENCES bookings(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  reply TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX coach_reviews_coach ON coach_reviews(coach_id, hidden);

ALTER TABLE bookings ADD COLUMN coach_id TEXT REFERENCES coaches(id);
