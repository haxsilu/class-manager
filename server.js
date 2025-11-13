// server.js
// Class Management / Payment / Attendance System in a single file
// NOTE: Data is stored in "class_manager.db". Replacing this file (server.js)
// will NOT erase data as long as the DB file is preserved (e.g. Railway volume).

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 5050;
const DB_FILE = path.join(__dirname, "class_manager.db");

// ---------- DB SETUP ----------
if (!fs.existsSync(DB_FILE)) {
  fs.closeSync(fs.openSync(DB_FILE, "w"));
}
let db = new Database(DB_FILE);
db.pragma("foreign_keys = ON");

// Create tables
db.exec(`
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL UNIQUE,
  fee INTEGER NOT NULL DEFAULT 0 CHECK (fee >= 0)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  grade TEXT NOT NULL,
  qr_token TEXT UNIQUE,
  is_free INTEGER NOT NULL DEFAULT 0 CHECK (is_free IN (0,1))
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  present INTEGER NOT NULL DEFAULT 1 CHECK (present IN (0,1)),
  UNIQUE(student_id, class_id, date),
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  method TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, class_id, month),
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);
`);

// Seed classes once
const seedClassesStmt = db.prepare("SELECT COUNT(*) AS cnt FROM classes");
const classesCount = seedClassesStmt.get().cnt;
if (classesCount === 0) {
  const insertClass = db.prepare(
    "INSERT INTO classes (title, fee) VALUES (?, ?)"
  );
  const classes = ["Grade 6", "Grade 7", "Grade 8", "O/L"];
  const fee = 2000;
  const tx = db.transaction(() => {
    classes.forEach((title) => insertClass.run(title, fee));
  });
  tx();
}

// Helpers
function generateQrToken() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function getTodayDate() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCurrentMonth() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getClassByGrade(grade) {
  return db
    .prepare("SELECT * FROM classes WHERE title = ?")
    .get(grade || "");
}

// ---------- EXPRESS APP ----------
const app = express();
app.use(express.json());

