// server.js
// Class management / payments / attendance system – single file, Railway-ready

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 5050;
// DB persisted on Railway volume mounted at /app/data
const DB_FILE = path.join("/app/data", "class_manager.db");

// ---------- DB SETUP ----------
if (!fs.existsSync(path.dirname(DB_FILE))) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
}
if (!fs.existsSync(DB_FILE)) {
  fs.closeSync(fs.openSync(DB_FILE, "w"));
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS classes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL UNIQUE,
  fee INTEGER NOT NULL DEFAULT 0 CHECK(fee>=0)
);
CREATE TABLE IF NOT EXISTS students(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  grade TEXT NOT NULL,
  qr_token TEXT UNIQUE,
  is_free INTEGER NOT NULL DEFAULT 0 CHECK(is_free IN(0,1))
);
CREATE TABLE IF NOT EXISTS attendance(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  present INTEGER NOT NULL DEFAULT 1 CHECK(present IN(0,1)),
  UNIQUE(student_id,class_id,date),
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount>=0),
  method TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(student_id,class_id,month),
  FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
  FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
);`;

let db;
function openDb() {
  db = new Database(DB_FILE);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  if (db.prepare("SELECT COUNT(*) c FROM classes").get().c === 0) {
    const ins = db.prepare("INSERT INTO classes(title,fee) VALUES(?,2000)");
    const tx = db.transaction(() => ["Grade 6", "Grade 7", "Grade 8", "O/L"].forEach(t => ins.run(t)));
    tx();
  }
}
openDb();

const genToken = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const monthStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const classByGrade = g => db.prepare("SELECT * FROM classes WHERE title=?").get(g || "");

// ---------- EXPRESS ----------
const app = express();
app.use(express.json({ limit: "20mb" }));

// ---------- FRONTEND ----------
const FRONTEND = `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Class Manager</title>
<style>
:root{color-scheme:dark;--bg:#020617;--bg2:#0f172a;--b:#1f2937;--a:#3b82f6;--a-soft:rgba(59,130,246,.12);--t:#e5e7eb;--t-soft:#9ca3af;}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;flex-direction:column;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:radial-gradient(circle at top left,#0b1120,#020617);color:var(--t);}
header{position:sticky;top:0;z-index:20;background:rgba(15,23,42,.96);backdrop-filter:blur(10px);border-bottom:1px solid var(--b);}
.header-inner{max-width:1180px;margin:0 auto;padding:.75rem 1rem;display:flex;align-items:center;justify-content:space-between;gap:.75rem;}
.logo{display:flex;align-items:center;gap:.5rem;font-weight:600;letter-spacing:.05em;font-size:1rem;}
.logo-pill{width:26px;height:26px;border-radius:999px;background:radial-gradient(circle at 25% 25%,#60a5fa,#1d4ed8);box-shadow:0 0 0 1px rgba(59,130,246,.7),0 0 16px rgba(59,130,246,.5);}
nav{display:flex;flex-wrap:wrap;gap:.4rem;}
.nav-btn{border-radius:999px;border:1px solid transparent;background:transparent;color:var(--t-soft);padding:.32rem .7rem;font-size:.75rem;display:inline-flex;align-items:center;gap:.3rem;cursor:pointer;transition:.15s;}
.nav-btn span.icon{width:18px;height:18px;border-radius:999px;border:1px solid rgba(148,163,184,.4);}
.nav-btn:hover{border-color:rgba(148,163,184,.5);background:rgba(15,23,42,.9);color:var(--t);}
.nav-btn.active{border-color:var(--a);background:var(--a-soft);box-shadow:0 0 0 1px rgba(37,99,235,.6);color:#e5e7eb;}
main{flex:1;max-width:1180px;margin:1rem auto 1.5rem;padding:0 1rem;width:100%;}
.cards{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(0,1.2fr);gap:1rem;margin-bottom:1rem;}
@media(max-width:900px){.cards{grid-template-columns:minmax(0,1fr);}}
.card{position:relative;padding:1rem;border-radius:1rem;background:rgba(15,23,42,.97);border:1px solid rgba(15,23,42,1);box-shadow:0 14px 30px rgba(0,0,0,.7),inset 0 0 0 1px rgba(148,163,184,.1);overflow:hidden;}
.card::before{content:"";position:absolute;inset:-40%;background:radial-gradient(circle at top left,rgba(59,130,246,.12),transparent 55%),radial-gradient(circle at bottom right,rgba(30,64,175,.16),transparent 55%);opacity:.9;pointer-events:none;z-index:-1;}
.card-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.55rem;gap:.5rem;}
.card-title{font-size:.9rem;text-transform:uppercase;letter-spacing:.08em;color:var(--t-soft);}
.card-subtitle{font-size:.75rem;color:var(--t-soft);}
.badge{border-radius:999px;border:1px solid rgba(148,163,184,.4);padding:.1rem .5rem;font-size:.7rem;color:var(--t-soft);display:inline-flex;align-items:center;gap:.25rem;}
.badge-dot{width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.7);}
.input-row{display:flex;flex-wrap:wrap;gap:.6rem;margin-bottom:.6rem;}
.field{flex:1 1 140px;min-width:0;}
label{font-size:.75rem;color:var(--t-soft);display:block;margin-bottom:.15rem;}
input[type=text],input[type=tel],input[type=date],input[type=month],select{width:100%;border-radius:999px;border:1px solid var(--b);background:rgba(15,23,42,.95);color:var(--t);padding:.45rem .7rem;font-size:.8rem;outline:none;transition:.12s;}
input:focus,select:focus{border-color:var(--a);box-shadow:0 0 0 1px rgba(37,99,235,.7);}
input[type=checkbox]{width:14px;height:14px;border-radius:4px;border:1px solid var(--b);background:rgba(15,23,42,.9);accent-color:var(--a);}
button,.btn{border-radius:999px;border:1px solid transparent;background:var(--a);color:#e5e7eb;padding:.43rem .9rem;font-size:.8rem;cursor:pointer;display:inline-flex;align-items:center;gap:.3rem;transition:.12s;text-decoration:none;}
button:hover,.btn:hover{background:#2563eb;box-shadow:0 12px 28px rgba(37,99,235,.55);transform:translateY(-.5px);}
.btn-outline{background:rgba(15,23,42,.9);border-color:var(--b);color:var(--t-soft);}
.btn-outline:hover{border-color:rgba(148,163,184,.85);background:rgba(15,23,42,1);color:var(--t);}
.btn-small{padding:.25rem .6rem;font-size:.7rem;}
.pill{border-radius:999px;border:1px solid var(--b);padding:.3rem .6rem;font-size:.7rem;color:var(--t-soft);}
.pill-quiet{background:rgba(15,23,42,.8);}
.notice{border-radius:.8rem;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.97);padding:.6rem .75rem;font-size:.75rem;color:var(--t-soft);display:flex;justify-content:space-between;align-items:center;gap:.75rem;margin-bottom:.6rem;}
.notice strong{color:var(--t);}
.notice.ok{border-color:rgba(52,211,153,.55);}
.notice.err{border-color:rgba(248,113,113,.75);color:#fecaca;}
.tab-section{display:none;}
.tab-section.active{display:block;}
.table-container{border-radius:.8rem;border:1px solid var(--b);background:rgba(15,23,42,.97);overflow:hidden;overflow-x:auto;max-height:480px;}
table{width:100%;border-collapse:collapse;font-size:.78rem;min-width:540px;}
thead{background:rgba(15,23,42,.96);position:sticky;top:0;z-index:5;}
th,td{padding:.45rem .6rem;border-bottom:1px solid rgba(31,41,55,.96);white-space:nowrap;text-align:left;}
th{font-size:.7rem;font-weight:500;color:var(--t-soft);text-transform:uppercase;}
tbody tr:nth-child(even){background:rgba(15,23,42,.92);}
tbody tr:hover{background:rgba(30,64,175,.24);}
.tag{border-radius:999px;border:1px solid rgba(148,163,184,.4);padding:.1rem .5rem;font-size:.65rem;text-transform:uppercase;letter-spacing:.06em;}
.tag-free{border-color:rgba(52,211,153,.7);color:#bbf7d0;}
.tag-unpaid{border-color:rgba(248,113,113,.7);color:#fecaca;}
.tag-paid{border-color:rgba(52,211,153,.7);color:#a7f3d0;}
.muted{font-size:.75rem;color:var(--t-soft);}
.flex-between{display:flex;justify-content:space-between;align-items:center;gap:.5rem;}
.flex-row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;}
.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.85);display:none;justify-content:center;align-items:center;z-index:50;padding:1rem;}
.modal-backdrop.active{display:flex;}
.modal{max-width:420px;width:100%;border-radius:1rem;background:#020617;border:1px solid var(--b);box-shadow:0 18px 42px rgba(0,0,0,.9);padding:1rem;}
.modal h3{margin:0 0 .6rem;font-size:.95rem;}
#qr-reader{width:100%;max-width:360px;border-radius:1rem;overflow:hidden;border:1px solid var(--b);margin-bottom:.7rem;background:#020617;}
footer{text-align:center;font-size:.7rem;color:var(--t-soft);padding:.75rem 1rem 1rem;border-top:1px solid rgba(15,23,42,.96);background:radial-gradient(circle at top left,rgba(15,23,42,.95),rgba(2,6,23,.99));}
@media(max-width:640px){.header-inner{flex-direction:column;align-items:stretch;}nav{justify-content:flex-start;}}
</style>
<!-- Load html5-qrcode BEFORE our app script (no defer) so it's always ready -->
<script src="https://unpkg.com/html5-qrcode@2.3.10"></script>
</head><body>
<header><div class="header-inner">
  <div class="logo"><div class="logo-pill"></div><span>Class Manager</span></div>
  <nav>
    <button class="nav-btn active" data-tab="students"><span class="icon"></span>Students</button>
    <button class="nav-btn" data-tab="scanner"><span class="icon"></span>Scanner</button>
    <button class="nav-btn" data-tab="attendance"><span class="icon"></span>Attendance</button>
    <button class="nav-btn" data-tab="unpaid"><span class="icon"></span>Unpaid</button>
    <button class="nav-btn" data-tab="finance"><span class="icon"></span>Finance</button>
    <button class="nav-btn" data-tab="settings"><span class="icon"></span>Settings</button>
  </nav>
</div></header>

<main>
<!-- STUDENTS -->
<section id="tab-students" class="tab-section active">
  <div class="cards">
    <div class="card">
      <div class="card-header"><div><div class="card-title">Students</div><div class="card-subtitle">Add / edit.</div></div><span class="badge"><span class="badge-dot"></span>Live</span></div>
      <form id="student-form">
        <input type="hidden" id="student-id">
        <div class="input-row">
          <div class="field"><label>Name</label><input id="student-name" required></div>
          <div class="field"><label>Phone</label><input id="student-phone" type="tel"></div>
        </div>
        <div class="input-row">
          <div class="field">
            <label>Class / Grade</label>
            <select id="student-grade" required>
              <option value="">Select class</option><option>Grade 6</option><option>Grade 7</option><option>Grade 8</option><option>O/L</option>
            </select>
          </div>
          <div class="field">
            <label>Free card</label>
            <div class="flex-row"><input type="checkbox" id="student-free"><span class="muted">Free-card student</span></div>
          </div>
        </div>
        <div class="flex-between">
          <div class="muted" id="student-form-status"></div>
          <div class="flex-row">
            <button type="button" class="btn btn-outline btn-small" id="student-reset-btn">Clear</button>
            <button class="btn btn-small" id="student-submit-btn">Add student</button>
          </div>
        </div>
      </form>
    </div>
    <div class="card">
      <div class="card-header"><div><div class="card-title">Quick stats</div><div class="card-subtitle">Current month.</div></div></div>
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
      <div class="flex-row">
        <a href="/students/qr/all" target="_blank" class="btn btn-small">Print all QRs</a>
        <div class="pill pill-quiet" id="students-count-pill">0 students</div>
      </div>
    </div>
    <div class="table-container"><table><thead><tr>
      <th>Name</th><th>Phone</th><th>Class</th><th>Free</th><th>QR</th><th>Actions</th>
    </tr></thead><tbody id="students-table-body"></tbody></table></div>
  </div>
</section>

<!-- SCANNER -->
<section id="tab-scanner" class="tab-section">
  <div class="cards">
    <div class="card">
      <div class="card-header"><div><div class="card-title">QR scanner</div><div class="card-subtitle">Works on phones (html5-qrcode).</div></div><span class="badge"><span class="badge-dot"></span>Camera</span></div>
      <div id="scan-notice" class="notice"><div><strong>Scanner idle.</strong> Open camera to begin.</div><div class="tag">READY</div></div>
      <div id="qr-reader"></div>
      <div class="muted">If camera doesn't start, check browser camera permission and internet access.</div>

      <form id="scanner-manual-form" style="margin-top:.75rem;">
        <div class="card-subtitle" style="margin-bottom:.35rem;">Manual attendance (phone → today)</div>
        <div class="input-row"><div class="field"><label>Phone</label><input id="scanner-manual-phone" type="tel" required></div></div>
        <div class="flex-between"><div class="muted" id="scanner-manual-status"></div><button class="btn btn-outline btn-small">Mark present</button></div>
      </form>

      <button class="btn btn-outline btn-small" id="scanner-payment-btn" disabled style="margin-top:.6rem;">Record payment for last attendance</button>
    </div>
    <div class="card">
      <div class="card-header"><div><div class="card-title">Last attendance</div><div class="card-subtitle">Auto-updated.</div></div></div>
      <div id="scanner-last-details" class="muted">No attendance yet.</div>
    </div>
  </div>
</section>

<!-- ATTENDANCE (view-only) -->
<section id="tab-attendance" class="tab-section">
  <div class="card">
    <div class="card-header"><div><div class="card-title">Attendance sheet</div><div class="card-subtitle">Class + date.</div></div></div>
    <form id="attendance-load-form">
      <div class="input-row">
        <div class="field">
          <label>Class</label>
          <select id="attendance-class" required>
            <option value="">Select class</option><option>Grade 6</option><option>Grade 7</option><option>Grade 8</option><option>O/L</option>
          </select>
        </div>
        <div class="field"><label>Date</label><input id="attendance-date" type="date" required></div>
        <div class="field" style="flex:0 0 auto;margin-top:1.2rem;"><button class="btn btn-small">Load sheet</button></div>
      </div>
    </form>
    <div class="muted" id="attendance-sheet-info"></div>
  </div>
  <div class="card">
    <div class="card-header"><div><div class="card-title">Attendance list</div><div class="card-subtitle">Updated from scans.</div></div></div>
    <div class="table-container"><table><thead><tr><th>Name</th><th>Phone</th><th>Free</th><th>Present</th></tr></thead><tbody id="attendance-table-body"></tbody></table></div>
  </div>
</section>

<!-- UNPAID -->
<section id="tab-unpaid" class="tab-section">
  <div class="card">
    <div class="card-header"><div><div class="card-title">Unpaid students</div><div class="card-subtitle">Filter by month & class.</div></div></div>
    <form id="unpaid-form">
      <div class="input-row">
        <div class="field"><label>Month</label><input id="unpaid-month" type="month" required></div>
        <div class="field">
          <label>Class (optional)</label>
          <select id="unpaid-class">
            <option value="">All classes</option><option>Grade 6</option><option>Grade 7</option><option>Grade 8</option><option>O/L</option>
          </select>
        </div>
        <div class="field" style="flex:0 0 auto;margin-top:1.2rem;"><button class="btn btn-small">Load</button></div>
      </div>
    </form>
    <div class="muted" id="unpaid-info"></div>
  </div>
  <div class="card">
    <div class="card-header"><div><div class="card-title">Unpaid list</div><div class="card-subtitle">Record payments quickly.</div></div></div>
    <div class="table-container"><table><thead><tr><th>Class</th><th>Name</th><th>Phone</th><th>Expected</th><th>Action</th></tr></thead><tbody id="unpaid-table-body"></tbody></table></div>
  </div>
</section>

<!-- FINANCE -->
<section id="tab-finance" class="tab-section">
  <div class="card">
    <div class="card-header"><div><div class="card-title">Finance overview</div><div class="card-subtitle">Monthly collections.</div></div></div>
    <form id="finance-form">
      <div class="input-row">
        <div class="field"><label>Month</label><input id="finance-month" type="month" required></div>
        <div class="field" style="flex:0 0 auto;margin-top:1.2rem;"><button class="btn btn-small">Run</button></div>
      </div>
    </form>
    <div class="muted" id="finance-info"></div>
  </div>
  <div class="card">
    <div class="card-header"><div><div class="card-title">Collections</div><div class="card-subtitle">Per class.</div></div></div>
    <div class="table-container"><table><thead><tr><th>Class</th><th>Payments</th><th>Total (LKR)</th></tr></thead><tbody id="finance-table-body"></tbody></table></div>
  </div>
</section>

<!-- SETTINGS -->
<section id="tab-settings" class="tab-section">
  <div class="cards">
    <div class="card">
      <div class="card-header"><div><div class="card-title">Database</div><div class="card-subtitle">Backup, upload & info.</div></div></div>
      <p class="muted">DB path: <code>/app/data/class_manager.db</code> (persists with Railway volume).</p>
      <div class="flex-row" style="margin-bottom:.5rem;">
        <a href="/admin/db/download" class="btn btn-small" download>Download DB</a>
        <button type="button" id="db-info-btn" class="btn btn-outline btn-small">Show DB info</button>
      </div>
      <div class="input-row">
        <div class="field"><label>Upload .db</label><input id="db-upload-file" type="file" accept=".db,.sqlite,.sqlite3"></div>
        <div class="field" style="flex:0 0 auto;margin-top:1.2rem;"><button type="button" id="db-upload-btn" class="btn btn-outline btn-small">Upload DB</button></div>
      </div>
      <div class="muted" id="db-info-text"></div>
      <div class="muted" id="db-upload-status" style="margin-top:.35rem;"></div>
    </div>
    <div class="card">
      <div class="card-header"><div><div class="card-title">Exports</div><div class="card-subtitle">CSV snapshots.</div></div></div>
      <p class="muted">Download CSV exports for reporting.</p>
      <div class="flex-row">
        <a href="/admin/export/students.csv" class="btn btn-small">Students CSV</a>
        <a href="/admin/export/payments.csv" class="btn btn-small">Payments CSV</a>
      </div>
    </div>
  </div>
</section>
</main>

<footer>Created by Pulindu Pansilu</footer>

<!-- Payment modal -->
<div class="modal-backdrop" id="payment-modal">
  <div class="modal">
    <div class="flex-between" style="margin-bottom:.15rem;"><h3>Record payment</h3><button class="btn btn-outline btn-small" id="payment-close-btn">Close</button></div>
    <div class="muted" id="payment-student-label"></div>
    <form id="payment-form" style="margin-top:.6rem;">
      <input type="hidden" id="payment-student-id"><input type="hidden" id="payment-class-id">
      <div class="input-row">
        <div class="field"><label>Month</label><input id="payment-month" type="month" required></div>
        <div class="field"><label>Amount</label><input id="payment-amount" required></div>
      </div>
      <div class="input-row">
        <div class="field"><label>Method</label>
          <select id="payment-method" required><option value="cash">Cash</option><option value="bank">Bank</option><option value="online">Online</option></select>
        </div>
      </div>
      <div class="flex-between"><div class="muted" id="payment-status"></div><button class="btn btn-small">Save payment</button></div>
    </form>
  </div>
</div>

<script>
// helpers
const jget=u=>fetch(u).then(r=>{if(!r.ok)throw new Error("Request failed");return r.json();});
const jpost=(u,b)=>fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d;});
const jput=(u,b)=>fetch(u,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d;});
const jdel=u=>fetch(u,{method:"DELETE"}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||"Request failed");return d;});
const curMonth=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");};
const today=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};

