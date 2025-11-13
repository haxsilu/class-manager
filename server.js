// server.js
// Single-file Class Payment & Management System
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
  `);

  // Seed default classes if missing
  const existing = db
    .prepare("SELECT name FROM classes")
    .all()
    .map((r) => r.name);
  ["Grade 6", "Grade 7", "Grade 8", "O/L"].forEach((title) => {
    if (!existing.includes(title)) {
      db.prepare(
        "INSERT INTO classes(name, monthly_fee) VALUES(?, 2000)"
      ).run(title);
    }
  });

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
      (sum, r) => sum + (r.total_amount || 0),
      0
    );
    res.json({ month, rows, total });
  } catch (e) {
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

// ---------- Frontend HTML (NO ${} inside this string) ----------
const FRONTEND_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Class Payment System</title>
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
  </style>
</head>
<body>
  <div class="container">
    <h1>Class Payment System</h1>
    <div id="status"></div>

    <header>
      <button data-tab="students" class="active">Students</button>
      <button data-tab="classes">Classes</button>
      <button data-tab="enrollments">Enrollments</button>
      <button data-tab="payments">Payments</button>
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
    api("/api/payments",{method:"POST",body:{student_id:student_id,class_id:class_id,month:month,amount:amount,method:method}}).then(function(){
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

  var todayMonth = new Date().toISOString().slice(0,7);
  ["pay-month","unpaid-month","fin-month"].forEach(function(id){
    if($(id)) $(id).value = todayMonth;
  });

  Promise.all([loadStudents(), loadClasses()]).then(function(){
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
  console.log("✅ Class Manager running on port " + PORT);
  console.log("🗄  DB file:", DB_PATH);
});