// ---------- FRONTEND HTML ----------
const FRONTEND_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Class Manager</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #020617;
      --bg-alt: #0f172a;
      --bg-soft: #111827;
      --border: #1f2937;
      --accent: #3b82f6;
      --accent-soft: rgba(59,130,246,0.1);
      --text: #e5e7eb;
      --text-soft: #9ca3af;
      --danger: #ef4444;
      --success: #22c55e;
      --warning: #eab308;
      --radius: 8px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      background: radial-gradient(circle at top left, #0b1120 0, #020617 45%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: rgba(15, 23, 42, 0.95);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 20;
    }
    .header-inner {
      max-width: 1180px;
      margin: 0 auto;
      padding: 0.75rem 1rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .logo {
      font-weight: 600;
      letter-spacing: 0.04em;
      font-size: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .logo-pill {
      width: 26px;
      height: 26px;
      border-radius: 999px;
      background: radial-gradient(circle at 30% 30%, #60a5fa, #1d4ed8);
      box-shadow: 0 0 0 1px rgba(59,130,246,0.8), 0 0 18px rgba(59,130,246,0.5);
    }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
    }
    .nav-btn {
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-soft);
      padding: 0.35rem 0.7rem;
      border-radius: 999px;
      font-size: 0.75rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .nav-btn span.icon {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 1px solid rgba(148,163,184,0.35);
    }
    .nav-btn:hover {
      border-color: rgba(148,163,184,0.4);
      background: rgba(15,23,42,0.8);
      color: var(--text);
    }
    .nav-btn.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: #e5e7eb;
      box-shadow: 0 0 0 1px rgba(37,99,235,0.6), inset 0 0 0 1px rgba(15,23,42,0.5);
    }

    main {
      flex: 1;
      max-width: 1180px;
      margin: 1rem auto 1.5rem;
      padding: 0 1rem;
      width: 100%;
    }
    .cards {
      display: grid;
      grid-template-columns: minmax(0, 1.8fr) minmax(0, 1.2fr);
      gap: 1rem;
      margin-bottom: 1rem;
    }
    @media (max-width: 900px) {
      .cards {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .card {
      background: radial-gradient(circle at top left, #020617, #020617 30%, #020617 100%);
      background-color: rgba(15, 23, 42, 0.95);
      border-radius: 1rem;
      border: 1px solid rgba(15,23,42,1);
      box-shadow:
        0 14px 35px rgba(0,0,0,0.65),
        inset 0 0 0 1px rgba(148,163,184,0.08);
      padding: 1rem;
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: "";
      position: absolute;
      inset: -40%;
      background:
        radial-gradient(circle at top left, rgba(59,130,246,0.12), transparent 60%),
        radial-gradient(circle at bottom right, rgba(30,64,175,0.14), transparent 55%);
      opacity: 0.9;
      pointer-events: none;
      z-index: -1;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 0.5rem;
      gap: 0.5rem;
    }
    .card-title {
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-soft);
    }
    .card-subtitle {
      font-size: 0.75rem;
      color: var(--text-soft);
    }
    .badge {
      border-radius: 999px;
      border: 1px solid rgba(148,163,184,0.4);
      padding: 0.1rem 0.5rem;
      font-size: 0.7rem;
      color: var(--text-soft);
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      white-space: nowrap;
    }
    .badge-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 10px rgba(34,197,94,0.6);
    }

    .input-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      margin-bottom: 0.6rem;
    }
    label {
      font-size: 0.75rem;
      color: var(--text-soft);
      display: block;
      margin-bottom: 0.15rem;
    }
    .field {
      flex: 1 1 140px;
      min-width: 0;
    }
    input[type="text"],
    input[type="tel"],
    input[type="date"],
    input[type="month"],
    select {
      width: 100%;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(15,23,42,0.9);
      color: var(--text);
      padding: 0.45rem 0.7rem;
      font-size: 0.8rem;
      outline: none;
      transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
    }
    input:focus,
    select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px rgba(37,99,235,0.7);
      background: rgba(15,23,42,1);
    }
    input[type="checkbox"] {
      width: 14px;
      height: 14px;
      border-radius: 4px;
      border: 1px solid var(--border);
      background: rgba(15,23,42,0.9);
      accent-color: var(--accent);
    }

    button,
    .btn {
      border-radius: 999px;
      border: 1px solid transparent;
      background: var(--accent);
      color: #e5e7eb;
      padding: 0.45rem 0.9rem;
      font-size: 0.8rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      transition: background 0.12s ease, transform 0.06s ease, box-shadow 0.12s ease, border-color 0.12s ease;
      text-decoration: none;
      white-space: nowrap;
    }
    button:hover,
    .btn:hover {
      background: #2563eb;
      box-shadow: 0 12px 30px rgba(37,99,235,0.5);
      transform: translateY(-0.5px);
    }
    button.btn-outline,
    .btn.btn-outline {
      background: rgba(15,23,42,0.7);
      border-color: var(--border);
      color: var(--text-soft);
    }
    button.btn-outline:hover,
    .btn.btn-outline:hover {
      border-color: rgba(148,163,184,0.8);
      background: rgba(15,23,42,1);
      color: var(--text);
      box-shadow: 0 8px 22px rgba(15,23,42,0.75);
    }
    .btn-small {
      padding: 0.25rem 0.6rem;
      font-size: 0.7rem;
    }

    .pill {
      border-radius: 999px;
      border: 1px solid var(--border);
      padding: 0.3rem 0.6rem;
      font-size: 0.7rem;
      color: var(--text-soft);
    }
    .pill-quiet {
      background: rgba(15,23,42,0.7);
    }

    .notice {
      border-radius: 0.8rem;
      border: 1px solid rgba(148,163,184,0.3);
      background: radial-gradient(circle at top left, rgba(15,23,42,0.9), rgba(15,23,42,0.9));
      padding: 0.6rem 0.75rem;
      font-size: 0.75rem;
      color: var(--text-soft);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.6rem;
    }
    .notice strong { color: var(--text); }
    .notice.ok { border-color: rgba(52,211,153,0.5); }
    .notice.err { border-color: rgba(239,68,68,0.6); color: #fecaca; }

    .tab-section { display: none; }
    .tab-section.active { display: block; }

    .table-container {
      border-radius: 0.8rem;
      border: 1px solid var(--border);
      background: rgba(15,23,42,0.95);
      overflow: hidden;
      overflow-x: auto;
      max-height: 480px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.78rem;
      min-width: 540px;
    }
    thead {
      background: rgba(15,23,42,0.9);
      position: sticky;
      top: 0;
      z-index: 5;
    }
    th, td {
      padding: 0.45rem 0.6rem;
      border-bottom: 1px solid rgba(31,41,55,0.9);
      text-align: left;
      white-space: nowrap;
    }
    th {
      font-weight: 500;
      color: var(--text-soft);
      text-transform: uppercase;
      font-size: 0.7rem;
    }
    tbody tr:nth-child(even) {
      background: rgba(15,23,42,0.85);
    }
    tbody tr:hover {
      background: rgba(30,64,175,0.22);
    }
    .tag {
      border-radius: 999px;
      border: 1px solid rgba(148,163,184,0.4);
      padding: 0.1rem 0.5rem;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .tag-free { border-color: rgba(52,211,153,0.7); color: #bbf7d0; }
    .tag-unpaid { border-color: rgba(248,113,113,0.7); color: #fecaca; }
    .tag-paid { border-color: rgba(52,211,153,0.7); color: #a7f3d0; }
    .tag-method-cash { border-color: rgba(251,191,36,0.7); color: #facc15; }
    .tag-method-bank { border-color: rgba(56,189,248,0.7); color: #e0f2fe; }
    .tag-method-online { border-color: rgba(196,181,253,0.7); color: #ddd6fe; }

    .muted { color: var(--text-soft); font-size: 0.75rem; }

    .flex-between {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.5rem;
    }
    .flex-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }

    /* Payment modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(15,23,42,0.85);
      display: none;
      justify-content: center;
      align-items: center;
      z-index: 50;
      padding: 1rem;
    }
    .modal-backdrop.active {
      display: flex;
    }
    .modal {
      width: 100%;
      max-width: 420px;
      border-radius: 1rem;
      background: radial-gradient(circle at top left, #020617, #020617 30%, #020617 100%);
      border: 1px solid var(--border);
      box-shadow: 0 18px 45px rgba(0,0,0,0.9);
      padding: 1rem;
    }
    .modal h3 {
      margin: 0 0 0.5rem;
      font-size: 0.95rem;
    }

    /* Scanner area */
    #qr-reader {
      width: 100%;
      max-width: 360px;
      border-radius: 1rem;
      overflow: hidden;
      border: 1px solid var(--border);
      margin-bottom: 0.7rem;
      background: #020617;
    }
    #qr-reader__scan_region {
      background: #020617;
    }
    #qr-reader__camera_selection {
      background: #020617;
    }

    footer {
      text-align: center;
      font-size: 0.7rem;
      color: var(--text-soft);
      padding: 0.75rem 1rem 1rem;
      border-top: 1px solid rgba(15,23,42,0.9);
      background: radial-gradient(circle at top left, rgba(15,23,42,0.9), rgba(2,6,23,0.98));
    }

    @media (max-width: 640px) {
      .header-inner {
        flex-direction: column;
        align-items: stretch;
      }
      nav {
        justify-content: flex-start;
      }
    }
  </style>
  <!-- QR library -->
  <script src="https://unpkg.com/html5-qrcode@2.3.10/minified/html5-qrcode.min.js"></script>
</head>
<body>
<header>
  <div class="header-inner">
    <div class="logo">
      <div class="logo-pill"></div>
      <span>Class Manager</span>
    </div>
    <nav>
      <button class="nav-btn active" data-tab="students"><span class="icon"></span>Students</button>
      <button class="nav-btn" data-tab="scanner"><span class="icon"></span>Scanner</button>
      <button class="nav-btn" data-tab="attendance"><span class="icon"></span>Attendance</button>
      <button class="nav-btn" data-tab="unpaid"><span class="icon"></span>Unpaid</button>
      <button class="nav-btn" data-tab="finance"><span class="icon"></span>Finance</button>
      <button class="nav-btn" data-tab="settings"><span class="icon"></span>Settings</button>
    </nav>
  </div>
</header>

<main>
  <!-- STUDENTS TAB -->
  <section id="tab-students" class="tab-section active">
    <div class="cards">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Students</div>
            <div class="card-subtitle">Add, edit, and manage enrollments.</div>
          </div>
          <span class="badge">
            <span class="badge-dot"></span>
            Live instance
          </span>
        </div>
        <form id="student-form">
          <input type="hidden" id="student-id" />
          <div class="input-row">
            <div class="field">
              <label for="student-name">Name</label>
              <input type="text" id="student-name" required placeholder="Student name" />
            </div>
            <div class="field">
              <label for="student-phone">Phone</label>
              <input type="tel" id="student-phone" placeholder="07x xxx xxxx" />
            </div>
          </div>
          <div class="input-row">
            <div class="field">
              <label for="student-grade">Class / Grade</label>
              <select id="student-grade" required>
                <option value="">Select class</option>
                <option value="Grade 6">Grade 6</option>
                <option value="Grade 7">Grade 7</option>
                <option value="Grade 8">Grade 8</option>
                <option value="O/L">O/L</option>
              </select>
            </div>
            <div class="field">
              <label>Free card</label>
              <div class="flex-row">
                <input type="checkbox" id="student-free" />
                <span class="muted">Mark as free-card student</span>
              </div>
            </div>
          </div>
          <div class="flex-between" style="margin-top:0.25rem;">
            <div class="muted" id="student-form-status"></div>
            <div class="flex-row">
              <button type="button" class="btn btn-outline btn-small" id="student-reset-btn">Clear</button>
              <button type="submit" class="btn btn-small" id="student-submit-btn">Add student</button>
            </div>
          </div>
        </form>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Quick stats</div>
            <div class="card-subtitle">Snapshot of the current month.</div>
          </div>
        </div>
        <div id="quick-stats">
          <div class="pill pill-quiet" style="margin-bottom:0.35rem;">
            Total students: <strong id="stat-total-students">0</strong>
          </div>
          <div class="pill pill-quiet" style="margin-bottom:0.35rem;">
            Free-card students: <strong id="stat-free-students">0</strong>
          </div>
          <div class="pill pill-quiet" style="margin-bottom:0.35rem;">
            Revenue this month: <strong id="stat-month-revenue">0</strong> LKR
          </div>
          <div class="muted" style="margin-top:0.5rem;">
            Stats automatically refresh as you add students and record payments.
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">All students</div>
          <div class="card-subtitle">Tap a row to edit, print QR, or delete.</div>
        </div>
        <div class="flex-row">
          <div class="pill pill-quiet" id="students-count-pill">0 students</div>
        </div>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Class</th>
              <th>Free</th>
              <th>QR</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="students-table-body"></tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- SCANNER TAB -->
  <section id="tab-scanner" class="tab-section">
    <div class="cards">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">QR scanner</div>
            <div class="card-subtitle">Scan student QR to mark attendance.</div>
          </div>
          <span class="badge">
            <span class="badge-dot"></span>
            Camera access required
          </span>
        </div>
        <div id="scan-notice" class="notice">
          <div><strong>Scanner idle.</strong> Aim at a QR to begin.</div>
          <div class="tag">READY</div>
        </div>
        <div id="qr-reader"></div>
        <div class="muted" style="margin-bottom:0.6rem;">
          When you open this tab, the camera will request permission and start scanning automatically.
        </div>

        <form id="scanner-manual-form" style="margin-top:0.75rem;">
          <div class="card-subtitle" style="margin-bottom:0.35rem;">Manual attendance (backup)</div>
          <div class="input-row">
            <div class="field">
              <label for="scanner-manual-phone">Phone (auto-detect class)</label>
              <input type="tel" id="scanner-manual-phone" placeholder="Student phone" required />
            </div>
          </div>
          <div class="flex-between">
            <div class="muted" id="scanner-manual-status"></div>
            <button type="submit" class="btn btn-outline btn-small">Mark present (today)</button>
          </div>
        </form>

        <button type="button" class="btn btn-outline btn-small" id="scanner-payment-btn" disabled style="margin-top:0.6rem;">
          Record payment for last scan
        </button>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Last scan</div>
            <div class="card-subtitle">Details of the most recent QR.</div>
          </div>
        </div>
        <div id="scanner-last-details" class="muted">
          No scans yet.
        </div>
      </div>
    </div>
  </section>

  <!-- ATTENDANCE TAB -->
  <section id="tab-attendance" class="tab-section">
    <div class="cards">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Attendance sheet</div>
            <div class="card-subtitle">Load by class and date.</div>
          </div>
        </div>
        <form id="attendance-load-form">
          <div class="input-row">
            <div class="field">
              <label for="attendance-class">Class</label>
              <select id="attendance-class" required>
                <option value="">Select class</option>
                <option value="Grade 6">Grade 6</option>
                <option value="Grade 7">Grade 7</option>
                <option value="Grade 8">Grade 8</option>
                <option value="O/L">O/L</option>
              </select>
            </div>
            <div class="field">
              <label for="attendance-date">Date</label>
              <input type="date" id="attendance-date" required />
            </div>
            <div class="field" style="flex:0 0 auto;margin-top:1.2rem;">
              <button type="submit" class="btn btn-small">Load sheet</button>
            </div>
          </div>
        </form>
        <div id="attendance-sheet-info" class="muted"></div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Quick mark (manual)</div>
            <div class="card-subtitle">Use this if a QR fails.</div>
          </div>
        </div>
        <form id="attendance-manual-form">
          <div class="input-row">
            <div class="field">
              <label for="manual-phone">Phone</label>
              <input type="tel" id="manual-phone" placeholder="Student phone" required />
            </div>
            <div class="field">
              <label for="manual-class">Class</label>
              <select id="manual-class" required>
                <option value="">Select class</option>
                <option value="Grade 6">Grade 6</option>
                <option value="Grade 7">Grade 7</option>
                <option value="Grade 8">Grade 8</option>
                <option value="O/L">O/L</option>
              </select>
            </div>
          </div>
          <div class="input-row">
            <div class="field">
              <label for="manual-date">Date</label>
              <input type="date" id="manual-date" required />
            </div>
          </div>
          <div class="flex-between">
            <div class="muted" id="attendance-manual-status"></div>
            <button type="submit" class="btn btn-small">Mark present</button>
          </div>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Attendance list</div>
          <div class="card-subtitle">Current view for selected date and class.</div>
        </div>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Free</th>
              <th>Present</th>
            </tr>
          </thead>
          <tbody id="attendance-table-body"></tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- UNPAID TAB -->
  <section id="tab-unpaid" class="tab-section">
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Unpaid students</div>
          <div class="card-subtitle">Filter by month and class.</div>
        </div>
      </div>
      <form id="unpaid-form">
        <div class="input-row">
          <div class="field">
            <label for="unpaid-month">Month</label>
            <input type="month" id="unpaid-month" required />
          </div>
          <div class="field">
            <label for="unpaid-class">Class (optional)</label>
            <select id="unpaid-class">
              <option value="">All classes</option>
              <option value="Grade 6">Grade 6</option>
              <option value="Grade 7">Grade 7</option>
              <option value="Grade 8">Grade 8</option>
              <option value="O/L">O/L</option>
            </select>
          </div>
          <div class="field" style="flex:0 0 auto;margin-top:1.2rem;">
            <button type="submit" class="btn btn-small">Load unpaid list</button>
          </div>
        </div>
      </form>
      <div class="muted" id="unpaid-info"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Unpaid list</div>
          <div class="card-subtitle">Tap "Record payment" to settle.</div>
        </div>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Class</th>
              <th>Name</th>
              <th>Phone</th>
              <th>Expected fee</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="unpaid-table-body"></tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- FINANCE TAB -->
  <section id="tab-finance" class="tab-section">
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Finance overview</div>
          <div class="card-subtitle">Monthly collections by class.</div>
        </div>
      </div>
      <form id="finance-form">
        <div class="input-row">
          <div class="field">
            <label for="finance-month">Month</label>
            <input type="month" id="finance-month" required />
          </div>
          <div class="field" style="flex:0 0 auto;margin-top:1.2rem;">
            <button type="submit" class="btn btn-small">Run report</button>
          </div>
        </div>
      </form>
      <div class="muted" id="finance-info"></div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Collections</div>
          <div class="card-subtitle">Per class and total.</div>
        </div>
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Class</th>
              <th>Payments</th>
              <th>Total (LKR)</th>
            </tr>
          </thead>
          <tbody id="finance-table-body"></tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- SETTINGS TAB -->
  <section id="tab-settings" class="tab-section">
    <div class="cards">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Database</div>
            <div class="card-subtitle">Backup or inspect data.</div>
          </div>
        </div>
        <p class="muted">
          Use this to download the raw SQLite database file. Replacing <code>server.js</code> does not erase it.
          On Railway, attach a persistent volume for <code>class_manager.db</code> to keep data across deploys.
        </p>
        <div class="flex-row" style="margin-bottom:0.5rem;">
          <a href="/admin/db/download" class="btn btn-small" download>Download database</a>
          <button type="button" id="db-info-btn" class="btn btn-outline btn-small">Show DB info</button>
        </div>
        <div class="muted" id="db-info-text"></div>
      </div>

      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Exports</div>
            <div class="card-subtitle">CSV snapshots.</div>
          </div>
        </div>
        <p class="muted">
          Download CSV exports of students and payments for reporting or external analysis.
        </p>
        <div class="flex-row">
          <a href="/admin/export/students.csv" class="btn btn-small">Students CSV</a>
          <a href="/admin/export/payments.csv" class="btn btn-small">Payments CSV</a>
        </div>
      </div>
    </div>
  </section>
</main>

<footer>
  Created by Pulindu Pansilu
</footer>

<div class="modal-backdrop" id="payment-modal">
  <div class="modal">
    <div class="flex-between" style="margin-bottom:0.15rem;">
      <h3>Record payment</h3>
      <button type="button" class="btn btn-outline btn-small" id="payment-close-btn">Close</button>
    </div>
    <div class="muted" id="payment-student-label"></div>
    <form id="payment-form" style="margin-top:0.6rem;">
      <input type="hidden" id="payment-student-id" />
      <input type="hidden" id="payment-class-id" />
      <div class="input-row">
        <div class="field">
          <label for="payment-month">Month</label>
          <input type="month" id="payment-month" required />
        </div>
        <div class="field">
          <label for="payment-amount">Amount (LKR)</label>
          <input type="text" id="payment-amount" required />
        </div>
      </div>
      <div class="input-row">
        <div class="field">
          <label for="payment-method">Method</label>
          <select id="payment-method" required>
            <option value="cash">Cash</option>
            <option value="bank">Bank</option>
            <option value="online">Online</option>
          </select>
        </div>
      </div>
      <div class="flex-between">
        <div class="muted" id="payment-status"></div>
        <button type="submit" class="btn btn-small">Save payment</button>
      </div>
    </form>
  </div>
</div>

<script>
  // ---------- UTILITIES ----------
  const apiGet = (url) => fetch(url).then(r => {
    if (!r.ok) throw new Error("Request failed");
    return r.json();
  });
  const apiPost = (url, body) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Request failed");
    return data;
  });
  const apiPut = (url, body) => fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Request failed");
    return data;
  });
  const apiDelete = (url) => fetch(url, { method: "DELETE" }).then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Request failed");
    return data;
  });

  function getCurrentMonthStr() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    return year + "-" + month;
  }
  function getTodayStr() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  // ---------- NAV TABS ----------
  const navButtons = document.querySelectorAll(".nav-btn");
  const tabSections = document.querySelectorAll(".tab-section");
  navButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      navButtons.forEach(b => b.classList.toggle("active", b === btn));
      tabSections.forEach(section => {
        section.classList.toggle("active", section.id === "tab-" + tab);
      });
      if (tab === "scanner") {
        initScanner();
      }
    });
  });

  // ---------- STUDENTS ----------
  const studentForm = document.getElementById("student-form");
  const studentIdInput = document.getElementById("student-id");
  const studentNameInput = document.getElementById("student-name");
  const studentPhoneInput = document.getElementById("student-phone");
  const studentGradeInput = document.getElementById("student-grade");
  const studentFreeInput = document.getElementById("student-free");
  const studentFormStatus = document.getElementById("student-form-status");
  const studentResetBtn = document.getElementById("student-reset-btn");
  const studentSubmitBtn = document.getElementById("student-submit-btn");
  const studentsTableBody = document.getElementById("students-table-body");
  const studentsCountPill = document.getElementById("students-count-pill");
  const statTotalStudents = document.getElementById("stat-total-students");
  const statFreeStudents = document.getElementById("stat-free-students");
  const statMonthRevenue = document.getElementById("stat-month-revenue");

  let cachedClasses = [];
  let lastScanInfo = null;

  function resetStudentForm() {
    studentIdInput.value = "";
    studentNameInput.value = "";
    studentPhoneInput.value = "";
    studentGradeInput.value = "";
    studentFreeInput.checked = false;
    studentFormStatus.textContent = "";
    studentSubmitBtn.textContent = "Add student";
  }

  studentResetBtn.addEventListener("click", () => {
    resetStudentForm();
  });

  studentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: studentNameInput.value.trim(),
      phone: studentPhoneInput.value.trim(),
      grade: studentGradeInput.value,
      is_free: studentFreeInput.checked ? 1 : 0
    };
    if (!payload.name || !payload.grade) {
      studentFormStatus.textContent = "Name and class are required.";
      return;
    }
    try {
      if (studentIdInput.value) {
        await apiPut("/api/students/" + encodeURIComponent(studentIdInput.value), payload);
        studentFormStatus.textContent = "Student updated.";
      } else {
        await apiPost("/api/students", payload);
        studentFormStatus.textContent = "Student added.";
      }
      await refreshStudents();
      await refreshStats();
      studentSubmitBtn.textContent = "Add student";
      studentIdInput.value = "";
    } catch (err) {
      studentFormStatus.textContent = err.message || "Error saving student.";
    }
  });

  async function refreshClasses() {
    try {
      const data = await apiGet("/api/classes");
      cachedClasses = (data && data.classes) || [];
    } catch (err) {
      console.error("Failed to load classes", err);
    }
  }

  function classIdForGrade(grade) {
    const c = cachedClasses.find(c => c.title === grade);
    return c ? c.id : null;
  }

  async function refreshStudents() {
    try {
      const data = await apiGet("/api/students");
      const students = (data && data.students) || [];
      studentsTableBody.innerHTML = "";
      let freeCount = 0;
      students.forEach(st => {
        if (st.is_free) freeCount++;
        const tr = document.createElement("tr");

        const tdName = document.createElement("td");
        tdName.textContent = st.name;

        const tdPhone = document.createElement("td");
        tdPhone.textContent = st.phone || "-";

        const tdGrade = document.createElement("td");
        tdGrade.textContent = st.grade;

        const tdFree = document.createElement("td");
        tdFree.innerHTML = st.is_free ? '<span class="tag tag-free">FREE CARD</span>' : "";

        const tdQR = document.createElement("td");
        const qrLink = document.createElement("a");
        qrLink.href = "/students/" + st.id + "/qr";
        qrLink.target = "_blank";
        qrLink.className = "btn btn-outline btn-small";
        qrLink.textContent = "QR";
        tdQR.appendChild(qrLink);

        const tdActions = document.createElement("td");
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn btn-outline btn-small";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => {
          studentIdInput.value = st.id;
          studentNameInput.value = st.name;
          studentPhoneInput.value = st.phone || "";
          studentGradeInput.value = st.grade;
          studentFreeInput.checked = !!st.is_free;
          studentSubmitBtn.textContent = "Save changes";
          studentFormStatus.textContent = "";
          document.getElementById("tab-students").scrollIntoView({ behavior: "smooth" });
        });

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn btn-outline btn-small";
        delBtn.style.marginLeft = "0.25rem";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", async () => {
          if (!confirm("Delete this student and all their attendance/payments?")) return;
          try {
            await apiDelete("/api/students/" + st.id);
            await refreshStudents();
            await refreshStats();
          } catch (err) {
            alert("Failed to delete student: " + (err.message || ""));
          }
        });

        tdActions.appendChild(editBtn);
        tdActions.appendChild(delBtn);

        tr.appendChild(tdName);
        tr.appendChild(tdPhone);
        tr.appendChild(tdGrade);
        tr.appendChild(tdFree);
        tr.appendChild(tdQR);
        tr.appendChild(tdActions);

        studentsTableBody.appendChild(tr);
      });
      const total = students.length;
      studentsCountPill.textContent = total + " student" + (total === 1 ? "" : "s");
      statTotalStudents.textContent = total;
      statFreeStudents.textContent = freeCount;
    } catch (err) {
      console.error("Failed to load students", err);
    }
  }

  async function refreshStats() {
    try {
      const month = getCurrentMonthStr();
      const data = await apiGet("/api/finance?month=" + encodeURIComponent(month));
      const total = (data && data.total) || 0;
      statMonthRevenue.textContent = total;
    } catch (err) {
      console.error("Failed to load stats", err);
    }
  }

  // ---------- SCANNER ----------
  let html5QrCodeInstance = null;
  let scannerStarted = false;
  const scanNotice = document.getElementById("scan-notice");
  const scannerLastDetails = document.getElementById("scanner-last-details");
  const scannerPaymentBtn = document.getElementById("scanner-payment-btn");
  const scannerManualForm = document.getElementById("scanner-manual-form");
  const scannerManualPhone = document.getElementById("scanner-manual-phone");
  const scannerManualStatus = document.getElementById("scanner-manual-status");

  function setScanNotice(type, message, tagText) {
    if (!scanNotice) return;
    scanNotice.classList.remove("ok", "err");
    if (type === "ok") scanNotice.classList.add("ok");
    if (type === "err") scanNotice.classList.add("err");
    const textDiv = scanNotice.querySelector("div");
    if (textDiv) {
      textDiv.innerHTML = "<strong>" + message + "</strong>";
    }
    const tag = scanNotice.querySelector(".tag");
    if (tag && tagText) tag.textContent = tagText.toUpperCase();
  }

  function playBeep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch (e) {
      // ignore
    }
  }

  const onScanSuccess = async (decodedText) => {
    let token = (decodedText || "").trim();
    try {
      const idx = token.lastIndexOf("/scan/");
      if (idx !== -1) {
        token = token.substring(idx + "/scan/".length);
      } else {
        const parts = token.split("/");
        token = parts[parts.length - 1];
      }
    } catch (e) {}
    if (!token) {
      setScanNotice("err", "Invalid QR content.", "ERROR");
      return;
    }
    setScanNotice("ok", "Processing scan…", "WORKING");
    try {
      const res = await apiPost("/scan/" + encodeURIComponent(token) + "/auto", {});
      playBeep();
      const st = res.student;
      lastScanInfo = {
        student_id: st.id,
        class_id: res.class_id,
        name: st.name,
        grade: st.grade,
        is_free: st.is_free,
        paid: res.paid,
        month: res.month
      };
      const paidLabel = st.is_free ? "FREE CARD" : (res.paid ? "PAID" : "UNPAID");
      const paidColorClass = st.is_free ? "tag-free" : (res.paid ? "tag-paid" : "tag-unpaid");
      setScanNotice("ok", "Attendance recorded for " + st.name + ".", paidLabel);
      scannerLastDetails.innerHTML =
        "<div class='pill pill-quiet'>Name: <strong>" + st.name + "</strong></div>" +
        "<div class='pill pill-quiet'>Phone: " + (st.phone || "-") + "</div>" +
        "<div class='pill pill-quiet'>Class: " + st.grade + "</div>" +
        "<div class='pill pill-quiet'>Today: " + res.date + "</div>" +
        "<div style='margin-top:0.4rem;'><span class='tag " + paidColorClass + "'>" + paidLabel + " · " + res.month + "</span></div>";
      scannerPaymentBtn.disabled = !!st.is_free;
    } catch (err) {
      setScanNotice("err", err.message || "Scan failed.", "ERROR");
    }
  };

  const onScanFailure = (error) => {
    // decode errors are frequent; ignore
  };

  function initScanner() {
    const qrReaderElem = document.getElementById("qr-reader");
    if (!qrReaderElem) return;

    if (typeof Html5Qrcode === "undefined") {
      setScanNotice("err", "QR library not loaded. Check your connection.", "ERROR");
      return;
    }

    if (!html5QrCodeInstance) {
      html5QrCodeInstance = new Html5Qrcode("qr-reader");
    }

    if (scannerStarted) return;

    const config = { fps: 10, qrbox: { width: 220, height: 220 } };
    html5QrCodeInstance
      .start({ facingMode: "environment" }, config, onScanSuccess, onScanFailure)
      .then(() => {
        scannerStarted = true;
        setScanNotice("ok", "Scanner ready. Point a QR code to the camera.", "READY");
      })
      .catch(err => {
        console.error("Scanner start failed", err);
        setScanNotice("err", "Unable to start camera. Check permissions.", "ERROR");
      });
  }

  scannerPaymentBtn.addEventListener("click", () => {
    if (!lastScanInfo || lastScanInfo.is_free) return;
    openPaymentModal({
      student_id: lastScanInfo.student_id,
      class_id: lastScanInfo.class_id,
      name: lastScanInfo.name,
      month: lastScanInfo.month
    });
  });

  scannerManualForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const phone = scannerManualPhone.value.trim();
    if (!phone) {
      scannerManualStatus.textContent = "Phone is required.";
      return;
    }
    try {
      await apiPost("/api/attendance/manual-today-by-phone", { phone });
      scannerManualStatus.textContent = "Attendance marked for today.";
      scannerManualPhone.value = "";
    } catch (err) {
      scannerManualStatus.textContent = err.message || "Failed to mark attendance.";
    }
  });

  // ---------- ATTENDANCE ----------
  const attendanceLoadForm = document.getElementById("attendance-load-form");
  const attendanceClassInput = document.getElementById("attendance-class");
  const attendanceDateInput = document.getElementById("attendance-date");
  const attendanceSheetInfo = document.getElementById("attendance-sheet-info");
  const attendanceTableBody = document.getElementById("attendance-table-body");
  const attendanceManualForm = document.getElementById("attendance-manual-form");
  const manualPhoneInput = document.getElementById("manual-phone");
  const manualClassInput = document.getElementById("manual-class");
  const manualDateInput = document.getElementById("manual-date");
  const attendanceManualStatus = document.getElementById("attendance-manual-status");

  attendanceDateInput.value = getTodayStr();
  manualDateInput.value = getTodayStr();

  attendanceLoadForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const grade = attendanceClassInput.value;
    const date = attendanceDateInput.value;
    if (!grade || !date) return;
    try {
      const classId = classIdForGrade(grade);
      if (!classId) throw new Error("Class not found in system.");
      const data = await apiGet("/api/attendance/list?class_id=" + encodeURIComponent(classId) + "&date=" + encodeURIComponent(date));
      const records = (data && data.records) || [];
      attendanceTableBody.innerHTML = "";
      records.forEach(r => {
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + r.name + "</td>" +
          "<td>" + (r.phone || "-") + "</td>" +
          "<td>" + (r.is_free ? "<span class='tag tag-free'>FREE</span>" : "") + "</td>" +
          "<td>" + (r.present ? "<span class='tag tag-paid'>PRESENT</span>" : "<span class='tag tag-unpaid'>ABSENT</span>") + "</td>";
        attendanceTableBody.appendChild(tr);
      });
      attendanceSheetInfo.textContent = "Loaded " + records.length + " students for " + grade + " on " + date + ".";
    } catch (err) {
      attendanceSheetInfo.textContent = err.message || "Failed to load attendance.";
    }
  });

  attendanceManualForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      phone: manualPhoneInput.value.trim(),
      grade: manualClassInput.value,
      date: manualDateInput.value
    };
    if (!payload.phone || !payload.grade || !payload.date) {
      attendanceManualStatus.textContent = "All fields are required.";
      return;
    }
    try {
      await apiPost("/api/attendance/manual", payload);
      attendanceManualStatus.textContent = "Attendance marked.";
      if (attendanceClassInput.value === payload.grade && attendanceDateInput.value === payload.date) {
        attendanceLoadForm.dispatchEvent(new Event("submit"));
      }
    } catch (err) {
      attendanceManualStatus.textContent = err.message || "Failed to mark attendance.";
    }
  });

  // ---------- UNPAID ----------
  const unpaidForm = document.getElementById("unpaid-form");
  const unpaidMonthInput = document.getElementById("unpaid-month");
  const unpaidClassInput = document.getElementById("unpaid-class");
  const unpaidInfo = document.getElementById("unpaid-info");
  const unpaidTableBody = document.getElementById("unpaid-table-body");

  unpaidMonthInput.value = getCurrentMonthStr();

  unpaidForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const month = unpaidMonthInput.value;
    const grade = unpaidClassInput.value;
    if (!month) return;
    try {
      let url = "/api/unpaid?month=" + encodeURIComponent(month);
      if (grade) url += "&grade=" + encodeURIComponent(grade);
      const data = await apiGet(url);
      const items = (data && data.unpaid) || [];
      unpaidTableBody.innerHTML = "";
      items.forEach(item => {
        const tr = document.createElement("tr");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-outline btn-small";
        btn.textContent = "Record payment";
        btn.addEventListener("click", () => {
          openPaymentModal({
            student_id: item.student_id,
            class_id: item.class_id,
            name: item.name,
            month
          });
        });
        const actionTd = document.createElement("td");
        actionTd.appendChild(btn);
        tr.innerHTML =
          "<td>" + item.class_title + "</td>" +
          "<td>" + item.name + "</td>" +
          "<td>" + (item.phone || "-") + "</td>" +
          "<td>2000</td>";
        tr.appendChild(actionTd);
        unpaidTableBody.appendChild(tr);
      });
      const totalUnpaid = items.length;
      const expected = totalUnpaid * 2000;
      unpaidInfo.textContent = totalUnpaid + " unpaid student(s) for " + month +
        (grade ? " in " + grade : " in all classes") +
        ". Expected income from these: " + expected + " LKR.";
    } catch (err) {
      unpaidInfo.textContent = err.message || "Failed to load unpaid list.";
    }
  });

  // ---------- FINANCE ----------
  const financeForm = document.getElementById("finance-form");
  const financeMonthInput = document.getElementById("finance-month");
  const financeInfo = document.getElementById("finance-info");
  const financeTableBody = document.getElementById("finance-table-body");

  financeMonthInput.value = getCurrentMonthStr();

  financeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const month = financeMonthInput.value;
    if (!month) return;
    try {
      const data = await apiGet("/api/finance?month=" + encodeURIComponent(month));
      const rows = (data && data.rows) || [];
      const total = (data && data.total) || 0;
      financeTableBody.innerHTML = "";
      rows.forEach(r => {
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + r.class_title + "</td>" +
          "<td>" + r.payments + "</td>" +
          "<td>" + r.total + "</td>";
        financeTableBody.appendChild(tr);
      });
      financeInfo.textContent = "Total revenue for " + month + ": " + total + " LKR.";
    } catch (err) {
      financeInfo.textContent = err.message || "Failed to load finance data.";
    }
  });

  // ---------- PAYMENT MODAL ----------
  const paymentModal = document.getElementById("payment-modal");
  const paymentCloseBtn = document.getElementById("payment-close-btn");
  const paymentStudentLabel = document.getElementById("payment-student-label");
  const paymentForm = document.getElementById("payment-form");
  const paymentStudentIdInput = document.getElementById("payment-student-id");
  const paymentClassIdInput = document.getElementById("payment-class-id");
  const paymentMonthInput = document.getElementById("payment-month");
  const paymentAmountInput = document.getElementById("payment-amount");
  const paymentMethodInput = document.getElementById("payment-method");
  const paymentStatus = document.getElementById("payment-status");

  function openPaymentModal(opts) {
    paymentStudentIdInput.value = opts.student_id;
    paymentClassIdInput.value = opts.class_id;
    paymentStudentLabel.textContent = "For " + (opts.name || "student");
    paymentMonthInput.value = opts.month || getCurrentMonthStr();
    paymentAmountInput.value = "2000";
    paymentMethodInput.value = "cash";
    paymentStatus.textContent = "";
    paymentModal.classList.add("active");
  }

  function closePaymentModal() {
    paymentModal.classList.remove("active");
  }

  paymentCloseBtn.addEventListener("click", () => {
    closePaymentModal();
  });

  paymentModal.addEventListener("click", (e) => {
    if (e.target === paymentModal) closePaymentModal();
  });

  paymentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      student_id: Number(paymentStudentIdInput.value),
      class_id: Number(paymentClassIdInput.value),
      month: paymentMonthInput.value,
      amount: Number(paymentAmountInput.value.replace(/[^0-9]/g, "")) || 0,
      method: paymentMethodInput.value
    };
    if (!payload.student_id || !payload.class_id || !payload.month || !payload.amount || !payload.method) {
      paymentStatus.textContent = "All fields are required.";
      return;
    }
    try {
      await apiPost("/api/payments/record", payload);
      paymentStatus.textContent = "Payment saved.";
      await refreshStats();
      unpaidForm.dispatchEvent(new Event("submit"));
    } catch (err) {
      paymentStatus.textContent = err.message || "Failed to save payment.";
    }
  });

  // ---------- SETTINGS: DB INFO ----------
  const dbInfoBtn = document.getElementById("db-info-btn");
  const dbInfoText = document.getElementById("db-info-text");
  dbInfoBtn.addEventListener("click", async () => {
    try {
      const info = await apiGet("/admin/db/info");
      dbInfoText.textContent =
        "Size: " + info.size_kb + " KB · Path: " + info.path +
        " · Students: " + info.students +
        " · Payments: " + info.payments +
        " · Attendance records: " + info.attendance;
    } catch (err) {
      dbInfoText.textContent = err.message || "Failed to load DB info.";
    }
  });

  // ---------- INITIAL LOAD ----------
  (async function init() {
    await refreshClasses();
    await refreshStudents();
    await refreshStats();
    unpaidForm.dispatchEvent(new Event("submit"));
    financeForm.dispatchEvent(new Event("submit"));
  })();
