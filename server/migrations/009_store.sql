-- Shop and rentals at the venue's front desk. An item can be for sale (sale_price), for hire (rent_price per game or
-- per day, with a refundable deposit), or both. Players order and pay in the app, then collect at the desk with a code.
CREATE TABLE store_items (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  category TEXT NOT NULL CHECK (category IN ('accessories','equipment','clothing','footwear','books','nutrition')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '',
  sport TEXT,
  sizes TEXT NOT NULL DEFAULT '[]',
  sale_price INTEGER CHECK (sale_price IS NULL OR sale_price >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  rent_price INTEGER CHECK (rent_price IS NULL OR rent_price >= 0),
  rent_unit TEXT NOT NULL DEFAULT 'game' CHECK (rent_unit IN ('game','day')),
  deposit INTEGER NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  rent_stock INTEGER NOT NULL DEFAULT 0 CHECK (rent_stock >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX store_items_venue ON store_items(venue_id, category);

-- kind 'purchase': held -> paid -> collected. kind 'rental': held -> paid -> out -> returned.
-- Either can end cancelled, expired, failed or refunded. Rentals cover start_date..end_date inclusive.
CREATE TABLE store_orders (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  venue_id TEXT NOT NULL REFERENCES venues(id),
  customer_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('purchase','rental')),
  status TEXT NOT NULL CHECK (status IN ('held','paid','collected','out','returned','cancelled','expired','failed','refunded')),
  items TEXT NOT NULL,
  subtotal INTEGER NOT NULL,
  deposit INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,
  start_date TEXT,
  end_date TEXT,
  pickup_code TEXT NOT NULL DEFAULT '',
  hold_expires_at INTEGER,
  deposit_kept INTEGER NOT NULL DEFAULT 0,
  return_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  paid_at TEXT,
  handed_at TEXT,
  returned_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX store_orders_venue ON store_orders(venue_id, status);
CREATE INDEX store_orders_customer ON store_orders(customer_id, created_at);

CREATE TABLE store_payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES store_orders(id),
  provider TEXT NOT NULL,
  intent_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  refunded INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requires_payment','succeeded','failed','cancelled','refunded','partially_refunded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX store_payments_order ON store_payments(order_id);
