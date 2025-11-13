// server.js
// Class Management / Payment / Attendance System (single file)

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 5050;
const DB_FILE = path.join(__dirname, "class_manager.db");

// ---------- DB SETUP ----------
if (!fs.existsSync(DB_FILE)) fs.closeSync(fs.openSync(DB_FILE, "w"));
const db = new Database(DB_FILE);
db.pragma("foreign_keys = ON");

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

// seed classes once
if (db.prepare("SELECT COUNT(*) c FROM classes").get().c === 0) {
  const insert = db.prepare("INSERT INTO classes (title,fee) VALUES (?,2000)");
  const tx = db.transaction(() => {
    ["Grade 6", "Grade 7", "Grade 8", "O/L"].forEach(t => insert.run(t));
  });
  tx();
}

// helpers
const generateQrToken = () =>
  crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
const getTodayDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};
const getCurrentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
};
const getClassByGrade = (grade) =>
  db.prepare("SELECT * FROM classes WHERE title=?").get(grade || "");

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());

// ---------- FRONTEND ----------
const FRONTEND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Class Manager</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
:root{
  color-scheme:dark;
  --bg:#020617;--bg-alt:#0f172a;--border:#1f2937;
  --accent:#3b82f6;--accent-soft:rgba(59,130,246,.1);
  --text:#e5e7eb;--text-soft:#9ca3af;
}
*{box-sizing:border-box;}
body{
  margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
  background:radial-gradient(circle at top left,#0b1120 0,#020617 45%);
  color:var(--text);min-height:100vh;display:flex;flex-direction:column;
}
header{
  background:rgba(15,23,42,.95);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--border);position:sticky;top:0;z-index:20;
}
.header-inner{
  max-width:1180px;margin:0 auto;padding:.75rem 1rem;
  display:flex;align-items:center;justify-content:space-between;gap:1rem;
}
.logo{font-weight:600;letter-spacing:.04em;font-size:1rem;display:flex;align-items:center;gap:.5rem;}
.logo-pill{
  width:26px;height:26px;border-radius:999px;
  background:radial-gradient(circle at 30% 30%,#60a5fa,#1d4ed8);
  box-shadow:0 0 0 1px rgba(59,130,246,.8),0 0 18px rgba(59,130,246,.5);
}
nav{display:flex;flex-wrap:wrap;gap:.4rem;}
.nav-btn{
  border:1px solid transparent;background:transparent;color:var(--text-soft);
  padding:.35rem .7rem;border-radius:999px;font-size:.75rem;cursor:pointer;
  display:inline-flex;align-items:center;gap:.3rem;transition:all .15s;white-space:nowrap;
}
.nav-btn span.icon{
  width:18px;height:18px;border-radius:999px;border:1px solid rgba(148,163,184,.35);
}
.nav-btn:hover{
  border-color:rgba(148,163,184,.4);background:rgba(15,23,42,.8);color:var(--text);
}
.nav-btn.active{
  border-color:var(--accent);background:var(--accent-soft);color:#e5e7eb;
  box-shadow:0 0 0 1px rgba(37,99,235,.6),inset 0 0 0 1px rgba(15,23,42,.5);
}
main{flex:1;max-width:1180px;margin:1rem auto 1.5rem;padding:0 1rem;width:100%;}
.cards{
  display:grid;grid-template-columns:minmax(0,1.8fr) minmax(0,1.2fr);
  gap:1rem;margin-bottom:1rem;
}
@media(max-width:900px){.cards{grid-template-columns:minmax(0,1fr);}}
.card{
  background:rgba(15,23,42,.95);
  border-radius:1rem;border:1px solid rgba(15,23,42,1);
  box-shadow:0 14px 35px rgba(0,0,0,.65),inset 0 0 0 1px rgba(148,163,184,.08);
  padding:1rem;position:relative;overflow:hidden;
}
.card::before{
  content:"";position:absolute;inset:-40%;
  background:
    radial-gradient(circle at top left,rgba(59,130,246,.12),transparent 60%),
    radial-gradient(circle at bottom right,rgba(30,64,175,.14),transparent 55%);
  opacity:.9;pointer-events:none;z-index:-1;
}
.card-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.5rem;gap:.5rem;}
.card-title{font-size:.9rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-soft);}
.card-subtitle{font-size:.75rem;color:var(--text-soft);}
.badge{
  border-radius:999px;border:1px solid rgba(148,163,184,.4);
  padding:.1rem .5rem;font-size:.7rem;color:var(--text-soft);
  display:inline-flex;align-items:center;gap:.25rem;white-space:nowrap;
}
.badge-dot{width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px rgba(34,197,94,.6);}
.input-row{display:flex;flex-wrap:wrap;gap:.6rem;margin-bottom:.6rem;}
label{font-size:.75rem;color:var(--text-soft);display:block;margin-bottom:.15rem;}
.field{flex:1 1 140px;min-width:0;}
input[type=text],input[type=tel],input[type=date],input[type=month],select{
  width:100%;border-radius:999px;border:1px solid var(--border);
  background:rgba(15,23,42,.9);color:var(--text);
  padding:.45rem .7rem;font-size:.8rem;outline:none;
  transition:border-color .12s,box-shadow .12s,background .12s;
}
input:focus,select:focus{
  border-color:var(--accent);box-shadow:0 0 0 1px rgba(37,99,235,.7);background:rgba(15,23,42,1);
}
input[type=checkbox]{
  width:14px;height:14px;border-radius:4px;border:1px solid var(--border);
  background:rgba(15,23,42,.9);accent-color:var(--accent);
}
button,.btn{
  border-radius:999px;border:1px solid transparent;background:var(--accent);color:#e5e7eb;
  padding:.45rem .9rem;font-size:.8rem;cursor:pointer;
  display:inline-flex;align-items:center;gap:.3rem;
  transition:background .12s,transform .06s,box-shadow .12s,border-color .12s;
  text-decoration:none;white-space:nowrap;
}
button:hover,.btn:hover{
  background:#2563eb;box-shadow:0 12px 30px rgba(37,99,235,.5);transform:translateY(-.5px);
}
.btn-outline{background:rgba(15,23,42,.7);border-color:var(--border);color:var(--text-soft);}
.btn-outline:hover{border-color:rgba(148,163,184,.8);background:rgba(15,23,42,1);color:var(--text);}
.btn-small{padding:.25rem .6rem;font-size:.7rem;}
.pill{border-radius:999px;border:1px solid var(--border);padding:.3rem .6rem;font-size:.7rem;color:var(--text-soft);}
.pill-quiet{background:rgba(15,23,42,.7);}
.notice{
  border-radius:.8rem;border:1px solid rgba(148,163,184,.3);
  background:rgba(15,23,42,.9);padding:.6rem .75rem;
  font-size:.75rem;color:var(--text-soft);
  display:flex;justify-content:space-between;align-items:center;gap:.75rem;margin-bottom:.6rem;
}
.notice strong{color:var(--text);}
.notice.ok{border-color:rgba(52,211,153,.5);}
.notice.err{border-color:rgba(239,68,68,.6);color:#fecaca;}
.tab-section{display:none;}
.tab-section.active{display:block;}
.table-container{
  border-radius:.8rem;border:1px solid var(--border);background:rgba(15,23,42,.95);
  overflow:hidden;overflow-x:auto;max-height:480px;
}
table{width:100%;border-collapse:collapse;font-size:.78rem;min-width:540px;}
thead{background:rgba(15,23,42,.9);position:sticky;top:0;z-index:5;}
th,td{padding:.45rem .6rem;border-bottom:1px solid rgba(31,41,55,.9);text-align:left;white-space:nowrap;}
th{font-weight:500;color:var(--text-soft);text-transform:uppercase;font-size:.7rem;}
tbody tr:nth-child(even){background:rgba(15,23,42,.85);}
tbody tr:hover{background:rgba(30,64,175,.22);}
.tag{
  border-radius:999px;border:1px solid rgba(148,163,184,.4);
  padding:.1rem .5rem;font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;
}
.tag-free{border-color:rgba(52,211,153,.7);color:#bbf7d0;}
.tag-unpaid{border-color:rgba(248,113,113,.7);color:#fecaca;}
.tag-paid{border-color:rgba(52,211,153,.7);color:#a7f3d0;}
.muted{color:var(--text-soft);font-size:.75rem;}
.flex-between{display:flex;justify-content:space-between;align-items:center;gap:.5rem;}
.flex-row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;}
.modal-backdrop{
  position:fixed;inset:0;background:rgba(15,23,42,.85);
  display:none;justify-content:center;align-items:center;z-index:50;padding:1rem;
}
.modal-backdrop.active{display:flex;}
.modal{
  width:100%;max-width:420px;border-radius:1rem;background:#020617;
  border:1px solid var(--border);box-shadow:0 18px 45px rgba(0,0,0,.9);padding:1rem;
}
.modal h3{margin:0 0 .5rem;font-size:.95rem;}
#qr-reader{width:100%;max-width:360px;border-radius:1rem;overflow:hidden;border:1px solid var(--border);margin-bottom:.7rem;background:#020617;}
footer{
  text-align:center;font-size:.7rem;color:var(--text-soft);
  padding:.75rem 1rem 1rem;border-top:1px solid rgba(15,23,42,.9);
  background:radial-gradient(circle at top left,rgba(15,23,42,.9),rgba(2,6,23,.98));
}
@media(max-width:640px){
  .header-inner{flex-direction:column;align-items:stretch;}
  nav{justify-content:flex-start;}
}
</style>
</head>
<body>
<header>
  <div class="header-inner">
    <div class="logo"><div class="logo-pill"></div><span>Class Manager</span></div>
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
  <!-- STUDENTS -->
  <section id="tab-students" class="tab-section active">
    <div class="cards">
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Students</div><div class="card-subtitle">Add / edit.</div></div>
          <span class="badge"><span class="badge-dot"></span>Live</span>
        </div>
        <form id="student-form">
          <input type="hidden" id="student-id" />
          <div class="input-row">
            <div class="field"><label>Name</label><input type="text" id="student-name" required /></div>
            <div class="field"><label>Phone</label><input type="tel" id="student-phone" /></div>
          </div>
          <div class="input-row">
            <div class="field">
              <label>Class / Grade</label>
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
              <div class="flex-row"><input type="checkbox" id="student-free" /><span class="muted">Free-card student</span></div>
            </div>
          </div>
          <div class="flex-between">
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
          <div><div class="card-title">Quick stats</div><div class="card-subtitle">Current month snapshot.</div></div>
        </div>
        <div>
          <div class="pill pill-quiet">Total students: <strong id="stat-total-students">0</strong></div>
          <div class="pill pill-quiet" style="margin-top:.3rem;">Free-card: <strong id="stat-free-students">0</strong></div>
          <div class="pill pill-quiet" style="margin-top:.3rem;">Revenue: <strong id="stat-month-revenue">0</strong> LKR</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">All students</div><div class="card-subtitle">Edit / QR / delete.</div></div>
        <div class="pill pill-quiet" id="students-count-pill">0 students</div>
      </div>
      <div class="table-container">
        <table><thead><tr>
          <th>Name</th><th>Phone</th><th>Class</th><th>Free</th><th>QR</th><th>Actions</th>
        </tr></thead><tbody id="students-table-body"></tbody></table>
      </div>
    </div>
  </section>

  <!-- SCANNER -->
  <section id="tab-scanner" class="tab-section">
    <div class="cards">
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">QR scanner</div><div class="card-subtitle">Camera + QR (no external lib).</div></div>
          <span class="badge"><span class="badge-dot"></span>Camera</span>
        </div>
        <div id="scan-notice" class="notice">
          <div><strong>Scanner idle.</strong> Open camera to begin.</div><div class="tag">READY</div>
        </div>
        <div id="qr-reader"></div>
        <div class="muted">Browser must support camera + QR detection (BarcodeDetector).</div>

        <form id="scanner-manual-form" style="margin-top:.75rem;">
          <div class="card-subtitle" style="margin-bottom:.35rem;">Manual attendance (phone → today)</div>
          <div class="input-row">
            <div class="field"><label>Phone</label><input type="tel" id="scanner-manual-phone" required /></div>
          </div>
          <div class="flex-between">
            <div class="muted" id="scanner-manual-status"></div>
            <button type="submit" class="btn btn-outline btn-small">Mark present</button>
          </div>
        </form>

        <button type="button" class="btn btn-outline btn-small" id="scanner-payment-btn" disabled style="margin-top:.6rem;">
          Record payment for last attendance
        </button>
      </div>
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Last attendance</div><div class="card-subtitle">Auto-updated.</div></div>
        </div>
        <div id="scanner-last-details" class="muted">No attendance yet.</div>
      </div>
    </div>
  </section>

  <!-- ATTENDANCE (VIEW ONLY, NO MANUAL MARK HERE) -->
  <section id="tab-attendance" class="tab-section">
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Attendance sheet</div><div class="card-subtitle">Select class + date.</div></div>
      </div>
      <form id="attendance-load-form">
        <div class="input-row">
          <div class="field">
            <label>Class</label>
            <select id="attendance-class" required>
              <option value="">Select class</option>
              <option value="Grade 6">Grade 6</option>
              <option value="Grade 7">Grade 7</option>
              <option value="Grade 8">Grade 8</option>
              <option value="O/L">O/L</option>
            </select>
          </div>
          <div class="field"><label>Date</label><input type="date" id="attendance-date" required /></div>
          <div class="field" style="flex:0 0 auto;margin-top:1.2rem;"><button class="btn btn-small">Load sheet</button></div>
        </div>
      </form>
      <div class="muted" id="attendance-sheet-info"></div>
    </div>
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Attendance list</div><div class="card-subtitle">Real-time from scans.</div></div>
      </div>
      <div class="table-container">
        <table><thead><tr>
          <th>Name</th><th>Phone</th><th>Free</th><th>Present</th>
        </tr></thead><tbody id="attendance-table-body"></tbody></table>
      </div>
    </div>
  </section>

  <!-- UNPAID -->
  <section id="tab-unpaid" class="tab-section">
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Unpaid students</div><div class="card-subtitle">Filter by month & class.</div></div>
      </div>
      <form id="unpaid-form">
        <div class="input-row">
          <div class="field"><label>Month</label><input type="month" id="unpaid-month" required /></div>
          <div class="field">
            <label>Class (optional)</label>
            <select id="unpaid-class">
              <option value="">All classes</option>
              <option value="Grade 6">Grade 6</option>
              <option value="Grade 7">Grade 7</option>
              <option value="Grade 8">Grade 8</option>
              <option value="O/L">O/L</option>
            </select>
          </div>
          <div class="field" style="flex:0 0 auto;margin-top:1.2rem;"><button class="btn btn-small">Load</button></div>
        </div>
      </form>
      <div class="muted" id="unpaid-info"></div>
    </div>
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Unpaid list</div><div class="card-subtitle">Record payments directly.</div></div>
      </div>
      <div class="table-container">
        <table><thead><tr>
          <th>Class</th><th>Name</th><th>Phone</th><th>Expected</th><th>Action</th>
        </tr></thead><tbody id="unpaid-table-body"></tbody></table>
      </div>
    </div>
  </section>

  <!-- FINANCE -->
  <section id="tab-finance" class="tab-section">
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Finance overview</div><div class="card-subtitle">Monthly collections per class.</div></div>
      </div>
      <form id="finance-form">
        <div class="input-row">
          <div class="field"><label>Month</label><input type="month" id="finance-month" required /></div>
          <div class="field" style="flex:0 0 auto;margin-top:1.2rem;"><button class="btn btn-small">Run</button></div>
        </div>
      </form>
      <div class="muted" id="finance-info"></div>
    </div>
    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Collections</div><div class="card-subtitle">Per class + total.</div></div>
      </div>
      <div class="table-container">
        <table><thead><tr><th>Class</th><th>Payments</th><th>Total (LKR)</th></tr></thead><tbody id="finance-table-body"></tbody></table>
      </div>
    </div>
  </section>

  <!-- SETTINGS -->
  <section id="tab-settings" class="tab-section">
    <div class="cards">
      <div class="card">
        <div class="card-header"><div><div class="card-title">Database</div><div class="card-subtitle">Backup & inspect.</div></div></div>
        <p class="muted">Download the SQLite file. Attach a Railway volume to keep <code>class_manager.db</code> across deploys.</p>
        <div class="flex-row" style="margin-bottom:.5rem;">
          <a href="/admin/db/download" class="btn btn-small" download>Download DB</a>
          <button type="button" id="db-info-btn" class="btn btn-outline btn-small">Show DB info</button>
        </div>
        <div class="muted" id="db-info-text"></div>
      </div>
      <div class="card">
        <div class="card-header"><div><div class="card-title">Exports</div><div class="card-subtitle">CSV snapshots.</div></div></div>
        <p class="muted">Download students and payments CSV for reports.</p>
        <div class="flex-row">
          <a href="/admin/export/students.csv" class="btn btn-small">Students CSV</a>
          <a href="/admin/export/payments.csv" class="btn btn-small">Payments CSV</a>
        </div>
      </div>
    </div>
  </section>
</main>

<footer>Created by Pulindu Pansilu</footer>

<!-- PAYMENT MODAL -->
<div class="modal-backdrop" id="payment-modal">
  <div class="modal">
    <div class="flex-between" style="margin-bottom:.15rem;">
      <h3>Record payment</h3>
      <button type="button" class="btn btn-outline btn-small" id="payment-close-btn">Close</button>
    </div>
    <div class="muted" id="payment-student-label"></div>
    <form id="payment-form" style="margin-top:.6rem;">
      <input type="hidden" id="payment-student-id" />
      <input type="hidden" id="payment-class-id" />
      <div class="input-row">
        <div class="field"><label>Month</label><input type="month" id="payment-month" required /></div>
        <div class="field"><label>Amount</label><input type="text" id="payment-amount" required /></div>
      </div>
      <div class="input-row">
        <div class="field">
          <label>Method</label>
          <select id="payment-method" required>
            <option value="cash">Cash</option>
            <option value="bank">Bank</option>
            <option value="online">Online</option>
          </select>
        </div>
      </div>
      <div class="flex-between">
        <div class="muted" id="payment-status"></div>
        <button class="btn btn-small">Save payment</button>
      </div>
    </form>
  </div>
</div>

<script>
// basic helpers
const apiGet = u => fetch(u).then(r=>{if(!r.ok)throw new Error("Request failed");return r.json();});
const apiPost = (u,b)=>fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})})
  .then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d;});