</script>
</body>
</html>`;

// ---------- ROUTES ----------

// Serve SPA
app.get("/", (req, res) => {
  res.type("html").send(FRONTEND_HTML);
});

// Health check
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// Download DB
app.get("/admin/db/download", (req, res) => {
  res.download(DB_FILE, "class_manager.db");
});

// DB info
app.get("/admin/db/info", (req, res) => {
  try {
    const stats = fs.statSync(DB_FILE);
    const size_kb = Math.round(stats.size / 1024);
    const students = db.prepare("SELECT COUNT(*) AS c FROM students").get().c;
    const payments = db.prepare("SELECT COUNT(*) AS c FROM payments").get().c;
    const attendance = db.prepare("SELECT COUNT(*) AS c FROM attendance").get().c;
    res.json({
      path: DB_FILE,
      size_kb,
      students,
      payments,
      attendance
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to get DB info" });
  }
});

// Export students CSV
app.get("/admin/export/students.csv", (req, res) => {
  try {
    const rows = db.prepare("SELECT id, name, phone, grade, is_free, qr_token FROM students ORDER BY id").all();
    let csv = "id,name,phone,grade,is_free,qr_token\n";
    for (const r of rows) {
      const line = [
        r.id,
        JSON.stringify(r.name || ""),
        JSON.stringify(r.phone || ""),
        JSON.stringify(r.grade || ""),
        r.is_free ? 1 : 0,
        JSON.stringify(r.qr_token || "")
      ].join(",");
      csv += line + "\n";
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="students.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to export students");
  }
});

// Export payments CSV
app.get("/admin/export/payments.csv", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id, p.student_id, s.name AS student_name, s.phone,
             s.grade, p.class_id, c.title AS class_title,
             p.month, p.amount, p.method, p.created_at
      FROM payments p
      JOIN students s ON s.id = p.student_id
      JOIN classes c ON c.id = p.class_id
      ORDER BY p.month DESC, c.id, s.name
    `).all();
    let csv = "id,student_id,student_name,phone,grade,class_id,class_title,month,amount,method,created_at\n";
    for (const r of rows) {
      const line = [
        r.id,
        r.student_id,
        JSON.stringify(r.student_name || ""),
        JSON.stringify(r.phone || ""),
        JSON.stringify(r.grade || ""),
        r.class_id,
        JSON.stringify(r.class_title || ""),
        JSON.stringify(r.month || ""),
        r.amount,
        JSON.stringify(r.method || ""),
        JSON.stringify(r.created_at || "")
      ].join(",");
      csv += line + "\n";
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="payments.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to export payments");
  }
});

