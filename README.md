# Thidal · திடல்

**Play. Train. Belong.** Thidal (திடல்) is the Tamil word for an open public ground.

Mobile-first booking and operations platform for sports turfs: players find, book, pay for and review turfs;
venue owners manage availability, pricing, staff, refunds and reports; platform admins verify venues, resolve
disputes and settle payouts. Built to the TurfConnect PRD MVP scope (the platform was renamed Thidal).

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

## Pools and wellness classes

- **Swimming pools** are ordinary venues whose courts are lanes (game: swimming). Lane booking uses the same slots, pricing and checkout as turfs.
- **Wellness classes** (yoga, meditation, fitness, aqua...) are scheduled sessions with a seat limit, held in person or online. A seat is a normal booking, so payment, refunds, tickets and check-in all work unchanged. Capacity is counted inside a transaction, so a class cannot be oversold. Online classes carry a join link that only paid players see. Venue managers schedule, edit and cancel classes under **Wellness classes** in the venue console; cancelling refunds every seat in full.
- Players browse classes at `#/wellness`.

## Snack and coffee vending machines

Venues register machines under **Vending machines** in the venue console. Players see which machines are working (`#/vending`, and on each venue page),
pre-order, pay in the app and get a 6-digit pickup code. Stock is reserved by held and paid-but-uncollected orders, so the last item cannot be ordered
twice. An order paid after its items sold out is refunded automatically. Staff are alerted (in-app and email) on low stock, faults and when a machine goes
offline for 3 minutes; managers can refund uncollected paid orders.

A machine authenticates with its own API key (shown once when created) in the `x-machine-key` header:

```
POST /api/device/vending/<machineId>/heartbeat   { "temperature": 4.1, "doorOpen": false, "stock": { "A1": 12 }, "faults": [ { "code": "COIL_JAM", "severity": "critical", "message": "Spiral A2" } ] }
POST /api/device/vending/<machineId>/dispense    { "code": "123456" }   ->  { "dispense": [ { "slot": "A1", "name": "Classic chips", "qty": 2 } ] }
```

Send a heartbeat at least every 2 minutes. Faults missing from a heartbeat are treated as fixed. In demo mode (`TURF_VENDING_SIM`, on by default outside
production) the server keeps the seeded machines reporting; demo keys are `vm_demo_<machine-name-slug>`, for example `vm_demo_snack-point`.

## Entry access control and surveillance

Under **Access & security** in the venue console (front desk can watch it live; managers get the analysis and device setup).

- **Gates and doors** scan the booking QR code (the booking reference) and the server answers *granted* or *denied*: entry opens 15 minutes before the slot and closes when it ends;
  cancelled, unpaid, unknown and online-class codes are refused. It keeps a live headcount per booking (up to 40 people).
- **Cameras** report events (`motion`, `people_count`, `unknown_person`, `tamper`). Video itself is not stored here: add a stream link to open the camera's live view from the dashboard.
- **Alerts** (in-app and email to the owner and managers): *overstay* (people still inside 5 minutes after the slot ended; the player is told to leave, and a warning goes out 10 minutes before the end),
  *no-show* (nobody came 15 minutes into a paid slot), *repeated refused entries*, *head-count mismatch* (cameras see more people than the gates let in), unknown person, tampering and offline devices.
- **Analysis report**: entries and exits, attendance rate, time on site vs booked, peak occupancy per day, arrivals heatmap by weekday and hour, refused entries, alerts and camera head counts.

Devices authenticate with the `x-device-key` header (the key is shown once when you add the device):

```
POST /api/device/access/<gateId>/scan       { "credential": "TCXXXXXXXX", "direction": "in" }   ->  { "result": "granted" | "denied", "reason", "message", "inside" }
POST /api/device/camera/<cameraId>/event    { "kind": "people_count", "people": 12 }
POST /api/device/access/<gateId>/heartbeat  and  /api/device/camera/<cameraId>/heartbeat   (at least every 2 minutes)
```