const apiPut = (u,b)=>fetch(u,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})})
  .then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d;});
const apiDelete = u=>fetch(u,{method:"DELETE"}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d;});

const getCurrentMonthStr=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");};
const getTodayStr=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};

// nav / tabs
const navButtons=document.querySelectorAll(".nav-btn");
const tabs=document.querySelectorAll(".tab-section");
let activeTab="students";
navButtons.forEach(btn=>{
  btn.addEventListener("click",()=>{
    const tab=btn.dataset.tab;
    if(tab===activeTab)return;
    activeTab=tab;
    navButtons.forEach(b=>b.classList.toggle("active",b===btn));
    tabs.forEach(s=>s.classList.toggle("active",s.id==="tab-"+tab));
    if(tab==="scanner")initScanner();else stopScanner();
  });
});

// students
const studentForm=document.getElementById("student-form");
const studentIdInput=document.getElementById("student-id");
const studentNameInput=document.getElementById("student-name");
const studentPhoneInput=document.getElementById("student-phone");
const studentGradeInput=document.getElementById("student-grade");
const studentFreeInput=document.getElementById("student-free");
const studentStatus=document.getElementById("student-form-status");
const studentResetBtn=document.getElementById("student-reset-btn");
const studentSubmitBtn=document.getElementById("student-submit-btn");
const studentsTableBody=document.getElementById("students-table-body");
const studentsCountPill=document.getElementById("students-count-pill");
const statTotalStudents=document.getElementById("stat-total-students");
const statFreeStudents=document.getElementById("stat-free-students");
const statMonthRevenue=document.getElementById("stat-month-revenue");
let cachedClasses=[];let lastScanInfo=null;