// API: Classes
app.get("/api/classes", (req, res) => {
  try {
    const classes = db.prepare("SELECT id, title, fee FROM classes ORDER BY id").all();
    res.json({ classes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load classes" });
  }
});

// API: Students
app.get("/api/students", (req, res) => {
  try {
    const students = db
      .prepare("SELECT id, name, phone, grade, is_free, qr_token FROM students ORDER BY name")
      .all();
    res.json({ students });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load students" });
  }
});

app.post("/api/students", (req, res) => {
  try {
    const { name, phone, grade, is_free } = req.body || {};
    if (!name || !grade) {
      return res.status(400).json({ error: "Name and grade are required" });
    }
    const qr_token = generateQrToken();
    const stmt = db.prepare(
      "INSERT INTO students (name, phone, grade, qr_token, is_free) VALUES (?, ?, ?, ?, ?)"
    );
    const info = stmt.run(name.trim(), (phone || "").trim(), grade, qr_token, is_free ? 1 : 0);
    const student = db
      .prepare("SELECT id, name, phone, grade, qr_token, is_free FROM students WHERE id = ?")
      .get(info.lastInsertRowid);
    res.json({ student });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add student" });
  }
});

app.put("/api/students/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid student id" });
    const existing = db.prepare("SELECT * FROM students WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Student not found" });
    const { name, phone, grade, is_free } = req.body || {};
    if (!name || !grade) {
      return res.status(400).json({ error: "Name and grade are required" });
    }
    const stmt = db.prepare(
      "UPDATE students SET name = ?, phone = ?, grade = ?, is_free = ? WHERE id = ?"
    );
    stmt.run(name.trim(), (phone || "").trim(), grade, is_free ? 1 : 0, id);
    const student = db
      .prepare("SELECT id, name, phone, grade, qr_token, is_free FROM students WHERE id = ?")
      .get(id);
    res.json({ student });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update student" });
  }
});

