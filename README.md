# TurfConnect

Mobile-first booking and operations platform for sports turfs: players find, book, pay for and review turfs;
venue owners manage availability, pricing, staff, refunds and reports; platform admins verify venues, resolve
disputes and settle payouts. Built to the TurfConnect PRD MVP scope.

**Stack:** Node.js 22 (no npm dependencies), built-in SQLite (`node:sqlite`), vanilla JavaScript installable PWA.

## Run locally

```bash
npm run seed:reset   # demo venues, players and ~6 weeks of booking history
npm start            # http://localhost:3200
npm test             # end-to-end API tests (booking races, payments, webhooks, permissions)
```

In development the sign-in code is shown on screen and the login page lists demo accounts:

| Account | Role |
|---|---|
| `player@turfconnect.test` | Player with upcoming and past bookings |
| `owner@turfconnect.test` | Owner of five Bengaluru venues |
| `manager@turfconnect.test` | Manager at Kickoff Arena |
| `desk@turfconnect.test` | Front desk at Kickoff Arena |
| `admin@turfconnect.test` | Platform admin |

Promo codes: `WELCOME20` (20% off, first booking), `KICKOFF100` (₹100 off at Kickoff Arena).

## How the key rules are enforced

- **No double booking.** Every live booking claims its slots in `slot_claims`, whose primary key is
  (court, date, start). A second claim fails in the database however requests interleave.
- **Checkout holds.** A hold lasts the venue's configured minutes; expired holds are released by a sweeper and
  before every new hold. Failed payments release the slot immediately.
- **Payment confirmation only from a verified webhook.** HMAC-SHA256 signature with a 5-minute timestamp window,
  event de-duplication, and amount checks. A payment that lands after its slot was re-sold is refunded in full.
- **Prices and cancellation policy are snapshotted** on each booking; later changes only affect new bookings.
- **Audit log** for bookings, payments, refunds, pricing, staff, venue and payout changes (payout account details are
  masked).
- **Roles:** front desk < manager < owner < platform admin, checked on every venue endpoint.

## Project layout

```
server/            HTTP API, booking engine, payments, notifications, reports
  migrations/      SQL schema
  routes/          auth, discovery, bookings, owner, support, admin
  tests/           node:test end-to-end tests
web/               PWA (index.html, app.js, lib.js, views/, service worker)
scripts/           asset generator (icons, venue illustrations)
```

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3200) |
| `TURF_SECRET` | Session signing secret, 32+ chars (required in production) |
| `TURF_WEBHOOK_SECRET` | Payment webhook signing secret, 32+ chars (required in production) |
| `TURF_DEV_OTP` | `true` shows sign-in codes on screen. Demo only: anyone can then sign in as any account |
| `TURF_SEED_DEMO` | `true` loads demo data into an empty database on start |
| `TURF_COMMISSION_PERCENT` | Platform commission deducted at settlement (default 10) |
| `TURF_DATA_DIR` / `TURF_DB` | Where the SQLite database and uploads live |

## Deploy

- **Docker:** copy `.env.example` to `.env`, fill in the secrets, `docker compose up -d --build`.
- **Render:** `render.yaml` is a Blueprint for a free-plan demo (data resets on each deploy or restart). For
  real use switch to a paid plan with the commented-out disk and turn off demo mode.

## Not yet production-ready

These are stubbed behind adapters so they can be swapped in without touching the booking logic:

- **Payments** use a sandbox gateway page. Plug a real provider (Razorpay / Stripe) into `server/payments.js`.
- **Sign-in codes, email and WhatsApp** are logged to the console. Wire SMS/email/WhatsApp providers into
  `server/notify.js` and the OTP request in `server/routes/auth.js`, then set `TURF_DEV_OTP=false`.
- **Web push** when the app is closed, **passkeys**, and the PRD's **AI features** are not built yet.
- Single-instance design (SQLite, in-memory rate limiting and live-update streams). Move to PostgreSQL + Redis
  before running more than one server.