// nav
let activeTab="students";
document.querySelectorAll(".nav-btn").forEach(btn=>{
  btn.onclick=()=>{const t=btn.dataset.tab;if(t===activeTab)return;activeTab=t;
    document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b===btn));
    document.querySelectorAll(".tab-section").forEach(s=>s.classList.toggle("active",s.id==="tab-"+t));
    if(t==="scanner")initScanner();else stopScanner();
  };
});

// students
const sf=document.getElementById("student-form"),sid=document.getElementById("student-id"),sname=document.getElementById("student-name"),sphone=document.getElementById("student-phone"),sgrade=document.getElementById("student-grade"),sfree=document.getElementById("student-free"),sstatus=document.getElementById("student-form-status"),sreset=document.getElementById("student-reset-btn"),ssubmit=document.getElementById("student-submit-btn"),tbodyStudents=document.getElementById("students-table-body"),studCount=document.getElementById("students-count-pill"),statTotal=document.getElementById("stat-total-students"),statFree=document.getElementById("stat-free-students"),statRev=document.getElementById("stat-month-revenue");
let classesCache=[],lastScan=null;

function resetStudent(){sid.value="";sname.value="";sphone.value="";sgrade.value="";sfree.checked=false;sstatus.textContent="";ssubmit.textContent="Add student";}
sreset.onclick=resetStudent;