app.delete("/api/students/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid student id" });
    const stmt = db.prepare("DELETE FROM students WHERE id = ?");
    stmt.run(id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete student" });
  }
});

// Student QR page
app.get("/students/:id/qr", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const student = db
      .prepare("SELECT s.id, s.name, s.qr_token FROM students s WHERE s.id = ?")
      .get(id);
    if (!student) return res.status(404).send("Student not found");

    const token = student.qr_token || generateQrToken();
    if (!student.qr_token) {
      db.prepare("UPDATE students SET qr_token = ? WHERE id = ?").run(token, id);
    }

    const host = req.get("host");
    const protocol = req.protocol;
    const qrContent = protocol + "://" + host + "/scan/" + token;

    QRCode.toDataURL(qrContent, { margin: 2, scale: 8 }, (err, url) => {
      if (err) {
        console.error(err);
        return res.status(500).send("Failed to generate QR");
      }
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>QR | ${student.name}</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align:center; padding:20px; background:#020617; color:#e5e7eb; }
    .card { display:inline-block; padding:20px; border-radius:16px; background:#0f172a; border:1px solid #1f2937; }
    button { padding:8px 14px; border-radius:999px; border:1px solid #3b82f6; background:#1d4ed8; color:#e5e7eb; cursor:pointer; margin-top:12px; }
    img { background:white; padding:10px; border-radius:12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${student.name}</h2>
    <p>${qrContent}</p>
    <img src="${url}" alt="QR code" />
    <div><button onclick="window.print()">Print</button></div>
  </div>
</body>
</html>`;
      res.type("html").send(html);
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// QR scan auto attendance
app.post("/scan/:token/auto", (req, res) => {
  try {
    const token = req.params.token;
    if (!token) return res.status(400).json({ error: "Missing token" });
    const student = db
      .prepare("SELECT id, name, phone, grade, is_free FROM students WHERE qr_token = ?")
      .get(token);
    if (!student) return res.status(404).json({ error: "Student not found" });
    const cls = getClassByGrade(student.grade);
    if (!cls) return res.status(500).json({ error: "Class not found for student's grade" });

    const date = getTodayDate();
    const month = getCurrentMonth();
    const ins = db.prepare(`
      INSERT INTO attendance (student_id, class_id, date, present)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(student_id, class_id, date) DO UPDATE SET present = 1
    `);
    ins.run(student.id, cls.id, date);

    const payment = db
      .prepare("SELECT id FROM payments WHERE student_id = ? AND class_id = ? AND month = ?")
      .get(student.id, cls.id, month);
    const paid = !!payment;

    res.json({
      status: "ok",
      date,
      month,
      student,
      class_id: cls.id,
      paid
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to process scan" });
  }
});

// Attendance list
app.get("/api/attendance/list", (req, res) => {
  try {
    const class_id = Number(req.query.class_id);
    const date = req.query.date;
    if (!class_id || !date) {
      return res.status(400).json({ error: "class_id and date required" });
    }
    const stmt = db.prepare(`
      SELECT s.id AS student_id, s.name, s.phone, s.is_free,
             CASE WHEN a.id IS NULL THEN 0 ELSE a.present END AS present
      FROM students s
      JOIN classes c ON c.title = s.grade
      LEFT JOIN attendance a
        ON a.student_id = s.id AND a.class_id = c.id AND a.date = ?
      WHERE c.id = ?
      ORDER BY s.name
    `);
    const records = stmt.all(date, class_id);
    res.json({ records });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load attendance" });
  }
});

// Manual attendance (full)
app.post("/api/attendance/manual", (req, res) => {
  try {
    const { phone, grade, date } = req.body || {};
    if (!phone || !grade || !date) {
      return res.status(400).json({ error: "phone, grade and date required" });
    }
    const student = db
      .prepare("SELECT id, grade FROM students WHERE phone = ? AND grade = ?")
      .get(phone.trim(), grade);
    if (!student) {
      return res.status(404).json({ error: "Student not found for phone and class" });
    }
    const cls = getClassByGrade(student.grade);
    if (!cls) return res.status(500).json({ error: "Class not found" });

    db.prepare(`
      INSERT INTO attendance (student_id, class_id, date, present)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(student_id, class_id, date) DO UPDATE SET present = 1
    `).run(student.id, cls.id, date);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to mark attendance" });
  }
});

// Manual attendance by phone for today (scanner tab)
app.post("/api/attendance/manual-today-by-phone", (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: "phone required" });
    const student = db
      .prepare("SELECT id, grade FROM students WHERE phone = ?")
      .get(phone.trim());
    if (!student) {
      return res.status(404).json({ error: "Student not found for this phone" });
    }
    const cls = getClassByGrade(student.grade);
    if (!cls) return res.status(500).json({ error: "Class not found" });
    const date = getTodayDate();
    db.prepare(`
      INSERT INTO attendance (student_id, class_id, date, present)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(student_id, class_id, date) DO UPDATE SET present = 1
    `).run(student.id, cls.id, date);
    res.json({ success: true, date, class_id: cls.id, student_id: student.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to mark attendance" });
  }
});

// Payments
app.post("/api/payments/record", (req, res) => {
  try {
    const { student_id, class_id, month, amount, method } = req.body || {};
    if (!student_id || !class_id || !month || !amount || !method) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    db.prepare(`
      INSERT INTO payments (student_id, class_id, month, amount, method)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(student_id, class_id, month) DO UPDATE
        SET amount = excluded.amount,
            method = excluded.method,
            created_at = datetime('now')
    `).run(student_id, class_id, month, amount, method);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

// Unpaid list (with optional grade filter)
app.get("/api/unpaid", (req, res) => {
  try {
    const month = req.query.month;
    const grade = req.query.grade;
    if (!month) return res.status(400).json({ error: "month required" });

    let sql = `
      SELECT s.id AS student_id,
             s.name,
             s.phone,
             s.grade,
             c.id AS class_id,
             c.title AS class_title
      FROM students s
      JOIN classes c ON c.title = s.grade
      WHERE s.is_free = 0
        AND NOT EXISTS (
          SELECT 1 FROM payments p
          WHERE p.student_id = s.id
            AND p.class_id = c.id
            AND p.month = ?
        )
    `;
    const params = [month];
    if (grade) {
      sql += " AND s.grade = ?";
      params.push(grade);
    }
    sql += " ORDER BY c.id, s.name";
    const stmt = db.prepare(sql);
    const unpaid = stmt.all(...params);
    res.json({ unpaid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load unpaid list" });
  }
});

// Finance
app.get("/api/finance", (req, res) => {
  try {
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: "month required" });
    const rows = db
      .prepare(`
        SELECT c.id AS class_id,
               c.title AS class_title,
               COUNT(p.id) AS payments,
               COALESCE(SUM(p.amount), 0) AS total
        FROM classes c
        LEFT JOIN payments p
          ON p.class_id = c.id
         AND p.month = ?
        GROUP BY c.id, c.title
        ORDER BY c.id
      `)
      .all(month);
    const total = rows.reduce((sum, r) => sum + (r.total || 0), 0);
    res.json({ rows, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load finance data" });
  }
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