function resetStudentForm(){
  studentIdInput.value="";studentNameInput.value="";studentPhoneInput.value="";
  studentGradeInput.value="";studentFreeInput.checked=false;studentStatus.textContent="";
  studentSubmitBtn.textContent="Add student";
}
studentResetBtn.addEventListener("click",resetStudentForm);

studentForm.addEventListener("submit",async e=>{
  e.preventDefault();
  const payload={
    name:studentNameInput.value.trim(),
    phone:studentPhoneInput.value.trim(),
    grade:studentGradeInput.value,
    is_free:studentFreeInput.checked?1:0
  };
  if(!payload.name||!payload.grade){studentStatus.textContent="Name and class are required.";return;}
  try{
    if(studentIdInput.value){
      await apiPut("/api/students/"+encodeURIComponent(studentIdInput.value),payload);
      studentStatus.textContent="Student updated.";
    }else{
      await apiPost("/api/students",payload);
      studentStatus.textContent="Student added.";
    }
    await refreshStudents();await refreshStats();
    studentSubmitBtn.textContent="Add student";studentIdInput.value="";
  }catch(err){studentStatus.textContent=err.message||"Error saving student.";}
});

async function refreshClasses(){
  try{cachedClasses=(await apiGet("/api/classes")).classes||[];}catch(e){console.error(e);}
}
const classIdForGrade=g=>{const c=cachedClasses.find(c=>c.title===g);return c?c.id:null;};