sf.onsubmit=async e=>{
  e.preventDefault();
  const p={name:sname.value.trim(),phone:sphone.value.trim(),grade:sgrade.value,is_free:sfree.checked?1:0};
  if(!p.name||!p.grade){sstatus.textContent="Name and class required.";return;}
  try{
    if(sid.value){await jput("/api/students/"+encodeURIComponent(sid.value),p);sstatus.textContent="Student updated.";}
    else{await jpost("/api/students",p);sstatus.textContent="Student added.";}
    await loadStudents();await refreshStats();sid.value="";ssubmit.textContent="Add student";
  }catch(err){sstatus.textContent=err.message||"Error.";}
};

async function loadClasses(){try{classesCache=(await jget("/api/classes")).classes||[];}catch(e){}}
const classIdFromGrade=g=>{const c=classesCache.find(c=>c.title===g);return c?c.id:null;};

async function loadStudents(){
  try{
    const list=(await jget("/api/students")).students||[];tbodyStudents.innerHTML="";let free=0;
    list.forEach(s=>{
      if(s.is_free)free++;
      const tr=document.createElement("tr");
      const tdName=document.createElement("td");tdName.textContent=s.name;
      const tdPhone=document.createElement("td");tdPhone.textContent=s.phone||"-";
      const tdGrade=document.createElement("td");tdGrade.textContent=s.grade;
      const tdFree=document.createElement("td");tdFree.innerHTML=s.is_free?'<span class="tag tag-free">FREE</span>':"";
      const tdQR=document.createElement("td");
      const qr=document.createElement("a");qr.href="/students/"+s.id+"/qr";qr.target="_blank";qr.className="btn btn-outline btn-small";qr.textContent="QR";tdQR.appendChild(qr);
      const tdAct=document.createElement("td");
      const ebtn=document.createElement("button");ebtn.type="button";ebtn.className="btn btn-outline btn-small";ebtn.textContent="Edit";
      ebtn.onclick=()=>{sid.value=s.id;sname.value=s.name;sphone.value=s.phone||"";sgrade.value=s.grade;sfree.checked=!!s.is_free;ssubmit.textContent="Save changes";sstatus.textContent="";};
      const dbtn=document.createElement("button");dbtn.type="button";dbtn.className="btn btn-outline btn-small";dbtn.style.marginLeft=".25rem";dbtn.textContent="Delete";
      dbtn.onclick=async()=>{if(!confirm("Delete this student and all their records?"))return;try{await jdel("/api/students/"+s.id);await loadStudents();await refreshStats();}catch(e){alert("Delete failed: "+(e.message||""));}};
      tdAct.append(ebtn,dbtn);
      tr.append(tdName,tdPhone,tdGrade,tdFree,tdQR,tdAct);tbodyStudents.appendChild(tr);
    });
    const total=list.length;studCount.textContent=total+" student"+(total===1?"":"s");statTotal.textContent=total;statFree.textContent=free;
  }catch(e){console.error(e);}
}
async function refreshStats(){try{const d=await jget("/api/finance?month="+encodeURIComponent(curMonth()));statRev.textContent=d.total||0;}catch(e){}}

