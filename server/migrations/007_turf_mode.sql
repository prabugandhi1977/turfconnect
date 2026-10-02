-- One-turf mode: photos and videos per game, coaches who cover one game or all games (bookable as an add-on to a slot),
-- and a viewing mode per camera for the surveillance wall.
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  sport TEXT,                                   -- NULL means "all games"
  kind TEXT NOT NULL CHECK (kind IN ('image','video','youtube')),
  url TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX media_venue ON media(venue_id, sport, sort);

ALTER TABLE coaches ADD COLUMN scope TEXT NOT NULL DEFAULT 'game' CHECK (scope IN ('game','all'));

ALTER TABLE bookings ADD COLUMN addon_coach_id TEXT REFERENCES coaches(id);
ALTER TABLE bookings ADD COLUMN coach_fee INTEGER NOT NULL DEFAULT 0;

ALTER TABLE cameras ADD COLUMN view_mode TEXT NOT NULL DEFAULT 'link' CHECK (view_mode IN ('image','page','link'));