async function refreshStudents(){
  try{
    const students=(await apiGet("/api/students")).students||[];
    studentsTableBody.innerHTML="";let free=0;
    students.forEach(s=>{
      if(s.is_free)free++;
      const tr=document.createElement("tr");
      const tdName=document.createElement("td");tdName.textContent=s.name;
      const tdPhone=document.createElement("td");tdPhone.textContent=s.phone||"-";
      const tdGrade=document.createElement("td");tdGrade.textContent=s.grade;
      const tdFree=document.createElement("td");tdFree.innerHTML=s.is_free?'<span class="tag tag-free">FREE</span>':"";
      const tdQR=document.createElement("td");
      const qrLink=document.createElement("a");
      qrLink.href="/students/"+s.id+"/qr";qrLink.target="_blank";
      qrLink.className="btn btn-outline btn-small";qrLink.textContent="QR";tdQR.appendChild(qrLink);
      const tdActions=document.createElement("td");
      const edit=document.createElement("button");
      edit.type="button";edit.className="btn btn-outline btn-small";edit.textContent="Edit";
      edit.onclick=()=>{
        studentIdInput.value=s.id;studentNameInput.value=s.name;
        studentPhoneInput.value=s.phone||"";studentGradeInput.value=s.grade;
        studentFreeInput.checked=!!s.is_free;studentSubmitBtn.textContent="Save changes";studentStatus.textContent="";
      };
      const del=document.createElement("button");
      del.type="button";del.className="btn btn-outline btn-small";del.style.marginLeft=".25rem";del.textContent="Delete";
      del.onclick=async()=>{
        if(!confirm("Delete this student and all records?"))return;
        try{await apiDelete("/api/students/"+s.id);await refreshStudents();await refreshStats();}
        catch(e){alert("Delete failed: "+(e.message||""));}
      };
      tdActions.append(edit,del);
      tr.append(tdName,tdPhone,tdGrade,tdFree,tdQR,tdActions);
      studentsTableBody.appendChild(tr);
    });
    const total=students.length;
    studentsCountPill.textContent=total+" student"+(total===1?"":"s");
    statTotalStudents.textContent=total;statFreeStudents.textContent=free;
  }catch(e){console.error(e);}
}
async function refreshStats(){
  try{
    const d=await apiGet("/api/finance?month="+encodeURIComponent(getCurrentMonthStr()));
    statMonthRevenue.textContent=d.total||0;
  }catch(e){console.error(e);}
}

// scanner (BarcodeDetector + camera)
const scanNotice=document.getElementById("scan-notice");
const scannerLastDetails=document.getElementById("scanner-last-details");
const scannerPaymentBtn=document.getElementById("scanner-payment-btn");
const scannerManualForm=document.getElementById("scanner-manual-form");
const scannerManualPhone=document.getElementById("scanner-manual-phone");
const scannerManualStatus=document.getElementById("scanner-manual-status");
let videoElem=null,videoStream=null,scanCanvas=null,scanCtx=null,scanLoop=null,isProcessingScan=false;
const barcodeSupported="BarcodeDetector" in window;
const barcodeDetector=barcodeSupported?new BarcodeDetector({formats:["qr_code"]}):null;