In demo mode the **Try it without hardware** panel sends the same requests from the browser. Demo keys: `ax_demo_main-gate`, `cm_demo_gate-camera` (pattern `ax_demo_<slug>` / `cm_demo_<slug>`).

## Blog and Q&A

- **Blog** (`#/blog`): platform admins write, edit, publish and delete articles under **Admin > Blog**. Posts support paragraphs, `## headings`, `- bullet` lists and `**bold**`; drafts stay private.
- **Q&A** (`#/questions`, and on every venue page): signed-in players ask public questions about a venue or about Thidal. A venue's owner and managers answer venue
  questions (**Questions** tab in the venue console); admins answer general ones and anything else. Askers are notified when answered.
- **Moderation**: links are not allowed in questions, asking is rate limited, three distinct player reports hide an item, and admins restore or hide items under **Admin > Q&A moderation**.

## Coaches

Venue managers add coaches under **Coaches** in the venue console (specialty, price, session length, languages, bio and weekly availability windows). Players browse `#/coaches`,
open a profile with rating, likes and comments, pick a free slot and book. A coach session is an ordinary booking: payment, refunds and tickets work unchanged, and each coach has
a hidden court so the same slot guard that prevents double-booking a pitch prevents double-booking a coach. Players like coaches with the heart; after a completed session they rate
and comment on the booking page, and managers can reply publicly to a comment.

## Chat assistant (TurfBot)

A floating chat on every page answers instantly from live data, with no outside AI service: free slots by sport, day and time ("badminton tomorrow evening"), prices, the player's
bookings and what a cancellation would refund, refund and payment help, wellness classes, coaches, machine status and pickup codes, entry/QR, promo codes, and venue details.
Anything it cannot answer is searched against answered Q&A and the blog, then handed to support. Personal answers need sign-in. Endpoint: `POST /api/assistant/message { "text": "..." }`.

## One turf

The app is built around a single turf: the first active venue, or the one named by `TURF_VENUE_SLUG`. It opens on that turf (`GET /api/site`): a hero, a **collapsible games menu**
(icons only when collapsed, remembered per browser; a row of tiles on phones), a tile for each game, then coaches, photos and videos, and snack machines. Each game has its own page
(`#/game/football`) with that game's photos and videos, court and slot picker, and an optional coach. There is no venue list, map or filter panel. Other venues in the database are simply not shown.

- **Photos and videos** (owner console, **Photos & videos**): upload photos (3 MB) or MP4/WebM videos (25 MB), or paste a YouTube link, and show each on one game or all games. They appear on game pages, the
  home page and in Learn (`#/gallery`). Uploaded videos are served with byte ranges so they seek properly.
- **Coach add-on**: a coach covers **one game** or **all games** and works whenever the turf is open (or inside weekly windows you set). When a player picks slots they can add a coach who is free for every chosen
  slot; the fee (the coach's rate scaled to the slot length) is a line on the bill and the coach is reserved for those slots. Players can still book a coach one-to-one at `#/coaches`.
- **Surveillance wall** (owner console, **Surveillance**): every camera's live view in a grid with status, people counts and alerts. A camera is shown as a live image or MJPEG stream, an embedded web page, or a link
  that opens in its own window (set per camera under **Access & security, Devices**). Cameras that only offer RTSP need a small converter to a web stream. Because camera feeds are loaded from their own addresses, the
  content security policy allows external HTTPS images and frames.

### Testing without a camera

On **Surveillance**, managers can add **this computer's webcam as a test camera**. It shows your webcam in the browser (the picture never leaves it), detects movement, and reports motion
and head counts to the turf like a real camera, so the live wall, alerts and the camera status can all be tried. Reporting uses the demo simulator, so it needs demo mode (the default outside production).
Cameras and gates can be deleted under **Access & security, Devices** (deleting a camera removes its events; a gate with scan history can only be turned off).

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
