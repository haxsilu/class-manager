import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import Database from "better-sqlite3";
import QRCode from "qrcode";
import crypto from "crypto";
import multer from "multer";

/* ========================================================
   SYSTEM SETUP
   ======================================================== */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 5050);
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const SECRET = process.env.APP_SECRET || "dev-secret";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "class_manager.db");

const CORE_CLASSES = ["Grade 6", "Grade 7", "Grade 8", "O/L"];

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ========================================================
   DATABASE
   ======================================================== */

let db = openDb();

function openDb() {
    const d = new Database(DB_PATH);
    d.pragma("journal_mode = wal");
    initDb(d);
    migrateDb(d);
    return d;
}

function initDb(d) {
    d.prepare(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            grade TEXT NOT NULL,
            qr_token TEXT UNIQUE,
            is_free INTEGER DEFAULT 0
        )
    `).run();

    d.prepare(`
        CREATE TABLE IF NOT EXISTS classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT UNIQUE NOT NULL,
            fee INTEGER NOT NULL DEFAULT 2000
        )
    `).run();

    d.prepare(`
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            present INTEGER NOT NULL DEFAULT 1,
            UNIQUE(student_id, class_id, date)
        )
    `).run();

    d.prepare(`
        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL,
            month TEXT NOT NULL,
            amount INTEGER NOT NULL DEFAULT 2000,
            method TEXT DEFAULT 'cash',
            created_at TEXT DEFAULT(datetime('now')),
            UNIQUE(student_id, class_id, month)
        )
    `).run();
}

function migrateDb(d) {
    const exist = d.prepare("SELECT title FROM classes").all().map(r => r.title);
    for (const c of CORE_CLASSES) {
        if (!exist.includes(c)) {
            d.prepare("INSERT INTO classes(title, fee) VALUES(?, 2000)").run(c);
        }
    }
}

/* ========================================================
   HELPERS
   ======================================================== */

const todayISO = () => new Date().toISOString().slice(0, 10);

const monthKey = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

function signId(id) {
    const payload = JSON.stringify({ sid: id });
    const mac = crypto.createHmac("sha256", SECRET)
        .update(payload)
        .digest("base64url");
    return Buffer.from(payload).toString("base64url") + "." + mac;
}

function unsign(token) {
    const [b64, mac] = (token || "").split(".");
    const payload = Buffer.from(b64 || "", "base64url").toString();
    const want = crypto.createHmac("sha256", SECRET)
        .update(payload)
        .digest("base64url");
    if (mac !== want) throw new Error("Bad token");
    return JSON.parse(payload).sid;
}

/* ========================================================
   UI STYLE + PAGE RENDERER
   ======================================================== */

function css() {
    return `