// scanner (html5-qrcode only; simpler & works on phones)
const scanNotice=document.getElementById("scan-notice"),scanLast=document.getElementById("scanner-last-details"),scanPayBtn=document.getElementById("scanner-payment-btn"),scanManualForm=document.getElementById("scanner-manual-form"),scanManualPhone=document.getElementById("scanner-manual-phone"),scanManualStatus=document.getElementById("scanner-manual-status");
let qrInstance=null,isScanning=false;

function setScanNotice(type,msg,tag){if(!scanNotice)return;scanNotice.classList.remove("ok","err");if(type==="ok")scanNotice.classList.add("ok");if(type==="err")scanNotice.classList.add("err");scanNotice.querySelector("div").innerHTML="<strong>"+msg+"</strong>";if(tag)scanNotice.querySelector(".tag").textContent=tag.toUpperCase();}
function beep(){try{const ctx=new (window.AudioContext||window.webkitAudioContext)(),o=ctx.createOscillator(),g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=880;g.gain.setValueAtTime(.0001,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.4,ctx.currentTime+.01);g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+.18);o.start();o.stop(ctx.currentTime+.2);}catch(e){}}
function updateLastView(res){
  const s=res.student,lab=s.is_free?"FREE CARD":(res.paid?"PAID":"UNPAID"),cls=s.is_free?"tag-free":(res.paid?"tag-paid":"tag-unpaid");
  scanLast.innerHTML="<div class='pill pill-quiet'>Name: <strong>"+s.name+"</strong></div>"+
    "<div class='pill pill-quiet'>Phone: "+(s.phone||"-")+"</div>"+
    "<div class='pill pill-quiet'>Class: "+s.grade+"</div>"+
    "<div class='pill pill-quiet'>Today: "+res.date+"</div>"+
    "<div style='margin-top:.4rem;'><span class='tag "+cls+"'>"+lab+" · "+res.month+"</span></div>";
}
function maybeRefreshAttendance(grade,date){
  const tab=document.getElementById("tab-attendance");
  if(!tab.classList.contains("active"))return;
  if(attClass.value===grade && attDate.value===date){attForm.dispatchEvent(new Event("submit"));}
}
function refreshFinanceUnpaidNow(){
  const m=curMonth();
  if(unpaidMonth.value===m)unpaidForm.dispatchEvent(new Event("submit"));
  if(finMonth.value===m)financeForm.dispatchEvent(new Event("submit"));
}
async function handleScan(decoded){
  let token=(decoded||"").trim();
  try{const i=token.lastIndexOf("/scan/");if(i!==-1)token=token.slice(i+"/scan/".length);else token=token.split("/").pop();}catch(e){}
  if(!token){setScanNotice("err","Invalid QR.","ERROR");return;}
  setScanNotice("ok","Processing scan…","WORKING");
  try{
    const res=await jpost("/scan/"+encodeURIComponent(token)+"/auto",{});
    beep();lastScan={student_id:res.student.id,class_id:res.class_id,name:res.student.name,grade:res.student.grade,is_free:res.student.is_free,paid:res.paid,month:res.month};
    updateLastView(res);
    const label=res.student.is_free?"FREE CARD":(res.paid?"PAID":"UNPAID");
    setScanNotice("ok","Attendance recorded for "+res.student.name+".",label);
    scanPayBtn.disabled=!!res.student.is_free;
    maybeRefreshAttendance(res.student.grade,res.date);refreshFinanceUnpaidNow();
  }catch(e){setScanNotice("err",e.message||"Scan failed.","ERROR");}
}
function initScanner(){
  const container=document.getElementById("qr-reader");
  if(!container)return;
  if(qrInstance)return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    setScanNotice("err","Camera not supported in this browser.","ERROR");return;
  }
  if(typeof Html5Qrcode==="undefined"){
    setScanNotice("err","QR library failed to load in this page. Check internet / adblock.","ERROR");
    return;
  }
  setScanNotice("ok","Starting camera…","WORKING");
  try{
    qrInstance=new Html5Qrcode("qr-reader");
    qrInstance.start(
      {facingMode:"environment"},
      {fps:10,qrbox:{width:250,height:250}},
      text=>{
        if(isScanning)return;
        isScanning=true;
        handleScan(text).finally(()=>setTimeout(()=>{isScanning=false;},800));
      },
      ()=>{}
    ).then(()=>setScanNotice("ok","Scanner ready. Point a QR.","READY"))
     .catch(err=>{console.error(err);setScanNotice("err","Camera start failed: "+err,"ERROR");});
  }catch(e){
    console.error(e);
    setScanNotice("err","Failed to initialize scanner: "+e,"ERROR");
  }
}
function stopScanner(){
  if(qrInstance){
    const inst=qrInstance;qrInstance=null;
    inst.stop().catch(()=>{}).finally(()=>inst.clear().catch?.(()=>{}));
  }
}