function setScanNotice(type,msg,tag){
  if(!scanNotice)return;
  scanNotice.classList.remove("ok","err");
  if(type==="ok")scanNotice.classList.add("ok");
  if(type==="err")scanNotice.classList.add("err");
  const d=scanNotice.querySelector("div");if(d)d.innerHTML="<strong>"+msg+"</strong>";
  const t=scanNotice.querySelector(".tag");if(t&&tag)t.textContent=tag.toUpperCase();
}
function playBeep(){
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const osc=ctx.createOscillator(),g=ctx.createGain();
    osc.connect(g);g.connect(ctx.destination);
    osc.frequency.value=880;g.gain.setValueAtTime(.0001,ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(.4,ctx.currentTime+.01);
    g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.18);
    osc.start();osc.stop(ctx.currentTime+.2);
  }catch(e){}
}
function updateLastAttendanceView(res){
  const s=res.student;
  const paidLabel=s.is_free?"FREE CARD":(res.paid?"PAID":"UNPAID");
  const cls=s.is_free?"tag-free":(res.paid?"tag-paid":"tag-unpaid");
  scannerLastDetails.innerHTML=
    "<div class='pill pill-quiet'>Name: <strong>"+s.name+"</strong></div>"+
    "<div class='pill pill-quiet'>Phone: "+(s.phone||"-")+"</div>"+
    "<div class='pill pill-quiet'>Class: "+s.grade+"</div>"+
    "<div class='pill pill-quiet'>Today: "+res.date+"</div>"+
    "<div style='margin-top:.4rem;'><span class='tag "+cls+"'>"+paidLabel+" · "+res.month+"</span></div>";
}
function refreshAttendanceIfMatches(grade,date){
  const tab=document.getElementById("tab-attendance");
  if(!tab.classList.contains("active"))return;
  if(attClassInput.value===grade && attDateInput.value===date){
    attLoadForm.dispatchEvent(new Event("submit"));
  }
}
function refreshFinanceAndUnpaidCurrentMonth(){
  const m=getCurrentMonthStr();
  if(unpaidMonthInput.value===m)unpaidForm.dispatchEvent(new Event("submit"));
  if(financeMonthInput.value===m)financeForm.dispatchEvent(new Event("submit"));
}

const onScanSuccess=async decoded=>{
  let token=(decoded||"").trim();
  try{
    const idx=token.lastIndexOf("/scan/");
    if(idx!==-1)token=token.substring(idx+"/scan/".length);
    else token=token.split("/").pop();
  }catch(e){}
  if(!token){setScanNotice("err","Invalid QR.","ERROR");return;}
  setScanNotice("ok","Processing scan…","WORKING");
  try{
    const res=await apiPost("/scan/"+encodeURIComponent(token)+"/auto",{});
    playBeep();
    lastScanInfo={student_id:res.student.id,class_id:res.class_id,name:res.student.name,grade:res.student.grade,is_free:res.student.is_free,paid:res.paid,month:res.month};
    updateLastAttendanceView(res);
    const label=res.student.is_free?"FREE CARD":(res.paid?"PAID":"UNPAID");
    setScanNotice("ok","Attendance recorded for "+res.student.name+".",label);
    scannerPaymentBtn.disabled=!!res.student.is_free;
    refreshAttendanceIfMatches(res.student.grade,res.date);
    refreshFinanceAndUnpaidCurrentMonth();
  }catch(e){setScanNotice("err",e.message||"Scan failed.","ERROR");}
};
const onScanFailure=()=>{};
function startScanLoop(){
  if(!barcodeSupported||!videoElem)return;
  if(!scanCanvas){scanCanvas=document.createElement("canvas");scanCtx=scanCanvas.getContext("2d");}
  if(scanLoop)cancelAnimationFrame(scanLoop);
  const loop=async()=>{
    if(!videoElem||videoElem.readyState<2||!barcodeSupported||!barcodeDetector){scanLoop=requestAnimationFrame(loop);return;}
    try{
      if(!isProcessingScan){
        scanCanvas.width=videoElem.videoWidth;
        scanCanvas.height=videoElem.videoHeight;
        scanCtx.drawImage(videoElem,0,0,scanCanvas.width,scanCanvas.height);
        const codes=await barcodeDetector.detect(scanCanvas);
        if(codes.length>0){
          isProcessingScan=true;
          onScanSuccess(codes[0].rawValue).finally(()=>setTimeout(()=>{isProcessingScan=false;},800));
        }
      }
    }catch(e){onScanFailure(e);}
    scanLoop=requestAnimationFrame(loop);
  };
  scanLoop=requestAnimationFrame(loop);
}
function initScanner(){
  const container=document.getElementById("qr-reader");
  if(!container)return;
  if(!barcodeSupported||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    setScanNotice("err","QR scanning not supported in this browser.","ERROR");return;
  }
  if(videoStream)return; // already running
  container.innerHTML="";
  videoElem=document.createElement("video");
  videoElem.setAttribute("autoplay",true);
  videoElem.setAttribute("playsinline",true);
  videoElem.muted=true;
  videoElem.style.width="100%";
  container.appendChild(videoElem);
  navigator.mediaDevices.getUserMedia({video:{facingMode:"environment"}})
    .then(stream=>{
      videoStream=stream;videoElem.srcObject=stream;
      setScanNotice("ok","Scanner ready. Point a QR.","READY");
      startScanLoop();
    })
    .catch(err=>{
      console.error(err);
      setScanNotice("err","Unable to start camera: "+err.message,"ERROR");
    });
}
function stopScanner(){
  if(videoStream){
    videoStream.getTracks().forEach(t=>t.stop());
    videoStream=null;
  }
  if(scanLoop)cancelAnimationFrame(scanLoop);
  scanLoop=null;isProcessingScan=false;
  const container=document.getElementById("qr-reader");
  if(container)container.innerHTML="";
}
scannerPaymentBtn.addEventListener("click",()=>{
  if(!lastScanInfo||lastScanInfo.is_free)return;
  openPaymentModal({student_id:lastScanInfo.student_id,class_id:lastScanInfo.class_id,name:lastScanInfo.name,month:lastScanInfo.month});
});
scannerManualForm.addEventListener("submit",async e=>{
  e.preventDefault();
  const phone=scannerManualPhone.value.trim();
  if(!phone){scannerManualStatus.textContent="Phone is required.";return;}
  try{
    const res=await apiPost("/api/attendance/manual-today-by-phone",{phone});
    playBeep();scannerManualStatus.textContent="Marked for today.";scannerManualPhone.value="";
    lastScanInfo={student_id:res.student.id,class_id:res.class_id,name:res.student.name,grade:res.student.grade,is_free:res.student.is_free,paid:res.paid,month:res.month};
    updateLastAttendanceView(res);
    const label=res.student.is_free?"FREE CARD":(res.paid?"PAID":"UNPAID");
    setScanNotice("ok","Attendance recorded for "+res.student.name+" (manual).",label);
    scannerPaymentBtn.disabled=!!res.student.is_free;
    refreshAttendanceIfMatches(res.student.grade,res.date);
    refreshFinanceAndUnpaidCurrentMonth();
  }catch(err){
    scannerManualStatus.textContent=err.message||"Failed to mark.";
    setScanNotice("err",err.message||"Manual mark failed.","ERROR");
  }
});

