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
The server listens on `process.env.PORT || 5050` and creates `class_manager.db` in the project root.

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

## Deployment
Designed for Railway:
- Uses only filesystem + SQLite (no native dependencies beyond `better-sqlite3`)
- Reads `PORT` env variable
- Configure `SESSION_SECRET`, `ADMIN_PASSWORD`, `DEFAULT_STUDENT_PASSWORD` as needed
