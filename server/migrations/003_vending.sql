-- Snack and coffee vending machines. A machine belongs to a venue and reports its own state (stock, temperature, faults)
-- with a per-machine API key. Players pre-order and pay in the app, then enter a pickup code at the machine.
CREATE TABLE vending_machines (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('snacks','coffee','combo')),
  location TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL,
  temperature REAL,
  door_open INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  alerted_offline INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX vending_machines_venue ON vending_machines(venue_id);

CREATE TABLE vending_items (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES vending_machines(id),
  slot TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('snack','coffee','drink')),
  price INTEGER NOT NULL CHECK (price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  capacity INTEGER NOT NULL DEFAULT 10,
  low_at INTEGER NOT NULL DEFAULT 3,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (machine_id, slot)
);

CREATE TABLE vending_faults (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES vending_machines(id),
  code TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX vending_faults_machine ON vending_faults(machine_id, resolved_at);

CREATE TABLE vending_orders (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  machine_id TEXT NOT NULL REFERENCES vending_machines(id),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('held','paid','dispensed','cancelled','expired','failed','refunded')),
  amount INTEGER NOT NULL,
  items TEXT NOT NULL,
  pickup_code TEXT NOT NULL DEFAULT '',
  hold_expires_at INTEGER,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  dispensed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX vending_orders_machine ON vending_orders(machine_id, status);
CREATE INDEX vending_orders_customer ON vending_orders(customer_id, created_at);

-- Order payments mirror the booking payments table; the same signed webhook confirms them.
CREATE TABLE order_payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES vending_orders(id),
  provider TEXT NOT NULL,
  intent_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  refunded INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requires_payment','succeeded','failed','cancelled','refunded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX order_payments_order ON order_payments(order_id);