scanPayBtn.onclick=()=>{if(!lastScan||lastScan.is_free)return;openPayModal({student_id:lastScan.student_id,class_id:lastScan.class_id,name:lastScan.name,month:lastScan.month});};

scanManualForm.onsubmit=async e=>{
  e.preventDefault();
  const phone=scanManualPhone.value.trim();if(!phone){scanManualStatus.textContent="Phone required.";return;}
  try{
    const res=await jpost("/api/attendance/manual-today-by-phone",{phone});
    beep();scanManualPhone.value="";scanManualStatus.textContent="Marked for today.";
    lastScan={student_id:res.student.id,class_id:res.class_id,name:res.student.name,grade:res.student.grade,is_free:res.student.is_free,paid:res.paid,month:res.month};
    updateLastView(res);const label=res.student.is_free?"FREE CARD":(res.paid?"PAID":"UNPAID");
    setScanNotice("ok","Attendance recorded for "+res.student.name+" (manual).",label);
    scanPayBtn.disabled=!!res.student.is_free;maybeRefreshAttendance(res.student.grade,res.date);refreshFinanceUnpaidNow();
  }catch(err){scanManualStatus.textContent=err.message||"Failed.";setScanNotice("err",err.message||"Manual mark failed.","ERROR");}
};

// attendance view
const attForm=document.getElementById("attendance-load-form"),attClass=document.getElementById("attendance-class"),attDate=document.getElementById("attendance-date"),attInfo=document.getElementById("attendance-sheet-info"),attBody=document.getElementById("attendance-table-body");
attDate.value=today();
attForm.onsubmit=async e=>{
  e.preventDefault();
  const g=attClass.value,d=attDate.value;if(!g||!d)return;
  try{
    const classId=classIdFromGrade(g);if(!classId)throw new Error("Class not found.");
    const recs=(await jget("/api/attendance/list?class_id="+encodeURIComponent(classId)+"&date="+encodeURIComponent(d))).records||[];
    attBody.innerHTML="";recs.forEach(r=>{
      const tr=document.createElement("tr");
      tr.innerHTML="<td>"+r.name+"</td><td>"+(r.phone||"-")+"</td><td>"+(r.is_free?"<span class='tag tag-free'>FREE</span>":"")+"</td><td>"+(r.present?"<span class='tag tag-paid'>PRESENT</span>":"<span class='tag tag-unpaid'>ABSENT</span>")+"</td>";
      attBody.appendChild(tr);
    });
    attInfo.textContent="Loaded "+recs.length+" students for "+g+" on "+d+".";
  }catch(err){attInfo.textContent=err.message||"Failed to load.";}
};

