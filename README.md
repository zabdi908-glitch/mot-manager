# MOT Manager Pro

A garage management CRM for tracking vehicles, customers, and MOT test bookings — built with a Node/Express backend and vanilla JS frontend, deployed on Render.

**Live app:** `https://mot-manager.onrender.com`
**Admin panel:** `https://mot-manager.onrender.com/admin/` (password protected)
**Public customer page:** `https://mot-manager.onrender.com/`

---

## 1. Project Structure

```
mot-manager/
├── backend/
│   └── server.js              # Express app — API, auth, email, static file serving
├── frontend/
│   ├── admin/
│   │   └── index.html         # Admin CRM (dashboard, vehicles, bookings, customers, notifications)
│   └── public/
│       └── index.html         # Public-facing MOT lookup + booking request page
├── data.json                  # JSON "database" (customers, vehicles, bookings, notifications)
├── package.json
└── README.md                  # This file
```

**How it fits together:**
- `server.js` is the only backend file. It reads/writes `data.json` as a flat-file database (no SQL), serves the two frontend folders as static sites, and exposes a REST API under `/api` (admin, password-protected) and `/api/public` (open, rate-limited).
- `frontend/admin/index.html` is a single-file SPA (HTML + CSS + JS all in one) — no build step, no framework. Talks to `/api/*`.
- `frontend/public/index.html` is the same approach — a single-file SPA for customers to check their MOT status and request a booking. Talks to `/api/public/*`.

---

## 2. Environment Variables (set these on Render)

| Variable | Purpose | Required? |
|---|---|---|
| `ADMIN_PASSWORD` | Password for `/admin` (Basic Auth) | Yes — without it, admin is unprotected |
| `ADMIN_USER` | Admin username | No — defaults to `admin` |
| `DATA_DIR` | Path to Render Persistent Disk mount (e.g. `/var/data`) | Yes — without it, all data is wiped on every redeploy |
| `EMAIL_USER` / `EMAIL_PASS` | Gmail account used to send MOT reminder + backup emails | No — email features silently disable without it |
| `ADMIN_EMAIL` | Where weekly backup emails are sent | No — defaults to `EMAIL_USER` |
| `BUSINESS_NAME` | Shown in emails and on the public page header | No — defaults to "The Workshop" |
| `BUSINESS_PHONE` | Shown in emails as a contact option | No |
| `PUBLIC_URL` | Overrides the auto-detected base URL used in email links | No — Render sets `RENDER_EXTERNAL_URL` automatically |

⚠️ **`DATA_DIR` is the most important one to double-check.** If it's not set, the server logs a warning on startup and all customer/vehicle/booking data lives on ephemeral disk — gone on the next deploy.

---

## 3. Where We Are Now (Status)

### ✅ Working
- Customer, vehicle, and booking CRUD (admin side)
- Public MOT lookup by registration number
- Public booking requests (customer books → lands as `pending`)
- Admin booking status flow: **Pending → Confirm → Mark Complete**, or **Cancel** at any point
- Automated MOT reminder emails (staged: 30 days / 7 days / overdue), sent via a 12-hour interval check
- Weekly automated data backup emailed as JSON attachment
- Manual "Backup" download button + manual "Send Reminder Now" per vehicle
- CSV export of due/overdue vehicles
- Dashboard stats (Total Vehicles, Due Soon, Overdue, Upcoming Bookings) and an Alerts list
- Admin auth with brute-force lockout (6 failed attempts → 15 min lockout per IP)
- Public API rate limiting (30 requests / 15 min / IP)
- Persistent disk storage on Render (once `DATA_DIR` is set)

### 🔧 Just fixed (this session)
- Booking status wasn't distinguishing "booked" from "test actually done" — added a **Mark Complete** action
- Marking complete now also prompts for the new MOT expiry date and updates the vehicle record, so completed vehicles automatically drop off "Overdue"/"Due Soon" and out of the "Upcoming Bookings" count

### 🚧 Known gaps / left to do
- [ ] **Replace the native `prompt()` for entering new MOT expiry** with a proper styled modal (matches the yellow/black plate theme, date picker instead of typed text) — flagged, not yet built
- [ ] **No "Failed MOT" path** — currently "Mark Complete" assumes a pass. A failed test has no distinct status or workflow (e.g. retest booking, partial fail with retest window)
- [ ] **No booking-to-vehicle history view** — can't currently see all past bookings for one vehicle from the Vehicles tab (data exists, no UI for it yet)
- [ ] **No edit/reschedule for bookings** — a booking's date/time can't be changed once created; has to be cancelled and rebooked
- [ ] **No multi-user / role support** — single shared admin login, no per-staff accounts or audit trail of who confirmed/completed what
- [ ] **JSON file as database** — fine at current scale, but no concurrent-write protection; worth moving to SQLite/Postgres if data volume or multi-admin use grows
- [ ] **No SMS reminders**, email only
- [ ] **No test/staging environment** — changes go straight to the live Render service

---

## 4. Where We're Going (Roadmap)

**Short term**
1. Custom "complete booking" modal with date picker (replace `prompt()`)
2. Pass/Fail distinction on completion, with a "book retest" shortcut on fail
3. Booking history visible per-vehicle

**Medium term**
4. Editable/reschedulable bookings
5. Move from `data.json` to SQLite for reliability as data grows
6. Basic staging setup (separate Render service + `DATA_DIR`) to test changes before they hit customers

**Longer term (ideas, not committed)**
- SMS reminders alongside email
- Multiple staff logins with individual audit history
- Customer-facing booking status page (so customers can check "is my booking confirmed?" without calling)

---

## 5. Local Development

```bash
git clone <your-repo-url>
cd mot-manager
npm install
# create a .env file or export the variables from section 2 manually
node backend/server.js
```

Visit `http://localhost:3000` for the public page, `http://localhost:3000/admin/` for the admin panel.

## 6. Deployment

Connected to Render via GitHub — any push to the tracked branch triggers an automatic redeploy. No manual deploy steps needed, but always confirm `DATA_DIR` points at a Persistent Disk before relying on this in production.
