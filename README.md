# Class Management Platform

Production-ready Node.js (Express) application that covers class administration, QR-based attendance, payment tracking, finance reporting, and exam seat booking with role-based dashboards for administrators and students.

## Stack
- Node.js 18+
- Express + EJS views
- better-sqlite3 (persistent DB at `class_manager.db`)
- express-session + SQLite store
- Plain HTML/CSS/JS front-ends (no bundlers)

## Structure
```
server.js              # Express bootstrap
/db.js                 # SQLite schema + seed helpers
/routes/               # Auth pages, admin/student pages, JSON APIs
/views/                # EJS templates
/public/css, js        # Static assets (admin & student consoles)
```

## Running locally
```bash
npm install
npm start
```
The server listens on `process.env.PORT || 5050` and persists all SQLite files inside `./data` (configurable via `DATA_DIR`).

## Configuration
- `PORT` / `HOST`: optional overrides for the HTTP listener (defaults `5050` / `0.0.0.0`)
- `SESSION_SECRET`: required in production for signed cookies
- `ADMIN_PASSWORD`, `DEFAULT_STUDENT_PASSWORD`: bootstrap credentials
- `DATA_DIR` or `RAILWAY_VOLUME_MOUNT_PATH`: directory for the SQLite DB + session store
- `DB_PATH`: explicit path to the main database file (overrides `DATA_DIR`)

## Default accounts
| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `admin123` |
| Student sample | `0711111111` | `1234` |

New students automatically get logins using their phone number as username and the default password `1234` (change via `DEFAULT_STUDENT_PASSWORD`).

## Key features
- Session-based auth with student/admin roles
- Student CRUD, class management, enrollments
- QR attendance scanner (html5-qrcode) + manual override
- Attendance board per class/date with toggles
- Monthly payments, unpaid list, finance summary
- Exam booking with seat visualisation (Grade 7 & 8 only)
- Student portal limited to exam booking + profile
- Settings tab lets admins download the raw SQLite DB file

## Deployment on Railway (free tier)
1. Install the Railway CLI (`npm i -g railway`) and log in with `railway login`.
2. From this repository run `railway init` (or connect an existing project) and keep the default build command so Railway runs `npm install` followed by `npm start`.
3. In the Railway dashboard, add a Volume to the service (1 GB is enough) and note the mount path (e.g. `/data`). Set the `DATA_DIR` environment variable to that same path so both the main DB and the session store live on the persistent disk.
4. Add required secrets: at minimum `SESSION_SECRET`, plus overrides for `ADMIN_PASSWORD` / `DEFAULT_STUDENT_PASSWORD` if you do not want the defaults.
5. Deploy with `railway up` (CLI) or via the dashboard. Railway automatically provisions `PORT`, so no hard-coded value is necessary. A `/health` endpoint is available for health checks.

Because the app now trusts the upstream proxy in production, secure cookies work behind Railway's HTTPS terminators, and the SQLite files stay on the attached volume even when the container restarts.