// unpaid
const unpaidForm=document.getElementById("unpaid-form"),unpaidMonth=document.getElementById("unpaid-month"),unpaidClass=document.getElementById("unpaid-class"),unpaidInfo=document.getElementById("unpaid-info"),unpaidBody=document.getElementById("unpaid-table-body");
unpaidMonth.value=curMonth();
unpaidForm.onsubmit=async e=>{
  e.preventDefault();
  const m=unpaidMonth.value,g=unpaidClass.value;if(!m)return;
  try{
    let url="/api/unpaid?month="+encodeURIComponent(m);if(g)url+="&grade="+encodeURIComponent(g);
    const rows=(await jget(url)).unpaid||[];unpaidBody.innerHTML="";
    rows.forEach(r=>{
      const tr=document.createElement("tr");
      const btn=document.createElement("button");btn.type="button";btn.className="btn btn-outline btn-small";btn.textContent="Record payment";btn.onclick=()=>openPayModal({student_id:r.student_id,class_id:r.class_id,name:r.name,month:m});
      const act=document.createElement("td");act.appendChild(btn);
      tr.innerHTML="<td>"+r.class_title+"</td><td>"+r.name+"</td><td>"+(r.phone||"-")+"</td><td>2000</td>";
      tr.appendChild(act);unpaidBody.appendChild(tr);
    });
    const count=rows.length;unpaidInfo.textContent=count+" unpaid for "+m+(g?" in "+g:"")+". Expected "+(count*2000)+" LKR.";
  }catch(err){unpaidInfo.textContent=err.message||"Failed to load unpaid.";}
};

// finance
const financeForm=document.getElementById("finance-form"),finMonth=document.getElementById("finance-month"),finInfo=document.getElementById("finance-info"),finBody=document.getElementById("finance-table-body");
finMonth.value=curMonth();
financeForm.onsubmit=async e=>{
  e.preventDefault();
  const m=finMonth.value;if(!m)return;
  try{
    const d=await jget("/api/finance?month="+encodeURIComponent(m));finBody.innerHTML="";
    (d.rows||[]).forEach(r=>{const tr=document.createElement("tr");tr.innerHTML="<td>"+r.class_title+"</td><td>"+r.payments+"</td><td>"+r.total+"</td>";finBody.appendChild(tr);});
    finInfo.textContent="Total revenue for "+m+": "+(d.total||0)+" LKR.";
  }catch(err){finInfo.textContent=err.message||"Failed to load finance.";}
};

// payment modal
const payModal=document.getElementById("payment-modal"),payClose=document.getElementById("payment-close-btn"),payLabel=document.getElementById("payment-student-label"),payForm=document.getElementById("payment-form"),payStudent=document.getElementById("payment-student-id"),payClass=document.getElementById("payment-class-id"),payMonth=document.getElementById("payment-month"),payAmt=document.getElementById("payment-amount"),payMethod=document.getElementById("payment-method"),payStatus=document.getElementById("payment-status");
function openPayModal(o){payStudent.value=o.student_id;payClass.value=o.class_id;payLabel.textContent="For "+(o.name||"student");payMonth.value=o.month||curMonth();payAmt.value="2000";payMethod.value="cash";payStatus.textContent="";payModal.classList.add("active");}
function closePayModal(){payModal.classList.remove("active");}
payClose.onclick=closePayModal;payModal.onclick=e=>{if(e.target===payModal)closePayModal();};
payForm.onsubmit=async e=>{
  e.preventDefault();
  const p={student_id:Number(payStudent.value),class_id:Number(payClass.value),month:payMonth.value,amount:Number(payAmt.value.replace(/[^0-9]/g,""))||0,method:payMethod.value};
  if(!p.student_id||!p.class_id||!p.month||!p.amount||!p.method){payStatus.textContent="All fields required.";return;}
  try{await jpost("/api/payments/record",p);payStatus.textContent="Payment saved.";await refreshStats();refreshFinanceUnpaidNow();}catch(err){payStatus.textContent=err.message||"Failed to save.";}
};

// settings DB info + upload
const dbInfoBtn=document.getElementById("db-info-btn"),dbInfoText=document.getElementById("db-info-text"),dbUploadFile=document.getElementById("db-upload-file"),dbUploadBtn=document.getElementById("db-upload-btn"),dbUploadStatus=document.getElementById("db-upload-status");
dbInfoBtn.onclick=async()=>{try{const i=await jget("/admin/db/info");dbInfoText.textContent="Size: "+i.size_kb+" KB · Students: "+i.students+" · Payments: "+i.payments+" · Attendance: "+i.attendance;}catch(err){dbInfoText.textContent=err.message||"Failed to load DB info.";}};
dbUploadBtn.onclick=async()=>{
  const f=dbUploadFile.files[0];if(!f){dbUploadStatus.textContent="Choose a .db file first.";return;}
  dbUploadStatus.textContent="Uploading…";
  try{
    const buf=new Uint8Array(await f.arrayBuffer());let bin="";for(let i=0;i<buf.length;i++)bin+=String.fromCharCode(buf[i]);const base64=btoa(bin);
    await jpost("/admin/db/upload",{data:base64});dbUploadStatus.textContent="Database uploaded. Refresh the page.";
  }catch(err){dbUploadStatus.textContent=err.message||"Upload failed.";}
};

// periodic refresh for stats/unpaid/finance
setInterval(()=>{if(activeTab==="students")loadStudents();if(activeTab==="unpaid")unpaidForm.dispatchEvent(new Event("submit"));if(activeTab==="finance")financeForm.dispatchEvent(new Event("submit"));},30000);