html,body{background:#020617;color:#e5e7eb;font-family:system-ui,sans-serif;margin:0}
.container{max-width:1080px;margin:auto;padding:1rem}
header.nav{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1.2rem}
header.nav a{
    background:#1e293b;
    color:#e5e7eb;
    text-decoration:none;
    padding:.55rem 1rem;
    border-radius:.55rem;
    font-size:.95rem;
    font-weight:600;
}
header.nav a:hover{background:#334155}
.card{
    background:#0f172a;
    border:1px solid #1e293b;
    border-radius:.75rem;
    padding:1.2rem;
    margin-top:1rem;
}
table{width:100%;border-collapse:collapse;margin-top:.7rem;font-size:.92rem}
th,td{padding:.55rem;border-bottom:1px solid #1e293b}
button,a.button{
    background:#2563eb;
    color:#f9fafb;
    border:none;
    border-radius:.55rem;
    padding:.55rem 1rem;
    font-size:.9rem;
    cursor:pointer;
    text-decoration:none;
    display:inline-block;
}
button.secondary{background:#64748b}
button.danger{background:#b91c1c}
#notification{
    display:none;
    margin:.7rem 0;
    padding:.65rem;
    border-radius:.5rem;
    text-align:center;
    font-weight:600;
}
#notification.success{background:#166534;color:#bbf7d0}
#notification.warn{background:#92400e;color:#fed7aa}
#notification.error{background:#7f1d1d;color:#fecaca}
footer{text-align:center;color:#64748b;font-size:.85rem;margin-top:2rem}
@media(max-width:768px){
    header.nav{flex-direction:column}
    table{display:block;overflow-x:auto}
    button,a.button{width:100%;text-align:center;margin-top:.4rem}
}`;
}

function page(title, body, banner = "") {
    return `
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>${css()}</style>
</head>
<body>
<main class="container">

<header class="nav">
<a href="/students">Students</a>
<a href="/scanner">Scanner</a>
<a href="/attendance-sheet">Attendance</a>
<a href="/unpaid">Unpaid</a>
<a href="/finance">Finance</a>
<a href="/settings">Settings</a>
</header>

<h2>${title}</h2>
${banner ? `<div style="padding:.7rem;background:#083344;color:#99f6e4;border-radius:.55rem;margin-bottom:.7rem">${banner}</div>` : ""}

${body}

<footer>Created by Pulindu Pansilu</footer>

</main>
</body>
</html>`;
}

/* ========================================================
   PART 1 COMPLETE
   WAIT FOR PART 2
   ======================================================== */
/* ========================================================
   ROUTES
   ======================================================== */

app.get("/", (req, res) => res.redirect("/students"));

/* ===================== STUDENTS ===================== */

app.get("/students", (req, res) => {
    const list = db.prepare("SELECT * FROM students ORDER BY grade, name").all();
    const body = `
<a href="/students/new" class="button">Add Student</a>

<section class="card">
  <div style="overflow:auto">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Grade</th>
          <th>Phone</th>
          <th>Free</th>
          <th>QR</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(s => `
          <tr>
            <td>${s.name}</td>
            <td>${s.grade}</td>
            <td>${s.phone || ""}</td>
            <td>${s.is_free ? "🆓" : ""}</td>
            <td><a href="/students/${s.id}/qr">QR</a></td>
            <td>
              <a href="/students/${s.id}/edit">Edit</a>
              <form method="post" action="/students/${s.id}/delete" style="display:inline" onsubmit="return confirm('Delete ${s.name}?')">
                <button class="danger" style="margin-left:.4rem">Delete</button>
              </form>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>
</section>`;
    res.send(page("Students", body));
});

app.get("/students/new", (req, res) => {
    const body = `
<section class="card">
  <form method="post" action="/students/new" style="display:grid;gap:.75rem;max-width:440px">
    <label>Name<br><input name="name" required></label>
    <label>Phone<br><input name="phone"></label>
    <label>Grade<br>
      <select name="grade">
        <option>Grade 6</option>
        <option>Grade 7</option>
        <option>Grade 8</option>
        <option>O/L</option>
      </select>
    </label>
    <label><input type="checkbox" name="is_free"> Free card</label>
    <div>
      <button type="submit">Save</button>
    </div>
  </form>
</section>`;
    res.send(page("Add Student", body));
});

app.post("/students/new", (req, res) => {
    const { name, phone, grade } = req.body;
    const is_free = req.body.is_free ? 1 : 0;
    const r = db.prepare(`
        INSERT INTO students(name,phone,grade,is_free)
        VALUES(?,?,?,?)
    `).run(name, phone, grade, is_free);
    const token = signId(r.lastInsertRowid);
    db.prepare("UPDATE students SET qr_token=? WHERE id=?").run(token, r.lastInsertRowid);
    res.redirect("/students");
});

app.get("/students/:id/edit", (req, res) => {
    const s = db.prepare("SELECT * FROM students WHERE id=?").get(req.params.id);
    if (!s) return res.send("Student not found");

    const body = `
<section class="card">
  <form method="post" action="/students/${s.id}/edit" style="display:grid;gap:.75rem;max-width:440px">
    <label>Name<br><input name="name" value="${s.name}" required></label>
    <label>Phone<br><input name="phone" value="${s.phone || ""}"></label>
    <label>Grade<br>
      <select name="grade">
        ${CORE_CLASSES.map(c => `<option${s.grade === c ? " selected" : ""}>${c}</option>`).join("")}
      </select>
    </label>
    <label><input type="checkbox" name="is_free"${s.is_free ? " checked" : ""}> Free card</label>
    <div>
      <button type="submit">Save</button>
    </div>
  </form>
</section>`;
    res.send(page("Edit Student", body));
});

app.post("/students/:id/edit", (req, res) => {
    const { name, phone, grade } = req.body;
    const is_free = req.body.is_free ? 1 : 0;
    db.prepare(`
        UPDATE students
        SET name=?, phone=?, grade=?, is_free=?
        WHERE id=?
    `).run(name, phone, grade, is_free, req.params.id);
    res.redirect("/students");
});

app.post("/students/:id/delete", (req, res) => {
    const id = req.params.id;
    const tx = db.transaction(() => {
        db.prepare("DELETE FROM attendance WHERE student_id=?").run(id);
        db.prepare("DELETE FROM payments WHERE student_id=?").run(id);
        db.prepare("DELETE FROM students WHERE id=?").run(id);
    });
    tx();
    res.redirect("/students");
});

/* ===================== QR PRINT (NAME + QR ONLY) ===================== */

app.get("/students/:id/qr", async (req, res) => {
    const s = db.prepare("SELECT * FROM students WHERE id=?").get(req.params.id);
    if (!s) return res.send("Student not found");

    const qrDataUrl = await QRCode.toDataURL(`${BASE}/scan/${s.qr_token}`);
    res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${s.name}</title>
<style>
  body{font-family:sans-serif;text-align:center;margin-top:1rem}
  @media print{button{display:none}}
</style>
</head>
<body>
  <h2>${s.name}</h2>
  <img src="${qrDataUrl}" width="300" height="300"/>
  <br/>
  <button onclick="window.print()">Print</button>
</body>
</html>`);
});

/* ========================================================
   PART 2 COMPLETE
   NEXT: SCANNER + ATTENDANCE
   ======================================================== */
/* ===================== SCANNER (WITH STATUS) ===================== */

app.get("/scanner", (req, res) => {
    const body = `
<div id="notification"></div>
<div id="reader" style="max-width:460px;margin:1.2rem auto"></div>

<div id="scanActions" style="display:none;text-align:center;margin-top:.6rem">
  <a id="payBtn" class="button" href="#">Record Payment</a>
</div>

<script src="https://unpkg.com/html5-qrcode"></script>
<script>
  const note = (type, msg) => {
    const n = document.getElementById('notification');
    n.className = type;
    n.textContent = msg;
    n.style.display = 'block';
    clearTimeout(window.__noteTimer);
    window.__noteTimer = setTimeout(() => n.style.display = 'none', 2200);
  };

  function tokenFrom(text){
    try{
      if(text.startsWith('http')){
        const u = new URL(text);
        const parts = u.pathname.split('/').filter(Boolean);
        return parts[parts.length - 1] || "";
      }
    }catch(e){}
    return text.split('/').pop();
  }

  const seen = new Map();

  async function mark(token){
    const now = Date.now();
    if (seen.has(token) && now - seen.get(token) < 2000) return;
    seen.set(token, now);

    try{
      const r = await fetch('/scan/' + encodeURIComponent(token) + '/auto', { method: 'POST' });
      const d = await r.json();
      if (d.ok){
        note('success','Attendance: ' + d.student.name + (d.free ? ' (Free card)' : ''));
        const payBtn = document.getElementById('payBtn');
        payBtn.href = '/pay?token=' + encodeURIComponent(d.rawToken);
        document.getElementById('scanActions').style.display = 'block';
        try {
          const ctx = new AudioContext();
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g); g.connect(ctx.destination);
          o.frequency.value = 880;
          o.start();
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
          o.stop(ctx.currentTime + 0.15);
        } catch(e){}
      } else if (d.warning){
        note('warn', d.warning);
      } else {
        note('error', d.error || 'Error');
      }
    }catch(e){
      note('error','Network error');
    }
  }

  const scanner = new Html5QrcodeScanner('reader',{fps:12,qrbox:250,rememberLastUsedCamera:true});
  scanner.render((text)=>mark(tokenFrom(text)));
</script>
`;
    res.send(page("Scanner", body));
});

/* ===================== AUTO ATTENDANCE ON SCAN ===================== */

app.post("/scan/:token/auto", (req, res) => {
    try {
        const rawToken = req.params.token;
        const sid = unsign(rawToken);
        const s = db.prepare("SELECT * FROM students WHERE id=?").get(sid);
        if (!s) return res.json({ ok: false, error: "Student not found" });

        // Free card = no payment needed, but we still show success.
        if (s.is_free) {
            return res.json({
                ok: true,
                student: { id: s.id, name: s.name },
                free: true,
                rawToken
            });
        }

        let c = db.prepare("SELECT * FROM classes WHERE title=?").get(s.grade);
        if (!c) {
            db.prepare("INSERT INTO classes(title,fee) VALUES(?,2000)").run(s.grade);
            c = db.prepare("SELECT * FROM classes WHERE title=?").get(s.grade);
        }

        const today = todayISO();
        const dup = db.prepare(`
            SELECT 1 FROM attendance
            WHERE student_id=? AND class_id=? AND date=?
        `).get(s.id, c.id, today);

        if (dup) {
            return res.json({ ok: false, warning: "Already marked today", rawToken });
        }

        db.prepare(`
            INSERT INTO attendance(student_id,class_id,date,present)
            VALUES(?,?,?,1)
        `).run(s.id, c.id, today);

        res.json({
            ok: true,
            student: { id: s.id, name: s.name },
            class: c.title,
            date: today,
            rawToken
        });
    } catch (e) {
        res.json({ ok: false, error: "Bad token" });
    }
});

/* ===================== ATTENDANCE SHEET ===================== */

app.get("/attendance-sheet", (req, res) => {
    const classTitle = CORE_CLASSES.includes(req.query.class)
        ? req.query.class
        : "Grade 6";
    const date = req.query.date || todayISO();

    const clazz = db.prepare("SELECT * FROM classes WHERE title=?").get(classTitle);
    if (!clazz) {
        return res.send(page("Attendance", `<p>No such class.</p>`));
    }

    const students = db.prepare(`
        SELECT * FROM students
        WHERE grade=?
        ORDER BY name
    `).all(classTitle);

    const present = new Set(
        db.prepare(`
            SELECT student_id FROM attendance
            WHERE class_id=? AND date=?
        `).all(clazz.id, date).map(r => r.student_id)
    );

    const body = `
<section class="card">
  <form method="get" action="/attendance-sheet"
        style="display:flex;flex-wrap:wrap;gap:.6rem;align-items:flex-end">
    <label>Class<br>
      <select name="class">
        ${CORE_CLASSES.map(c => `<option${c === classTitle ? " selected" : ""}>${c}</option>`).join("")}
      </select>
    </label>
    <label>Date<br><input type="date" name="date" value="${date}"></label>
    <button type="submit">Show</button>
  </form>

  <details style="margin-top:.6rem">
    <summary>Manual attendance (by phone)</summary>
    <form method="post" action="/attendance/manual"
          style="margin-top:.5rem;display:flex;flex-wrap:wrap;gap:.6rem;align-items:flex-end">
      <input type="hidden" name="class" value="${classTitle}">
      <input type="hidden" name="date" value="${date}">
      <label>Phone<br><input name="phone" required placeholder="07XXXXXXXX"></label>
      <button type="submit">Mark Present</button>
    </form>
  </details>

  <div style="overflow:auto;margin-top:.7rem">
    <table>
      <thead>
        <tr><th>Present</th><th>Name</th><th>Phone</th><th>Free</th></tr>
      </thead>
      <tbody>
        ${students.map(s => `
          <tr>
            <td>${present.has(s.id) ? "Yes" : "-"}</td>
            <td>${s.name}</td>
            <td>${s.phone || ""}</td>
            <td>${s.is_free ? "🆓" : ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>
</section>`;
    res.send(page("Attendance", body));
});

/* ===================== MANUAL ATTENDANCE (PHONE) ===================== */

app.post("/attendance/manual", (req, res) => {
    const { phone, class: classTitle, date } = req.body;

    const s = db.prepare("SELECT * FROM students WHERE phone=?").get(phone);
    if (!s) {
        return res.send(
            page(
                "Attendance",
                `<p style="margin-top:1rem">No student found for phone <strong>${phone}</strong>.</p>`
            )
        );
    }

    let clazz = db.prepare("SELECT * FROM classes WHERE title=?").get(classTitle || s.grade);
    if (!clazz) {
        db.prepare("INSERT INTO classes(title,fee) VALUES(?,2000)").run(classTitle || s.grade);
        clazz = db.prepare("SELECT * FROM classes WHERE title=?").get(classTitle || s.grade);
    }

    try {
        db.prepare(`
            INSERT INTO attendance(student_id,class_id,date,present)
            VALUES(?,?,?,1)
        `).run(s.id, clazz.id, date || todayISO());
    } catch (e) {
        // already marked etc. ignore
    }

    res.redirect(
        `/attendance-sheet?class=${encodeURIComponent(classTitle)}&date=${encodeURIComponent(
            date
        )}`
    );
});

/* ========================================================
   PART 3 COMPLETE
   NEXT: UNPAID + FINANCE + PAYMENTS + SETTINGS + START
   ======================================================== */
/* ===================== UNPAID STUDENTS ===================== */

app.get("/unpaid", (req, res) => {
    const m = monthKey();

    const rows = db.prepare(`
        SELECT s.id, s.name, s.phone, s.grade, s.qr_token, s.is_free
        FROM students s
        LEFT JOIN classes c ON c.title = s.grade
        LEFT JOIN payments p
          ON p.student_id = s.id
         AND p.class_id = c.id
         AND p.month = ?
        WHERE p.id IS NULL AND s.is_free = 0
        ORDER BY s.grade, s.name
    `).all(m);

    const body = `
<section class="card">
  <div style="overflow:auto">
    <table>
      <thead>
        <tr><th>Name</th><th>Class</th><th>Phone</th><th>Pay</th></tr>
      </thead>
      <tbody>
        ${rows.map(r => `
        <tr>
          <td>${r.name}</td>
          <td>${r.grade}</td>
          <td>${r.phone || ""}</td>
          <td>
            <a href="/pay?token=${encodeURIComponent(r.qr_token)}">Record Payment</a>
          </td>
        </tr>
        `).join("")}
      </tbody>
    </table>
  </div>
</section>`;
    res.send(page("Unpaid Students", body));
});

/* ===================== FINANCE ===================== */

app.get("/finance", (req, res) => {
    const m = req.query.month || monthKey();

    const rows = db.prepare(`
        SELECT
          c.title AS class,
          COUNT(p.id) AS cnt,
          COALESCE(SUM(p.amount), 0) AS sum
        FROM classes c
        LEFT JOIN payments p
          ON p.class_id = c.id AND p.month = ?
        WHERE c.title IN ('Grade 6','Grade 7','Grade 8','O/L')
        GROUP BY c.id
        ORDER BY c.title
    `).all(m);

    const total = rows.reduce((t, r) => t + (r.sum || 0), 0);

    const body = `
<section class="card">
  <form method="get" action="/finance"
        style="display:flex;flex-wrap:wrap;gap:.7rem;align-items:flex-end">
    <label>Month (YYYY-MM)<br>
      <input name="month" value="${m}">
    </label>
    <button type="submit">Show</button>
  </form>

  <div style="overflow:auto;margin-top:.75rem">
    <table>
      <thead>
        <tr><th>Class</th><th>Payments</th><th>Revenue (Rs.)</th></tr>
      </thead>
      <tbody>
        ${rows.map(r => `
        <tr>
          <td>${r.class}</td>
          <td>${r.cnt || 0}</td>
          <td>${r.sum || 0}</td>
        </tr>
        `).join("")}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="2" style="text-align:right"><strong>Total</strong></td>
          <td><strong>${total}</strong></td>
        </tr>
      </tfoot>
    </table>
  </div>
</section>`;
    res.send(page("Finance", body));
});

/* ===================== RECORD PAYMENT ===================== */

app.get("/pay", (req, res) => {
    try {
        const sid = unsign(req.query.token);
        const s = db.prepare("SELECT * FROM students WHERE id=?").get(sid);
        if (!s) return res.send("Student not found");

        let c = db.prepare("SELECT * FROM classes WHERE title=?").get(s.grade);
        if (!c) {
            db.prepare("INSERT INTO classes(title,fee) VALUES(?,2000)").run(s.grade);
            c = db.prepare("SELECT * FROM classes WHERE title=?").get(s.grade);
        }

        const m = monthKey();
        const exists = db.prepare(`
            SELECT 1 FROM payments
            WHERE student_id=? AND class_id=? AND month=?
        `).get(sid, c.id, m);

        const body = `
<section class="card">
  <h3>${s.name}</h3>
  <p style="font-size:.9rem;color:#94a3b8">
    ${s.grade} ${s.phone ? " · " + s.phone : ""}
  </p>

  <form method="post" action="/pay"
        style="display:grid;gap:.7rem;max-width:460px">

    <input type="hidden" name="token" value="${req.query.token}">
    <input type="hidden" name="class_id" value="${c.id}">

    <label>Month<br>
      <input name="month" value="${m}">
    </label>

    <label>Amount (Rs.)<br>
      <input type="number" name="amount" value="${c.fee}" required>
    </label>

    <label>Method<br>
      <select name="method">
        <option>cash</option>
        <option>bank</option>
        <option>online</option>
      </select>
    </label>

    <button type="submit">${exists ? "Update" : "Save"} Payment</button>
  </form>
</section>`;
        res.send(page("Record Payment", body));
    } catch {
        res.send("Invalid payment link");
    }
});

app.post("/pay", (req, res) => {
    try {
        const sid = unsign(req.body.token);

        db.prepare(`
            INSERT INTO payments(student_id,class_id,month,amount,method)
            VALUES(?,?,?,?,?)
            ON CONFLICT(student_id,class_id,month)
            DO UPDATE SET amount=excluded.amount, method=excluded.method
        `).run(
            sid,
            req.body.class_id,
            req.body.month || monthKey(),
            req.body.amount,
            req.body.method
        );

        res.redirect("/unpaid");
    } catch (e) {
        res.send("Error saving payment");
    }
});

/* ===================== SETTINGS (DB DOWNLOAD/UPLOAD) ===================== */

const upload = multer({ dest: path.join(__dirname, "uploads") });

app.get("/settings", (req, res) => {
    const body = `
<section class="card">
  <h3>Database Management</h3>
  <p style="color:#94a3b8;font-size:.9rem;margin-bottom:.8rem">
    Download or replace the database file.
  </p>

  <a href="/admin/db/download" class="button secondary">Download DB</a>

  <form method="post" action="/admin/db/upload"
        enctype="multipart/form-data"
        style="margin-top:1rem">

    <label>Select DB file<br>
      <input type="file" name="dbfile" required>
    </label>
    <br><br>
    <button type="submit">Upload & Replace DB</button>

  </form>
</section>`;
    res.send(page("Settings", body));
});

app.get("/admin/db/download", (req, res) => {
    if (!fs.existsSync(DB_PATH)) return res.send("No database file.");
    res.setHeader("Content-Disposition", 'attachment; filename="class_manager.db"');
    fs.createReadStream(DB_PATH).pipe(res);
});

app.post("/admin/db/upload", upload.single("dbfile"), (req, res) => {
    try {
        if (!req.file) return res.send("No file uploaded");
        fs.copyFileSync(req.file.path, DB_PATH);
        db = openDb();
        res.redirect("/settings");
    } catch (e) {
        res.send("Upload failed.");
    }
});

/* ===================== START SERVER ===================== */

app.listen(PORT, () => {
    console.log(`🚀 Class Manager running at ${BASE}`);
    console.log(`🗄  DB: ${DB_PATH}`);
});

/* ========================================================
   END OF FULL server.js
   ======================================================== */
