// server.js
// Single-file Class Management + Payment + Exam Registration System
// Backend: Node.js (CommonJS), Express, SQLite (better-sqlite3)
// Frontend: Single-page HTML+CSS+JS served from "/"

const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

// ---------- Runtime setup ----------
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "class_manager.db");
const PORT = Number(process.env.PORT || 5050);

// ---------- Database ----------
function openDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = wal");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      phone      TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      monthly_fee INTEGER NOT NULL CHECK (monthly_fee >= 0),
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      student_id  INTEGER NOT NULL,
      class_id    INTEGER NOT NULL,
      enrolled_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (student_id, class_id),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id)   REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id   INTEGER NOT NULL,
      month      TEXT    NOT NULL, -- YYYY-MM
      amount     INTEGER NOT NULL CHECK (amount >= 0),
      method     TEXT    NOT NULL DEFAULT 'cash',
      paid_at    TEXT    DEFAULT (datetime('now')),
      UNIQUE(student_id, class_id, month),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id)   REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_students_name ON students(name);
    CREATE INDEX IF NOT EXISTS idx_classes_name  ON classes(name);
    CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(month);
    CREATE INDEX IF NOT EXISTS idx_enroll_class  ON enrollments(class_id);

    -- Exam slots & bookings
    CREATE TABLE IF NOT EXISTS exam_slots (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      label      TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time   TEXT NOT NULL,
      max_seats  INTEGER NOT NULL CHECK (max_seats > 0)
    );

    CREATE TABLE IF NOT EXISTS exam_bookings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id       INTEGER NOT NULL,
      seat_index    INTEGER NOT NULL,
      seat_pos      INTEGER NOT NULL,
      student_name  TEXT NOT NULL,
      student_class TEXT NOT NULL,
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE (slot_id, seat_index, seat_pos),
      FOREIGN KEY (slot_id) REFERENCES exam_slots(id) ON DELETE CASCADE
    );
  `);

  // Seed default classes if missing
  const existingClasses = db
    .prepare("SELECT name FROM classes")
    .all()
    .map((r) => r.name);
  ["Grade 6", "Grade 7", "Grade 8", "O/L"].forEach((title) => {
    if (!existingClasses.includes(title)) {
      db.prepare(
        "INSERT INTO classes(name, monthly_fee) VALUES(?, 2000)"
      ).run(title);
    }
  });

  // Seed exam slots if missing
  const examCount = db
    .prepare("SELECT COUNT(*) AS c FROM exam_slots")
    .get().c;
  if (examCount === 0) {
    // Session 1: 2pm–5pm, 25 benches
    db.prepare(
      "INSERT INTO exam_slots(label,start_time,end_time,max_seats) VALUES (?,?,?,?)"
    ).run(
      "Session 1 – 2:00 PM to 5:00 PM",
      "2025-12-05 14:00",
      "2025-12-05 17:00",
      25
    );
    // Session 2: 5.30pm–8.30pm, 24 benches
    db.prepare(
      "INSERT INTO exam_slots(label,start_time,end_time,max_seats) VALUES (?,?,?,?)"
    ).run(
      "Session 2 – 5:30 PM to 8:30 PM",
      "2025-12-05 17:30",
      "2025-12-05 20:30",
      24
    );
  }

  return db;
}

const db = openDb();

// ---------- Helpers ----------
function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return y + "-" + m;
}

function isValidMonth(m) {
  return typeof m === "string" && /^\d{4}-\d{2}$/.test(m);
}

function toId(val, field = "id") {
  const n = Number(val);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("Invalid " + field);
  }
  return n;
}

function sendError(res, code, msg) {
  res.status(code).json({ error: msg });
}

// ---------- Prepared statements ----------
const studentStmt = {
  list: db.prepare("SELECT * FROM students ORDER BY name COLLATE NOCASE"),
  find: db.prepare("SELECT * FROM students WHERE id=?"),
  insert: db.prepare("INSERT INTO students(name,phone) VALUES(?,?)"),
  delete: db.prepare("DELETE FROM students WHERE id=?"),
};

const classStmt = {
  list: db.prepare("SELECT * FROM classes ORDER BY name COLLATE NOCASE"),
  find: db.prepare("SELECT * FROM classes WHERE id=?"),
  insert: db.prepare("INSERT INTO classes(name,monthly_fee) VALUES(?,?)"),
};

const enrollStmt = {
  enroll: db.prepare(
    "INSERT INTO enrollments(student_id,class_id) VALUES(?,?)"
  ),
  studentsInClass: db.prepare(`
    SELECT s.*
    FROM enrollments e
    JOIN students s ON s.id = e.student_id
    WHERE e.class_id=?
    ORDER BY s.name COLLATE NOCASE
  `),
};

const paymentStmt = {
  upsert: db.prepare(`
    INSERT INTO payments(student_id,class_id,month,amount,method)
    VALUES (?,?,?,?,?)
    ON CONFLICT(student_id,class_id,month)
    DO UPDATE SET amount=excluded.amount, method=excluded.method
  `),
  unpaid: db.prepare(`
    SELECT
      c.id   AS class_id,
      c.name AS class_name,
      s.id   AS student_id,
      s.name AS student_name,
      s.phone
    FROM enrollments e
    JOIN students s ON s.id = e.student_id
    JOIN classes  c ON c.id = e.class_id
    LEFT JOIN payments p
           ON p.student_id = e.student_id
          AND p.class_id   = e.class_id
          AND p.month      = ?
    WHERE p.id IS NULL
    ORDER BY c.name COLLATE NOCASE, s.name COLLATE NOCASE
  `),
  summaryByClass: db.prepare(`
    SELECT
      c.id   AS class_id,
      c.name AS class_name,
      COUNT(p.id)               AS payments_count,
      COALESCE(SUM(p.amount),0) AS total_amount
    FROM classes c
    LEFT JOIN payments p
           ON p.class_id = c.id
          AND p.month    = ?
    GROUP BY c.id
    ORDER BY c.name COLLATE NOCASE
  `),
};

const examStmt = {
  listSlots: db.prepare("SELECT * FROM exam_slots ORDER BY id"),
  findSlot: db.prepare("SELECT * FROM exam_slots WHERE id=?"),
  bookingsBySlot: db.prepare(
    "SELECT * FROM exam_bookings WHERE slot_id=? ORDER BY seat_index, seat_pos"
  ),
  insertBooking: db.prepare(`
    INSERT INTO exam_bookings(slot_id,seat_index,seat_pos,student_name,student_class)
    VALUES (?,?,?,?,?)
  `),
};

// ---------- Express app ----------
const app = express();
app.use(express.json());

// --- API: Students ---
app.get("/api/students", (req, res) => {
  res.json(studentStmt.list.all());
});

app.post("/api/students", (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const phone = (req.body.phone || "").trim() || null;
    if (!name) throw new Error("Name is required");
    const info = studentStmt.insert.run(name, phone);
    const student = studentStmt.find.get(info.lastInsertRowid);
    res.status(201).json(student);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.delete("/api/students/:id", (req, res) => {
  try {
    const id = toId(req.params.id);
    studentStmt.delete.run(id);
    res.status(204).end();
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// --- API: Classes ---
app.get("/api/classes", (req, res) => {
  res.json(classStmt.list.all());
});

app.post("/api/classes", (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const fee = Number(req.body.monthly_fee);
    if (!name) throw new Error("Class name required");
    if (!Number.isFinite(fee) || fee < 0) throw new Error("Invalid fee");
    const info = classStmt.insert.run(name, fee);
    const c = classStmt.find.get(info.lastInsertRowid);
    res.status(201).json(c);
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// --- API: Enrollments ---
app.post("/api/enrollments", (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    enrollStmt.enroll.run(student_id, class_id);
    res.status(201).json({ ok: true });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.get("/api/classes/:id/students", (req, res) => {
  try {
    const class_id = toId(req.params.id, "class_id");
    res.json(enrollStmt.studentsInClass.all(class_id));
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// --- API: Payments ---
app.post("/api/payments", (req, res) => {
  try {
    const student_id = toId(req.body.student_id, "student_id");
    const class_id = toId(req.body.class_id, "class_id");
    const month = req.body.month || monthKey();
    const amount = Number(req.body.amount);
    const method = (req.body.method || "cash").trim() || "cash";

    if (!isValidMonth(month)) throw new Error("Invalid month (YYYY-MM)");
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error("Invalid amount");

    paymentStmt.upsert.run(student_id, class_id, month, amount, method);
    res.status(201).json({ ok: true });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// --- API: Unpaid & Finance ---
app.get("/api/unpaid", (req, res) => {
  try {
    const month = req.query.month || monthKey();
    if (!isValidMonth(month)) throw new Error("Invalid month (YYYY-MM)");
    const rows = paymentStmt.unpaid.all(month);
    res.json({ month, rows });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.get("/api/finance", (req, res) => {
  try {
    const month = req.query.month || monthKey();
    if (!isValidMonth(month)) throw new Error("Invalid month (YYYY-MM)");
    const rows = paymentStmt.summaryByClass.all(month);
    const total = rows.reduce(
      function (sum, r) {
        return sum + (r.total_amount || 0);
      },
      0
    );
    res.json({ month, rows, total });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

// --- API: Exam slots & bookings ---
app.get("/api/exam/slots", (req, res) => {
  res.json(examStmt.listSlots.all());
});

app.get("/api/exam/slots/:id/layout", (req, res) => {
  try {
    const slotId = toId(req.params.id, "slot_id");
    const slot = examStmt.findSlot.get(slotId);
    if (!slot) return sendError(res, 404, "Slot not found");
    const bookings = examStmt.bookingsBySlot.all(slotId);
    res.json({
      slot: slot,
      seat_count: slot.max_seats,
      max_per_seat: 4,
      bookings: bookings,
    });
  } catch (e) {
    sendError(res, 400, e.message);
  }
});

app.post("/api/exam/book", (req, res) => {
  try {
    const slotId = toId(req.body.slot_id, "slot_id");
    const name = (req.body.student_name || "").trim();
    const sClass = (req.body.student_class || "").trim();
    const seatIndex = Number(req.body.seat_index);
    const seatPos = Number(req.body.seat_pos);

    if (!name) throw new Error("Name is required");
    if (sClass !== "Grade 7" && sClass !== "Grade 8") {
      throw new Error("Class must be Grade 7 or Grade 8");
    }

    const slot = examStmt.findSlot.get(slotId);
    if (!slot) throw new Error("Slot not found");

    if (!Number.isInteger(seatIndex) || seatIndex < 1 || seatIndex > slot.max_seats) {
      throw new Error("Invalid seat index");
    }
    if (!Number.isInteger(seatPos) || seatPos < 1 || seatPos > 4) {
      throw new Error("Invalid seat position");
    }

    examStmt.insertBooking.run(slotId, seatIndex, seatPos, name, sClass);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e && (e.code === "SQLITE_CONSTRAINT" || String(e.message).indexOf("UNIQUE") !== -1)) {
      return sendError(res, 400, "This seat position is already booked");
    }
    sendError(res, 400, e.message);
  }
});

// --- API: Health ---
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    db: DB_PATH,
    ts: new Date().toISOString(),
  });
});

// ---------- Frontend HTML ----------
const FRONTEND_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Class Management & Exam System</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    body{
      font-family:system-ui, sans-serif;
      background:#020617;
      color:#e5e7eb;
      margin:0;
    }
    .container{
      max-width:1100px;
      margin:0 auto;
      padding:1rem;
    }
    header{
      display:flex;
      flex-wrap:wrap;
      gap:.5rem;
      margin-bottom:1rem;
    }
    header button{
      border:none;
      background:#1f2937;
      color:#e5e7eb;
      padding:.4rem .9rem;
      border-radius:.6rem;
      cursor:pointer;
      font-size:.9rem;
    }
    header button.active{
      background:#2563eb;
    }
    section{display:none;margin-top:.5rem;}
    section.active{display:block;}
    .card{
      background:#020617;
      border:1px solid #1f2937;
      border-radius:.8rem;
      padding:1rem;
      margin-bottom:1rem;
    }
    input,select{
      background:#020617;
      border:1px solid #374151;
      border-radius:.4rem;
      padding:.35rem .5rem;
      color:#e5e7eb;
      width:100%;
    }
    label{font-size:.85rem;}
    table{
      width:100%;
      border-collapse:collapse;
      margin-top:.6rem;
      font-size:.85rem;
    }
    th,td{
      border-bottom:1px solid #1f2937;
      padding:.4rem;
    }
    button.primary{
      background:#2563eb;
      color:#f9fafb;
      border:none;
      border-radius:.5rem;
      padding:.4rem .9rem;
      cursor:pointer;
      font-size:.85rem;
      margin-top:.4rem;
    }
    .row{display:flex;flex-wrap:wrap;gap:.7rem;}
    .grow{flex:1 1 220px;}
    #status{
      margin-bottom:.6rem;
      font-size:.85rem;
      color:#93c5fd;
    }
    footer{
      margin-top:1.5rem;
      font-size:.8rem;
      color:#64748b;
      text-align:center;
    }
    @media(max-width:768px){
      table{display:block;overflow-x:auto;white-space:nowrap;}
      header{flex-direction:column;}
    }

    /* Exam seat layout - bench style */
    #seat-layout{
      margin-top:.6rem;
      display:flex;
      flex-direction:column;
      gap:.5rem;
      max-height:420px;
      overflow:auto;
      border:1px solid #1f2937;
      border-radius:.6rem;
      padding:.6rem .6rem 1rem;
      background:#0f172a;
    }
    .bench-row{
      display:flex;
      align-items:center;
      gap:.6rem;
    }
    .bench-label{
      width:70px;
      font-size:.8rem;
      color:#9ca3af;
    }
    .bench{
      flex:1;
      background:#78350f;
      border-radius:.4rem;
      position:relative;
      height:38px;
      display:flex;
      overflow:hidden;
    }
    .bench-segment{
      flex:1;
      position:relative;
      cursor:pointer;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:.78rem;
      color:#e5e7eb;
      border-right:1px solid rgba(15,23,42,0.7);
    }
    .bench-segment:last-child{
      border-right:none;
    }
    .bench-segment.empty{
      color:#d1d5db80;
    }
    .bench-segment.booked{
      cursor:not-allowed;
    }
    .bench-segment.booked.grade7{
      background:#1d4ed8;
    }
    .bench-segment.booked.grade8{
      background:#16a34a;
    }
    .bench-segment.selected{
      outline:2px solid #facc15;
      outline-offset:-2px;
    }
    #seat-info{
      font-size:.8rem;
      color:#e5e7eb;
      margin-top:.4rem;
    }
    #seat-legend{
      font-size:.8rem;
      color:#9ca3af;
      margin-top:.35rem;
    }
    #seat-legend span{
      display:inline-flex;
      align-items:center;
      margin-right:.7rem;
      gap:.25rem;
    }
    .legend-box{
      width:14px;
      height:14px;
      border-radius:3px;
      display:inline-block;
    }
    .legend-grade7{background:#1d4ed8;}
    .legend-grade8{background:#16a34a;}
    .legend-empty{background:#78350f;border:1px solid #111827;}
  </style>
</head>
<body>
  <div class="container">
    <h1>Class Management & Exam System</h1>
    <div id="status"></div>

    <header>
      <button data-tab="students" class="active">Students</button>
      <button data-tab="classes">Classes</button>
      <button data-tab="enrollments">Enrollments</button>
      <button data-tab="payments">Payments</button>
      <button data-tab="exam">Main Exam</button>
      <button data-tab="unpaid">Unpaid</button>
      <button data-tab="finance">Finance</button>
    </header>

    <!-- Students -->
    <section id="tab-students" class="active">
      <div class="card">
        <h2>Students</h2>
        <div class="row">
          <div class="grow">
            <label>Name<br><input id="stu-name"></label>
          </div>
          <div class="grow">
            <label>Phone<br><input id="stu-phone"></label>
          </div>
        </div>
        <button class="primary" id="btn-add-student">Add Student</button>
      </div>
      <div class="card">
        <h3>Student List</h3>
        <table id="students-table">
          <thead><tr><th>ID</th><th>Name</th><th>Phone</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- Classes -->
    <section id="tab-classes">
      <div class="card">
        <h2>Classes</h2>
        <div class="row">
          <div class="grow">
            <label>Name<br><input id="class-name" placeholder="Grade 6 / Grade 7 ..."></label>
          </div>
          <div class="grow">
            <label>Monthly fee<br><input id="class-fee" type="number" value="2000"></label>
          </div>
        </div>
        <button class="primary" id="btn-add-class">Add Class</button>
      </div>
      <div class="card">
        <h3>Class List</h3>
        <table id="classes-table">
          <thead><tr><th>ID</th><th>Name</th><th>Monthly Fee</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- Enrollments -->
    <section id="tab-enrollments">
      <div class="card">
        <h2>Enroll Student</h2>
        <div class="row">
          <div class="grow">
            <label>Student<br><select id="enroll-student"></select></label>
          </div>
          <div class="grow">
            <label>Class<br><select id="enroll-class"></select></label>
          </div>
        </div>
        <button class="primary" id="btn-enroll">Enroll</button>
      </div>
      <div class="card">
        <h3>Students in selected class</h3>
        <div class="row">
          <div class="grow">
            <label>Class<br><select id="enroll-view-class"></select></label>
          </div>
        </div>
        <table id="enroll-table">
          <thead><tr><th>ID</th><th>Name</th><th>Phone</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- Payments -->
    <section id="tab-payments">
      <div class="card">
        <h2>Record Payment</h2>
        <div class="row">
          <div class="grow">
            <label>Student<br><select id="pay-student"></select></label>
          </div>
          <div class="grow">
            <label>Class<br><select id="pay-class"></select></label>
          </div>
        </div>
        <div class="row">
          <div class="grow">
            <label>Month (YYYY-MM)<br><input id="pay-month"></label>
          </div>
          <div class="grow">
            <label>Amount<br><input id="pay-amount" type="number" value="2000"></label>
          </div>
          <div class="grow">
            <label>Method<br>
              <select id="pay-method">
                <option>cash</option>
                <option>bank</option>
                <option>online</option>
              </select>
            </label>
          </div>
        </div>
        <button class="primary" id="btn-pay">Save Payment</button>
      </div>
    </section>

    <!-- Main Exam Registration -->
    <section id="tab-exam">
      <div class="card">
        <h2>Main Exam – Seat Booking (Dec 5)</h2>
        <p style="font-size:.85rem;color:#9ca3af;">
          Only Grade 7 and Grade 8 students can register. Each bench has 4 students.
        </p>
        <div class="row">
          <div class="grow">
            <label>Session<br>
              <select id="exam-slot"></select>
            </label>
          </div>
        </div>
        <div class="row" style="margin-top:.6rem;">
          <div class="grow">
            <label>Student name<br><input id="exam-name" placeholder="Student name"></label>
          </div>
          <div class="grow">
            <label>Class<br>
              <select id="exam-class">
                <option value="">Select class</option>
                <option>Grade 7</option>
                <option>Grade 8</option>
              </select>
            </label>
          </div>
        </div>
        <button class="primary" id="btn-book-seat">Book Seat</button>
        <div id="seat-info"></div>
        <div id="seat-legend">
          <span><span class="legend-box legend-empty"></span>Empty</span>
          <span><span class="legend-box legend-grade7"></span>Grade 7</span>
          <span><span class="legend-box legend-grade8"></span>Grade 8</span>
        </div>
      </div>
      <div class="card">
        <h3>Seat Layout (4 students per bench)</h3>
        <div id="seat-layout"></div>
      </div>
    </section>

    <!-- Unpaid -->
    <section id="tab-unpaid">
      <div class="card">
        <h2>Unpaid Students</h2>
        <div class="row">
          <div class="grow">
            <label>Month (YYYY-MM)<br><input id="unpaid-month"></label>
          </div>
        </div>
        <button class="primary" id="btn-load-unpaid">Load Unpaid</button>
      </div>
      <div class="card">
        <table id="unpaid-table">
          <thead><tr><th>Class</th><th>Student</th><th>Phone</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <!-- Finance -->
    <section id="tab-finance">
      <div class="card">
        <h2>Finance Summary</h2>
        <div class="row">
          <div class="grow">
            <label>Month (YYYY-MM)<br><input id="fin-month"></label>
          </div>
        </div>
        <button class="primary" id="btn-load-finance">Load Summary</button>
      </div>
      <div class="card">
        <table id="finance-table">
          <thead><tr><th>Class</th><th>Payments</th><th>Total (Rs.)</th></tr></thead>
          <tbody></tbody>
          <tfoot><tr><td colspan="2" style="text-align:right">Total</td><td id="finance-total"></td></tr></tfoot>
        </table>
      </div>
    </section>

    <footer>Created by Pulindu Pansilu</footer>
  </div>

<script>
(function(){
  function $(id){return document.getElementById(id);}
  var statusEl = $("status");

  function setStatus(msg,isError){
    statusEl.textContent = msg || "";
    statusEl.style.color = isError ? "#fca5a5" : "#93c5fd";
    if(isError && msg){console.error(msg);}
  }

  function api(url, options){
    options = options || {};
    options.headers = options.headers || {};
    if(options.body && typeof options.body !== "string"){
      options.body = JSON.stringify(options.body);
    }
    options.headers["Content-Type"] = "application/json";
    return fetch(url, options).then(function(res){
      return res.json().then(function(data){
        if(!res.ok){
          throw new Error(data.error || ("HTTP " + res.status));
        }
        return data;
      }).catch(function(){
        if(!res.ok){throw new Error("HTTP " + res.status);}
        return {};
      });
    });
  }

  function switchTab(tabId){
    var buttons = document.querySelectorAll("header button");
    for(var i=0;i<buttons.length;i++){
      var b=buttons[i];
      b.classList.toggle("active", b.getAttribute("data-tab") === tabId);
    }
    var sections = document.querySelectorAll("section");
    for(var j=0;j<sections.length;j++){
      var s=sections[j];
      s.classList.toggle("active", s.id === "tab-" + tabId);
    }
  }

  var navButtons = document.querySelectorAll("header button");
  for(var i=0;i<navButtons.length;i++){
    navButtons[i].addEventListener("click", function(){
      switchTab(this.getAttribute("data-tab"));
    });
  }

  // ----- Students -----
  function loadStudents(){
    return api("/api/students").then(function(data){
      var tbody = $("students-table").querySelector("tbody");
      var html = "";
      data.forEach(function(s){
        html += "<tr><td>"+s.id+"</td><td>"+s.name+"</td><td>"+(s.phone||"")+"</td></tr>";
      });
      tbody.innerHTML = html;

      var opts = "";
      data.forEach(function(s){
        opts += "<option value='"+s.id+"'>"+s.name+"</option>";
      });
      $("enroll-student").innerHTML = opts;
      $("pay-student").innerHTML = opts;
    });
  }

  // ----- Classes -----
  function loadClasses(){
    return api("/api/classes").then(function(data){
      var tbody = $("classes-table").querySelector("tbody");
      var html = "";
      data.forEach(function(c){
        html += "<tr><td>"+c.id+"</td><td>"+c.name+"</td><td>"+c.monthly_fee+"</td></tr>";
      });
      tbody.innerHTML = html;

      var opts = "";
      data.forEach(function(c){
        opts += "<option value='"+c.id+"'>"+c.name+"</option>";
      });
      $("enroll-class").innerHTML = opts;
      $("enroll-view-class").innerHTML = opts;
      $("pay-class").innerHTML = opts;
    });
  }

  function loadStudentsInClass(){
    var classId = $("enroll-view-class").value;
    if(!classId){return;}
    api("/api/classes/"+classId+"/students").then(function(data){
      var tbody = $("enroll-table").querySelector("tbody");
      var html = "";
      data.forEach(function(s){
        html += "<tr><td>"+s.id+"</td><td>"+s.name+"</td><td>"+(s.phone||"")+"</td></tr>";
      });
      tbody.innerHTML = html;
    }).catch(function(e){setStatus(e.message,true);});
  }

  // ----- Exam slots & seat layout -----
  var selectedSeatIndex = null;
  var selectedSeatPos = null;

  function loadExamSlots(){
    return api("/api/exam/slots").then(function(data){
      var sel = $("exam-slot");
      var html = "";
      data.forEach(function(slot){
        html += "<option value='"+slot.id+"'>"+slot.label+"</option>";
      });
      sel.innerHTML = html;
      if(data.length){
        sel.value = data[0].id;
        loadSeatLayout();
      }
    }).catch(function(e){
      setStatus("Error loading exam slots: "+e.message,true);
    });
  }

  function loadSeatLayout(){
    var slotId = $("exam-slot").value;
    if(!slotId){return;}
    api("/api/exam/slots/"+slotId+"/layout").then(function(data){
      selectedSeatIndex = null;
      selectedSeatPos = null;
      $("seat-info").textContent = "";
      renderSeatLayout(data);
      setStatus("Loaded seat layout for "+data.slot.label);
    }).catch(function(e){
      setStatus("Error loading seats: "+e.message,true);
    });
  }

  function renderSeatLayout(data){
    var layout = $("seat-layout");
    var maxSeats = data.seat_count;
    var bookings = data.bookings || [];

    var map = {};
    bookings.forEach(function(b){
      map[b.seat_index+"-"+b.seat_pos] = b;
    });

    var html = "";
    for(var i=1;i<=maxSeats;i++){
      html += "<div class='bench-row'><div class='bench-label'>Seat "+i+"</div>";
      html += "<div class='bench'>";
      for(var p=1;p<=4;p++){
        var key = i+"-"+p;
        var b = map[key];
        var cls = "bench-segment";
        var text = "Pos "+p;
        if(b){
          cls += " booked";
          if(b.student_class === "Grade 7"){ cls += " grade7"; }
          else if(b.student_class === "Grade 8"){ cls += " grade8"; }
          text = b.student_name;
        } else {
          cls += " empty";
        }
        html += "<div class='"+cls+"' data-seat='"+i+"' data-pos='"+p+"'>"+text+"</div>";
      }
      html += "</div></div>";
    }
    layout.innerHTML = html;
  }

  $("exam-slot").addEventListener("change", loadSeatLayout);

  $("seat-layout").addEventListener("click", function(ev){
    var t = ev.target;
    if(!t.classList.contains("bench-segment")) return;
    if(t.classList.contains("booked")){
      setStatus("Seat already booked", true);
      return;
    }
    var seat = Number(t.getAttribute("data-seat"));
    var pos = Number(t.getAttribute("data-pos"));
    selectedSeatIndex = seat;
    selectedSeatPos = pos;
    var cells = document.querySelectorAll(".bench-segment");
    for(var i=0;i<cells.length;i++){
      cells[i].classList.remove("selected");
    }
    t.classList.add("selected");
    $("seat-info").textContent = "Selected Seat "+seat+" – Position "+pos;
  });

  $("btn-book-seat").addEventListener("click", function(){
    var slotId = Number($("exam-slot").value);
    var name = $("exam-name").value.trim();
    var sClass = $("exam-class").value;
    if(!slotId){setStatus("Select a session",true);return;}
    if(!name){setStatus("Enter student name",true);return;}
    if(!sClass){setStatus("Select class (Grade 7 or Grade 8)",true);return;}
    if(selectedSeatIndex === null || selectedSeatPos === null){
      setStatus("Click on a seat segment in the layout to choose it",true);
      return;
    }
    api("/api/exam/book",{
      method:"POST",
      body:{
        slot_id:slotId,
        student_name:name,
        student_class:sClass,
        seat_index:selectedSeatIndex,
        seat_pos:selectedSeatPos
      }
    }).then(function(){
      setStatus("Seat booked successfully");
      $("exam-name").value = "";
      $("seat-info").textContent = "";
      selectedSeatIndex = null;
      selectedSeatPos = null;
      loadSeatLayout();
    }).catch(function(e){
      setStatus(e.message,true);
    });
  });

  // ----- Other flows -----
  $("btn-add-student").addEventListener("click", function(){
    var name = $("stu-name").value.trim();
    var phone = $("stu-phone").value.trim();
    if(!name){setStatus("Name is required",true);return;}
    api("/api/students",{method:"POST",body:{name:name,phone:phone}}).then(function(){
      $("stu-name").value = "";
      $("stu-phone").value = "";
      setStatus("Student added");
      return loadStudents();
    }).catch(function(e){setStatus(e.message,true);});
  });

  $("btn-add-class").addEventListener("click", function(){
    var name = $("class-name").value.trim();
    var fee = Number($("class-fee").value || 0);
    if(!name){setStatus("Class name required",true);return;}
    api("/api/classes",{method:"POST",body:{name:name,monthly_fee:fee}}).then(function(){
      $("class-name").value = "";
      $("class-fee").value = "2000";
      setStatus("Class added");
      return loadClasses();
    }).catch(function(e){setStatus(e.message,true);});
  });

  $("btn-enroll").addEventListener("click", function(){
    var student_id = Number($("enroll-student").value);
    var class_id = Number($("enroll-class").value);
    if(!student_id || !class_id){setStatus("Select student and class",true);return;}
    api("/api/enrollments",{method:"POST",body:{student_id:student_id,class_id:class_id}}).then(function(){
      setStatus("Student enrolled");
      loadStudentsInClass();
    }).catch(function(e){setStatus(e.message,true);});
  });

  $("enroll-view-class").addEventListener("change", loadStudentsInClass);

  $("btn-pay").addEventListener("click", function(){
    var student_id = Number($("pay-student").value);
    var class_id = Number($("pay-class").value);
    var month = $("pay-month").value || (new Date().toISOString().slice(0,7));
    var amount = Number($("pay-amount").value || 0);
    var method = $("pay-method").value;
    api("/api/payments",{
      method:"POST",
      body:{student_id:student_id,class_id:class_id,month:month,amount:amount,method:method}
    }).then(function(){
      setStatus("Payment saved");
    }).catch(function(e){setStatus(e.message,true);});
  });

  $("btn-load-unpaid").addEventListener("click", function(){
    var month = $("unpaid-month").value || (new Date().toISOString().slice(0,7));
    api("/api/unpaid?month="+encodeURIComponent(month)).then(function(data){
      var tbody = $("unpaid-table").querySelector("tbody");
      var html = "";
      data.rows.forEach(function(r){
        html += "<tr><td>"+r.class_name+"</td><td>"+r.student_name+"</td><td>"+(r.phone||"")+"</td></tr>";
      });
      tbody.innerHTML = html;
      setStatus("Loaded unpaid for "+data.month);
    }).catch(function(e){setStatus(e.message,true);});
  });

  $("btn-load-finance").addEventListener("click", function(){
    var month = $("fin-month").value || (new Date().toISOString().slice(0,7));
    api("/api/finance?month="+encodeURIComponent(month)).then(function(data){
      var tbody = $("finance-table").querySelector("tbody");
      var html = "";
      data.rows.forEach(function(r){
        html += "<tr><td>"+r.class_name+"</td><td>"+r.payments_count+"</td><td>"+r.total_amount+"</td></tr>";
      });
      tbody.innerHTML = html;
      $("finance-total").textContent = data.total;
      setStatus("Loaded finance for "+data.month);
    }).catch(function(e){setStatus(e.message,true);});
  });

  // Defaults
  var todayMonth = new Date().toISOString().slice(0,7);
  ["pay-month","unpaid-month","fin-month"].forEach(function(id){
    if($(id)) $(id).value = todayMonth;
  });

  // Initial load
  Promise.all([loadStudents(), loadClasses(), loadExamSlots()]).then(function(){
    if($("enroll-view-class").value){
      loadStudentsInClass();
    }
    setStatus("Ready");
  }).catch(function(e){
    setStatus("Error loading initial data: "+e.message,true);
  });
})();
</script>

</body>
</html>`;

// Serve frontend
app.get("/", (req, res) => {
  res.type("html").send(FRONTEND_HTML);
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log("✅ Class Manager & Exam System running on port " + PORT);
  console.log("🗄  DB file:", DB_PATH);
});