// boot
(async()=>{await loadClasses();await loadStudents();await refreshStats();unpaidForm.dispatchEvent(new Event("submit"));financeForm.dispatchEvent(new Event("submit"));})();
</script>
</body></html>`;

// ---------- ROUTES ----------

app.get("/", (req, res) => res.type("html").send(FRONTEND));
app.get("/healthz", (req, res) => res.json({ ok: true }));

// DB admin + upload
app.get("/admin/db/download", (req, res) => res.download(DB_FILE, "class_manager.db"));
app.get("/admin/db/info", (req, res) => {
  try {
    const st = fs.statSync(DB_FILE);
    const size_kb = Math.round(st.size / 1024);
    const students = db.prepare("SELECT COUNT(*) c FROM students").get().c;
    const payments = db.prepare("SELECT COUNT(*) c FROM payments").get().c;
    const attendance = db.prepare("SELECT COUNT(*) c FROM attendance").get().c;
    res.json({ size_kb, students, payments, attendance });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to get DB info" });
  }
});
app.post("/admin/db/upload", (req, res) => {
  try {
    const { data } = req.body || {};
    if (!data) return res.status(400).json({ error: "No data" });
    const buf = Buffer.from(data, "base64");
    if (!buf.length) return res.status(400).json({ error: "Invalid file" });
    if (db) db.close();
    fs.writeFileSync(DB_FILE, buf);
    openDb();
    res.json({ success: true });
  } catch (e) {
    console.error(e);res.status(500).json({ error: "Failed to upload DB" });
  }
});

// CSV exports
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
    res.setHeader("Content-Type","text/csv");
    res.setHeader("Content-Disposition",'attachment; filename="students.csv"');
    res.send(csv);
  } catch (e) { console.error(e);res.status(500).send("Failed"); }
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
    res.setHeader("Content-Type","text/csv");
    res.setHeader("Content-Disposition",'attachment; filename="payments.csv"');
    res.send(csv);
  } catch (e) { console.error(e);res.status(500).send("Failed"); }
});

// classes
app.get("/api/classes", (req,res)=>{
  try{res.json({classes:db.prepare("SELECT id,title,fee FROM classes ORDER BY id").all()});}
  catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});

// students CRUD
app.get("/api/students",(req,res)=>{
  try{res.json({students:db.prepare("SELECT id,name,phone,grade,is_free,qr_token FROM students ORDER BY name").all()});}
  catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});
app.post("/api/students",(req,res)=>{
  try{
    const {name,phone,grade,is_free}=req.body||{};
    if(!name||!grade)return res.status(400).json({error:"Name and grade required"});
    const token=genToken();
    const info=db.prepare("INSERT INTO students(name,phone,grade,qr_token,is_free) VALUES(?,?,?,?,?)")
      .run(name.trim(),(phone||"").trim(),grade,token,is_free?1:0);
    const s=db.prepare("SELECT id,name,phone,grade,qr_token,is_free FROM students WHERE id=?").get(info.lastInsertRowid);
    res.json({student:s});
  }catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});
app.put("/api/students/:id",(req,res)=>{
  try{
    const id=Number(req.params.id);if(!id)return res.status(400).json({error:"Invalid id"});
    const ex=db.prepare("SELECT * FROM students WHERE id=?").get(id);
    if(!ex)return res.status(404).json({error:"Not found"});
    const {name,phone,grade,is_free}=req.body||{};
    if(!name||!grade)return res.status(400).json({error:"Name and grade required"});
    db.prepare("UPDATE students SET name=?,phone=?,grade=?,is_free=? WHERE id=?")
      .run(name.trim(),(phone||"").trim(),grade,is_free?1:0,id);
    const s=db.prepare("SELECT id,name,phone,grade,qr_token,is_free FROM students WHERE id=?").get(id);
    res.json({student:s});
  }catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});
app.delete("/api/students/:id",(req,res)=>{
  try{const id=Number(req.params.id);if(!id)return res.status(400).json({error:"Invalid id"});db.prepare("DELETE FROM students WHERE id=?").run(id);res.json({success:true});}
  catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});

// QR pages (modern card)
app.get("/students/:id/qr",(req,res)=>{
  try{
    const id=Number(req.params.id);if(!id)return res.status(400).send("Invalid");
    let s=db.prepare("SELECT id,name,grade,qr_token FROM students WHERE id=?").get(id);
    if(!s)return res.status(404).send("Not found");
    let token=s.qr_token||genToken();if(!s.qr_token){db.prepare("UPDATE students SET qr_token=? WHERE id=?").run(token,id);s.qr_token=token;}
    const qrText=`${req.protocol}://${req.get("host")}/scan/${token}`;
    QRCode.toDataURL(qrText,{margin:2,scale:8},(err,url)=>{
      if(err){console.error(err);return res.status(500).send("QR error");}
      const html=`<!doctype html><html><head><meta charset="utf-8"><title>${s.name} | QR</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:flex;justify-content:center;align-items:center;background:#fff;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;color:#e2e8f0}
.wrap{padding:2px;border-radius:24px;background:linear-gradient(135deg,rgba(59,130,246,1),rgba(37,99,235,.35))}
.card{width:320px;border-radius:22px;background:#020617;padding:22px 20px 18px;text-align:center}
.name{font-size:1.3rem;font-weight:600;color:#f9fafb}
.grade{margin-top:4px;margin-bottom:18px;font-size:.9rem;color:#9ca3af}
.qr{padding:14px;border-radius:18px;border:1px solid rgba(148,163,184,.4);background:#020617;margin-bottom:18px}
.qr img{width:230px;height:230px;background:#fff;border-radius:12px}
.brand{font-size:.8rem;color:#38bdf8;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin-top:4px}
@media print{body{background:#fff}.wrap{background:none;box-shadow:none}}</style></head>
<body><div class="wrap"><div class="card">
<div class="name">${s.name}</div><div class="grade">${s.grade}</div>
<div class="qr"><img src="${url}" alt="QR"></div>
<div class="brand">Science Zone by TS</div>
</div></div></body></html>`;
      res.type("html").send(html);
    });
  }catch(e){console.error(e);res.status(500).send("Error");}
});