// attendance view (no manual here)
const attLoadForm=document.getElementById("attendance-load-form");
const attClassInput=document.getElementById("attendance-class");
const attDateInput=document.getElementById("attendance-date");
const attInfo=document.getElementById("attendance-sheet-info");
const attTableBody=document.getElementById("attendance-table-body");
attDateInput.value=getTodayStr();

attLoadForm.addEventListener("submit",async e=>{
  e.preventDefault();
  const grade=attClassInput.value,date=attDateInput.value;
  if(!grade||!date)return;
  try{
    const classId=classIdForGrade(grade);if(!classId)throw new Error("Class not found.");
    const records=(await apiGet("/api/attendance/list?class_id="+encodeURIComponent(classId)+"&date="+encodeURIComponent(date))).records||[];
    attTableBody.innerHTML="";
    records.forEach(r=>{
      const tr=document.createElement("tr");
      tr.innerHTML=
        "<td>"+r.name+"</td>"+
        "<td>"+(r.phone||"-")+"</td>"+
        "<td>"+(r.is_free?"<span class='tag tag-free'>FREE</span>":"")+"</td>"+
        "<td>"+(r.present?"<span class='tag tag-paid'>PRESENT</span>":"<span class='tag tag-unpaid'>ABSENT</span>")+"</td>";
      attTableBody.appendChild(tr);
    });
    attInfo.textContent="Loaded "+records.length+" students for "+grade+" on "+date+".";
  }catch(err){attInfo.textContent=err.message||"Failed to load.";}
});

// unpaid
const unpaidForm=document.getElementById("unpaid-form");
const unpaidMonthInput=document.getElementById("unpaid-month");
const unpaidClassInput=document.getElementById("unpaid-class");
const unpaidInfo=document.getElementById("unpaid-info");
const unpaidTableBody=document.getElementById("unpaid-table-body");
unpaidMonthInput.value=getCurrentMonthStr();

unpaidForm.addEventListener("submit",async e=>{
  e.preventDefault();
  const month=unpaidMonthInput.value,grade=unpaidClassInput.value;
  if(!month)return;
  try{
    let url="/api/unpaid?month="+encodeURIComponent(month);
    if(grade)url+="&grade="+encodeURIComponent(grade);
    const items=(await apiGet(url)).unpaid||[];
    unpaidTableBody.innerHTML="";
    items.forEach(it=>{
      const tr=document.createElement("tr");
      const btn=document.createElement("button");
      btn.type="button";btn.className="btn btn-outline btn-small";btn.textContent="Record payment";
      btn.onclick=()=>openPaymentModal({student_id:it.student_id,class_id:it.class_id,name:it.name,month});
      const act=document.createElement("td");act.appendChild(btn);
      tr.innerHTML=
        "<td>"+it.class_title+"</td>"+
        "<td>"+it.name+"</td>"+
        "<td>"+(it.phone||"-")+"</td>"+
        "<td>2000</td>";
      tr.appendChild(act);unpaidTableBody.appendChild(tr);
    });
    const cnt=items.length,expected=cnt*2000;
    unpaidInfo.textContent=cnt+" unpaid for "+month+(grade?" in "+grade:"")+". Expected "+expected+" LKR.";
  }catch(err){unpaidInfo.textContent=err.message||"Failed to load unpaid.";}
});

// finance
const financeForm=document.getElementById("finance-form");
const financeMonthInput=document.getElementById("finance-month");
const financeInfo=document.getElementById("finance-info");
const financeTableBody=document.getElementById("finance-table-body");
financeMonthInput.value=getCurrentMonthStr();

financeForm.addEventListener("submit",async e=>{
  e.preventDefault();
  const month=financeMonthInput.value;if(!month)return;
  try{
    const d=await apiGet("/api/finance?month="+encodeURIComponent(month));
    financeTableBody.innerHTML="";
    (d.rows||[]).forEach(r=>{
      const tr=document.createElement("tr");
      tr.innerHTML="<td>"+r.class_title+"</td><td>"+r.payments+"</td><td>"+r.total+"</td>";
      financeTableBody.appendChild(tr);
    });
    financeInfo.textContent="Total revenue for "+month+": "+(d.total||0)+" LKR.";
  }catch(err){financeInfo.textContent=err.message||"Failed to load finance.";}
});

// payment modal
const paymentModal=document.getElementById("payment-modal");
const paymentCloseBtn=document.getElementById("payment-close-btn");
const paymentLabel=document.getElementById("payment-student-label");
const paymentForm=document.getElementById("payment-form");
const paymentStudentId=document.getElementById("payment-student-id");
const paymentClassId=document.getElementById("payment-class-id");
const paymentMonth=document.getElementById("payment-month");
const paymentAmount=document.getElementById("payment-amount");
const paymentMethod=document.getElementById("payment-method");
const paymentStatus=document.getElementById("payment-status");

function openPaymentModal(o){
  paymentStudentId.value=o.student_id;
  paymentClassId.value=o.class_id;
  paymentLabel.textContent="For "+(o.name||"student");
  paymentMonth.value=o.month||getCurrentMonthStr();
  paymentAmount.value="2000";paymentMethod.value="cash";paymentStatus.textContent="";
  paymentModal.classList.add("active");
}
function closePaymentModal(){paymentModal.classList.remove("active");}
paymentCloseBtn.onclick=closePaymentModal;
paymentModal.addEventListener("click",e=>{if(e.target===paymentModal)closePaymentModal();});

