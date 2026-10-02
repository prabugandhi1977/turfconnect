-- TurfConnect core schema. Money is stored in minor units (paise); dates are venue-local 'YYYY-MM-DD',
-- times venue-local 'HH:MM'; *_at INTEGER columns are epoch milliseconds, *_at TEXT columns are ISO timestamps.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','owner','admin')),
  referral_code TEXT NOT NULL UNIQUE,
  referred_by TEXT REFERENCES users(id),
  session_version INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE otp_codes (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX otp_identifier ON otp_codes(identifier, created_at);

CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','rejected')),
  status_note TEXT NOT NULL DEFAULT '',
  open_time TEXT NOT NULL DEFAULT '06:00',
  close_time TEXT NOT NULL DEFAULT '23:00',
  slot_minutes INTEGER NOT NULL DEFAULT 60,
  hold_minutes INTEGER NOT NULL DEFAULT 10,
  booking_window_days INTEGER NOT NULL DEFAULT 30,
  cancel_full_hours INTEGER NOT NULL DEFAULT 24,
  cancel_partial_hours INTEGER NOT NULL DEFAULT 6,
  cancel_partial_percent INTEGER NOT NULL DEFAULT 50,
  amenities TEXT NOT NULL DEFAULT '[]',
  rules TEXT NOT NULL DEFAULT '',
  indoor INTEGER NOT NULL DEFAULT 0,
  lighting INTEGER NOT NULL DEFAULT 1,
  surface TEXT NOT NULL DEFAULT 'artificial_grass',
  photos TEXT NOT NULL DEFAULT '[]',
  video_url TEXT NOT NULL DEFAULT '',
  business_name TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',
  payout_holder TEXT NOT NULL DEFAULT '',
  payout_bank TEXT NOT NULL DEFAULT '',
  payout_last4 TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX venues_status ON venues(status);

CREATE TABLE venue_staff (
  venue_id TEXT NOT NULL REFERENCES venues(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('manager','front_desk')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (venue_id, user_id)
);

CREATE TABLE courts (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  sports TEXT NOT NULL DEFAULT '[]',
  surface TEXT NOT NULL DEFAULT 'artificial_grass',
  indoor INTEGER NOT NULL DEFAULT 0,
  base_price INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX courts_venue ON courts(venue_id);

-- Day/time pricing. weekdays holds the digits 0 (Sunday) to 6 (Saturday). A court-specific rule beats a venue-wide one.
CREATE TABLE price_rules (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  court_id TEXT REFERENCES courts(id),
  label TEXT NOT NULL DEFAULT '',
  weekdays TEXT NOT NULL DEFAULT '0123456',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  price INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- Weekly closures such as maintenance windows or academy sessions.
CREATE TABLE recurring_blocks (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  court_id TEXT REFERENCES courts(id),
  weekdays TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- One-off changes to a single slot: block it, re-open it over a recurring block, or set a price.
CREATE TABLE slot_overrides (
  court_id TEXT NOT NULL REFERENCES courts(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  state TEXT CHECK (state IN ('blocked','open')),
  price INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (court_id, date, start_time)
);

CREATE TABLE coupons (
  id TEXT PRIMARY KEY,
  venue_id TEXT REFERENCES venues(id),
  owner_user_id TEXT REFERENCES users(id),
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('percent','flat')),
  value INTEGER NOT NULL,
  max_discount INTEGER,
  min_amount INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  valid_until TEXT,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  court_id TEXT NOT NULL REFERENCES courts(id),
  customer_id TEXT REFERENCES users(id),
  customer_name TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  sport TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  slots TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held','confirmed','completed','cancelled','expired','failed')),
  source TEXT NOT NULL DEFAULT 'online' CHECK (source IN ('online','manual')),
  subtotal INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  coupon_id TEXT REFERENCES coupons(id),
  price_snapshot TEXT NOT NULL,
  policy_snapshot TEXT NOT NULL,
  offline_method TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  hold_expires_at INTEGER,
  checked_in_at TEXT,
  no_show INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT NOT NULL DEFAULT '',
  cancelled_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX bookings_venue_date ON bookings(venue_id, date);
CREATE INDEX bookings_customer ON bookings(customer_id, start_at);
CREATE INDEX bookings_status ON bookings(status, hold_expires_at);

-- The double-booking guarantee: one row per (court, date, slot start) for every live booking (held or confirmed).
-- A second claim on the same slot fails on the primary key no matter how the requests interleave.
CREATE TABLE slot_claims (
  court_id TEXT NOT NULL REFERENCES courts(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  PRIMARY KEY (court_id, date, start_time)
);
CREATE INDEX slot_claims_booking ON slot_claims(booking_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  provider TEXT NOT NULL,
  intent_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  refunded INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requires_payment','succeeded','failed','cancelled','refunded','partially_refunded')),
  failure_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX payments_booking ON payments(booking_id);

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  payment_id TEXT REFERENCES payments(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','processed','rejected')),
  reason TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL CHECK (origin IN ('policy','owner','customer_request','admin','system')),
  requested_by TEXT REFERENCES users(id),
  decided_by TEXT REFERENCES users(id),
  decision_note TEXT NOT NULL DEFAULT '',
  provider_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX refunds_booking ON refunds(booking_id);

CREATE TABLE webhook_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  scope TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, scope, key)
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  owner_reply TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX reviews_venue ON reviews(venue_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL CHECK (channel IN ('inapp','email','whatsapp','push')),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '',
  booking_id TEXT REFERENCES bookings(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','skipped','cancelled')),
  send_after INTEGER NOT NULL,
  sent_at TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX notifications_due ON notifications(status, send_after);
CREATE INDEX notifications_user ON notifications(user_id, channel, created_at);

CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  venue_id TEXT REFERENCES venues(id),
  booking_id TEXT REFERENCES bookings(id),
  kind TEXT NOT NULL CHECK (kind IN ('support','dispute')),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE support_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX support_messages_ticket ON support_messages(ticket_id, created_at);

CREATE TABLE payouts (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  gross INTEGER NOT NULL,
  refunds INTEGER NOT NULL,
  commission INTEGER NOT NULL,
  net INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  reference TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  paid_at TEXT,
  UNIQUE (venue_id, period_start, period_end)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id),
  venue_id TEXT REFERENCES venues(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_venue ON audit_events(venue_id, created_at);