// all QR cards
app.get("/students/qr/all",async (req,res)=>{
  try{
    const students=db.prepare("SELECT id,name,grade,qr_token FROM students ORDER BY grade,name").all();
    const host=`${req.protocol}://${req.get("host")}`;
    const cards=[];
    for(const s of students){
      let token=s.qr_token||genToken();if(!s.qr_token)db.prepare("UPDATE students SET qr_token=? WHERE id=?").run(token,s.id);
      const qrText=`${host}/scan/${token}`;
      const url=await QRCode.toDataURL(qrText,{margin:1,scale:5});
      cards.push(`<div class="wrap"><div class="card"><div class="name">${s.name}</div><div class="grade">${s.grade}</div><div class="qr"><img src="${url}" alt="QR"></div><div class="brand">Science Zone by TS</div></div></div>`);
    }
    const html=`<!doctype html><html><head><meta charset="utf-8"><title>All QRs</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{margin:20px;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.wrap{padding:2px;border-radius:24px;background:linear-gradient(135deg,rgba(59,130,246,1),rgba(37,99,235,.35))}
.card{background:#020617;border-radius:22px;padding:18px 16px 14px;text-align:center;color:#e2e8f0}
.name{font-size:1.1rem;font-weight:600;color:#f9fafb}
.grade{font-size:.85rem;color:#9ca3af;margin-bottom:10px}
.qr{padding:10px;border-radius:16px;border:1px solid rgba(148,163,184,.45);background:#020617;margin-bottom:8px}
.qr img{width:190px;height:190px;background:#fff;border-radius:10px}
.brand{margin-top:4px;font-size:.75rem;color:#38bdf8;font-weight:600;letter-spacing:.08em;text-transform:uppercase}
@media print{body{margin:0}}</style></head>
<body><div class="grid">${cards.join("")}</div><script>window.onload=function(){window.print();}</script></body></html>`;
    res.type("html").send(html);
  }catch(e){console.error(e);res.status(500).send("Error");}
});

// scan endpoint -> mark attendance
app.post("/scan/:token/auto",(req,res)=>{
  try{
    const token=req.params.token;if(!token)return res.status(400).json({error:"Missing token"});
    const s=db.prepare("SELECT id,name,phone,grade,is_free FROM students WHERE qr_token=?").get(token);
    if(!s)return res.status(404).json({error:"Student not found"});
    const cls=classByGrade(s.grade);if(!cls)return res.status(500).json({error:"Class not found"});
    const d=todayStr(),m=monthStr();
    db.prepare("INSERT INTO attendance(student_id,class_id,date,present) VALUES(?,?,?,1) ON CONFLICT(student_id,class_id,date) DO UPDATE SET present=1").run(s.id,cls.id,d);
    const pay=db.prepare("SELECT id FROM payments WHERE student_id=? AND class_id=? AND month=?").get(s.id,cls.id,m);
    res.json({status:"ok",date:d,month:m,student:s,class_id:cls.id,paid:!!pay});
  }catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});

// attendance list
app.get("/api/attendance/list",(req,res)=>{
  try{
    const class_id=Number(req.query.class_id),date=req.query.date;
    if(!class_id||!date)return res.status(400).json({error:"class_id and date required"});
    const rows=db.prepare(`
      SELECT s.id student_id,s.name,s.phone,s.is_free,
             CASE WHEN a.id IS NULL THEN 0 ELSE a.present END present
      FROM students s
      JOIN classes c ON c.title=s.grade
      LEFT JOIN attendance a ON a.student_id=s.id AND a.class_id=c.id AND a.date=?
      WHERE c.id=? ORDER BY s.name
    `).all(date,class_id);
    res.json({records:rows});
  }catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});

// manual attendance by phone
app.post("/api/attendance/manual-today-by-phone",(req,res)=>{
  try{
    const {phone}=req.body||{};if(!phone)return res.status(400).json({error:"phone required"});
    const s=db.prepare("SELECT id,name,phone,grade,is_free FROM students WHERE phone=?").get(String(phone).trim());
    if(!s)return res.status(404).json({error:"Student not found for this phone"});
    const cls=classByGrade(s.grade);if(!cls)return res.status(500).json({error:"Class not found"});
    const d=todayStr(),m=monthStr();
    db.prepare("INSERT INTO attendance(student_id,class_id,date,present) VALUES(?,?,?,1) ON CONFLICT(student_id,class_id,date) DO UPDATE SET present=1").run(s.id,cls.id,d);
    const pay=db.prepare("SELECT id FROM payments WHERE student_id=? AND class_id=? AND month=?").get(s.id,cls.id,m);
    res.json({success:true,student:s,class_id:cls.id,date:d,month:m,paid:!!pay});
  }catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});

// payments
app.post("/api/payments/record",(req,res)=>{
  try{
    const {student_id,class_id,month,amount,method}=req.body||{};
    if(!student_id||!class_id||!month||!amount||!method)return res.status(400).json({error:"Missing fields"});
    db.prepare(`
      INSERT INTO payments(student_id,class_id,month,amount,method)
      VALUES(?,?,?,?,?)
      ON CONFLICT(student_id,class_id,month) DO UPDATE SET amount=excluded.amount,method=excluded.method,created_at=datetime('now')
    `).run(student_id,class_id,month,amount,method);
    res.json({success:true});
  }catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});

// unpaid list
app.get("/api/unpaid",(req,res)=>{
  try{
    const month=req.query.month,grade=req.query.grade;
    if(!month)return res.status(400).json({error:"month required"});
    let sql=`
      SELECT s.id student_id,s.name,s.phone,s.grade,c.id class_id,c.title class_title
      FROM students s
      JOIN classes c ON c.title=s.grade
      WHERE s.is_free=0
        AND NOT EXISTS(
          SELECT 1 FROM payments p WHERE p.student_id=s.id AND p.class_id=c.id AND p.month=?
        )`;
    const params=[month];
    if(grade){sql+=" AND s.grade=?";params.push(grade);}
    sql+=" ORDER BY c.id,s.name";
    res.json({unpaid:db.prepare(sql).all(...params)});
  }catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});

// finance
app.get("/api/finance",(req,res)=>{
  try{
    const month=req.query.month;if(!month)return res.status(400).json({error:"month required"});
    const rows=db.prepare(`
      SELECT c.id class_id,c.title class_title,
             COUNT(p.id) payments,COALESCE(SUM(p.amount),0) total
      FROM classes c LEFT JOIN payments p ON p.class_id=c.id AND p.month=?
      GROUP BY c.id,c.title ORDER BY c.id
    `).all(month);
    const total=rows.reduce((s,r)=>s+(r.total||0),0);
    res.json({rows,total});
  }catch(e){console.error(e);res.status(500).json({error:"Failed"});}
});

app.listen(PORT,()=>console.log("Server listening on",PORT));