paymentForm.addEventListener("submit",async e=>{
  e.preventDefault();
  const payload={
    student_id:Number(paymentStudentId.value),
    class_id:Number(paymentClassId.value),
    month:paymentMonth.value,
    amount:Number(paymentAmount.value.replace(/[^0-9]/g,""))||0,
    method:paymentMethod.value
  };
  if(!payload.student_id||!payload.class_id||!payload.month||!payload.amount||!payload.method){
    paymentStatus.textContent="All fields required.";return;
  }
  try{
    await apiPost("/api/payments/record",payload);
    paymentStatus.textContent="Payment saved.";
    await refreshStats();refreshFinanceAndUnpaidCurrentMonth();
  }catch(err){paymentStatus.textContent=err.message||"Failed to save.";}
});

// settings db info
const dbInfoBtn=document.getElementById("db-info-btn");
const dbInfoText=document.getElementById("db-info-text");
dbInfoBtn.addEventListener("click",async()=>{
  try{
    const i=await apiGet("/admin/db/info");
    dbInfoText.textContent="Size: "+i.size_kb+" KB · Students: "+i.students+
      " · Payments: "+i.payments+" · Attendance: "+i.attendance;
  }catch(err){dbInfoText.textContent=err.message||"Failed to load DB info.";}
});

// periodic lightweight refresh (pseudo real-time)
setInterval(()=>{
  if(activeTab==="students")refreshStudents();
  if(activeTab==="unpaid")unpaidForm.dispatchEvent(new Event("submit"));
  if(activeTab==="finance")financeForm.dispatchEvent(new Event("submit"));
},30000);

// init
(async()=>{
  await refreshClasses();await refreshStudents();await refreshStats();
  unpaidForm.dispatchEvent(new Event("submit"));
  financeForm.dispatchEvent(new Event("submit"));
})();
</script>
</body>
</html>`;

// ---------- ROUTES ----------

// SPA
app.get("/", (req, res) => res.type("html").send(FRONTEND_HTML));

// health
app.get("/healthz", (req, res) => res.json({ ok: true }));

// DB admin
app.get("/admin/db/download", (req, res) => res.download(DB_FILE, "class_manager.db"));
app.get("/admin/db/info", (req, res) => {
  try {
    const st = fs.statSync(DB_FILE);
    const size_kb = Math.round(st.size / 1024);
    const students = db.prepare("SELECT COUNT(*) c FROM students").get().c;
    const payments = db.prepare("SELECT COUNT(*) c FROM payments").get().c;
    const attendance = db.prepare("SELECT COUNT(*) c FROM attendance").get().c;
    res.json({ path: DB_FILE, size_kb, students, payments, attendance });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to get DB info" });
  }
});
app.get("/admin/export/students.csv", (req, res) => {
  try {
    const rows = db.prepare("SELECT id,name,phone,grade,is_free,qr_token FROM students ORDER BY id").all();
    let csv = "id,name,phone,grade,is_free,qr_token\n";
    for (const r of rows) {
      csv += [
        r.id,
        JSON.stringify(r.name || ""),
        JSON.stringify(r.phone || ""),
        JSON.stringify(r.grade || ""),
        r.is_free ? 1 : 0,
        JSON.stringify(r.qr_token || "")
      ].join(",") + "\n";
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="students.csv"');
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed to export students");
  }
});
app.get("/admin/export/payments.csv", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id,p.student_id,s.name student_name,s.phone,s.grade,
             p.class_id,c.title class_title,p.month,p.amount,p.method,p.created_at
      FROM payments p
      JOIN students s ON s.id=p.student_id
      JOIN classes c ON c.id=p.class_id
      ORDER BY p.month DESC,c.id,s.name
    `).all();
    let csv = "id,student_id,student_name,phone,grade,class_id,class_title,month,amount,method,created_at\n";
    for (const r of rows) {
      csv += [
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
      ].join(",") + "\n";
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="payments.csv"');
    res.send(csv);
  } catch (e) {
    console.error(e);
    res.status(500).send("Failed to export payments");
  }
});

// classes
app.get("/api/classes", (req, res) => {
  try {
    res.json({ classes: db.prepare("SELECT id,title,fee FROM classes ORDER BY id").all() });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to load classes" });
  }
});

// students
app.get("/api/students", (req, res) => {
  try {
    res.json({
      students: db.prepare("SELECT id,name,phone,grade,is_free,qr_token FROM students ORDER BY name").all()
    });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to load students" });
  }
});
app.post("/api/students", (req, res) => {
  try {
    const { name, phone, grade, is_free } = req.body || {};
    if (!name || !grade) return res.status(400).json({ error: "Name and grade are required" });
    const qr_token = generateQrToken();
    const info = db.prepare(
      "INSERT INTO students (name,phone,grade,qr_token,is_free) VALUES (?,?,?,?,?)"
    ).run(name.trim(), (phone || "").trim(), grade, qr_token, is_free ? 1 : 0);
    const student = db.prepare("SELECT id,name,phone,grade,qr_token,is_free FROM students WHERE id=?")
      .get(info.lastInsertRowid);
    res.json({ student });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to add student" });
  }
});
app.put("/api/students/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });
    const ex = db.prepare("SELECT * FROM students WHERE id=?").get(id);
    if (!ex) return res.status(404).json({ error: "Student not found" });
    const { name, phone, grade, is_free } = req.body || {};
    if (!name || !grade) return res.status(400).json({ error: "Name and grade are required" });
    db.prepare("UPDATE students SET name=?,phone=?,grade=?,is_free=? WHERE id=?")
      .run(name.trim(), (phone || "").trim(), grade, is_free ? 1 : 0, id);
    const student = db.prepare("SELECT id,name,phone,grade,qr_token,is_free FROM students WHERE id=?")
      .get(id);
    res.json({ student });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to update student" });
  }
});
app.delete("/api/students/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid id" });
    db.prepare("DELETE FROM students WHERE id=?").run(id);
    res.json({ success: true });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to delete student" });
  }
});

// QR page: only name + grade + QR
app.get("/students/:id/qr", (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).send("Invalid id");
    const s = db.prepare("SELECT id,name,grade,qr_token FROM students WHERE id=?").get(id);
    if (!s) return res.status(404).send("Not found");
    const token = s.qr_token || generateQrToken();
    if (!s.qr_token) db.prepare("UPDATE students SET qr_token=? WHERE id=?").run(token, id);
    const qrContent = `${req.protocol}://${req.get("host")}/scan/${token}`;
    QRCode.toDataURL(qrContent, { margin: 2, scale: 8 }, (err, url) => {
      if (err) { console.error(err); return res.status(500).send("QR error"); }
      const html = `<!doctype html><html><head><meta charset="utf-8" />
<title>QR | ${s.name}</title>
<style>
body{font-family:system-ui,sans-serif;text-align:center;padding:20px;background:#020617;color:#e5e7eb;}
.card{display:inline-block;padding:20px;border-radius:16px;background:#0f172a;border:1px solid #1f2937;}
button{padding:8px 14px;border-radius:999px;border:1px solid #3b82f6;background:#1d4ed8;color:#e5e7eb;cursor:pointer;margin-top:12px;}
img{background:#fff;padding:10px;border-radius:12px;}
</style></head><body>
<div class="card">
  <h2>${s.name}</h2>
  <p>${s.grade}</p>
  <img src="${url}" alt="QR" />
  <div><button onclick="window.print()">Print</button></div>
</div>
</body></html>`;
      res.type("html").send(html);
    });
  } catch (e) {
    console.error(e);res.status(500).send("Error");
  }
});

// scan auto
app.post("/scan/:token/auto", (req, res) => {
  try {
    const token = req.params.token;
    if (!token) return res.status(400).json({ error: "Missing token" });
    const s = db.prepare("SELECT id,name,phone,grade,is_free FROM students WHERE qr_token=?").get(token);
    if (!s) return res.status(404).json({ error: "Student not found" });
    const cls = getClassByGrade(s.grade);
    if (!cls) return res.status(500).json({ error: "Class not found" });
    const date = getTodayDate();
    const month = getCurrentMonth();
    db.prepare(`
      INSERT INTO attendance (student_id,class_id,date,present)
      VALUES (?,?,?,1)
      ON CONFLICT(student_id,class_id,date) DO UPDATE SET present=1
    `).run(s.id, cls.id, date);
    const pay = db.prepare("SELECT id FROM payments WHERE student_id=? AND class_id=? AND month=?")
      .get(s.id, cls.id, month);
    res.json({ status: "ok", date, month, student: s, class_id: cls.id, paid: !!pay });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to process scan" });
  }
});

// attendance
app.get("/api/attendance/list", (req, res) => {
  try {
    const class_id = Number(req.query.class_id);
    const date = req.query.date;
    if (!class_id || !date) return res.status(400).json({ error: "class_id and date required" });
    const records = db.prepare(`
      SELECT s.id student_id,s.name,s.phone,s.is_free,
             CASE WHEN a.id IS NULL THEN 0 ELSE a.present END present
      FROM students s
      JOIN classes c ON c.title=s.grade
      LEFT JOIN attendance a
        ON a.student_id=s.id AND a.class_id=c.id AND a.date=?
      WHERE c.id=?
      ORDER BY s.name
    `).all(date, class_id);
    res.json({ records });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to load attendance" });
  }
});
app.post("/api/attendance/manual-today-by-phone", (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: "phone required" });
    const s = db.prepare("SELECT id,name,phone,grade,is_free FROM students WHERE phone=?")
      .get((phone || "").trim());
    if (!s) return res.status(404).json({ error: "Student not found for this phone" });
    const cls = getClassByGrade(s.grade);
    if (!cls) return res.status(500).json({ error: "Class not found" });
    const date = getTodayDate(), month = getCurrentMonth();
    db.prepare(`
      INSERT INTO attendance (student_id,class_id,date,present)
      VALUES (?,?,?,1)
      ON CONFLICT(student_id,class_id,date) DO UPDATE SET present=1
    `).run(s.id, cls.id, date);
    const pay = db.prepare("SELECT id FROM payments WHERE student_id=? AND class_id=? AND month=?")
      .get(s.id, cls.id, month);
    res.json({ success: true, student: s, class_id: cls.id, date, month, paid: !!pay });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to mark attendance" });
  }
});

// payments
app.post("/api/payments/record", (req, res) => {
  try {
    const { student_id, class_id, month, amount, method } = req.body || {};
    if (!student_id || !class_id || !month || !amount || !method)
      return res.status(400).json({ error: "Missing fields" });
    db.prepare(`
      INSERT INTO payments (student_id,class_id,month,amount,method)
      VALUES (?,?,?,?,?)
      ON CONFLICT(student_id,class_id,month) DO UPDATE
        SET amount=excluded.amount,method=excluded.method,created_at=datetime('now')
    `).run(student_id, class_id, month, amount, method);
    res.json({ success: true });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to record payment" });
  }
});

// unpaid
app.get("/api/unpaid", (req, res) => {
  try {
    const month = req.query.month, grade = req.query.grade;
    if (!month) return res.status(400).json({ error: "month required" });
    let sql = `
      SELECT s.id student_id,s.name,s.phone,s.grade,c.id class_id,c.title class_title
      FROM students s
      JOIN classes c ON c.title=s.grade
      WHERE s.is_free=0
        AND NOT EXISTS (
          SELECT 1 FROM payments p
          WHERE p.student_id=s.id AND p.class_id=c.id AND p.month=?
        )
    `;
    const params = [month];
    if (grade) { sql += " AND s.grade=?"; params.push(grade); }
    sql += " ORDER BY c.id,s.name";
    res.json({ unpaid: db.prepare(sql).all(...params) });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to load unpaid" });
  }
});

// finance
app.get("/api/finance", (req, res) => {
  try {
    const month = req.query.month;
    if (!month) return res.status(400).json({ error: "month required" });
    const rows = db.prepare(`
      SELECT c.id class_id,c.title class_title,
             COUNT(p.id) payments,COALESCE(SUM(p.amount),0) total
      FROM classes c
      LEFT JOIN payments p ON p.class_id=c.id AND p.month=?
      GROUP BY c.id,c.title
      ORDER BY c.id
    `).all(month);
    const total = rows.reduce((s, r) => s + (r.total || 0), 0);
    res.json({ rows, total });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to load finance" });
  }
});

// start
app.listen(PORT, () => console.log("Server listening on", PORT));
