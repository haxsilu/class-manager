// ---------------------- Imports & setup ----------------------
import 'dotenv/config';
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import QRCode from "qrcode";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5050;
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const SECRET = process.env.APP_SECRET || "secret-key";

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------------------- Database setup ----------------------
const db = new Database(path.join(__dirname, "class_manager.db"));
db.pragma("journal_mode = wal");

function initDb() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS students(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, phone TEXT, grade TEXT, qr_token TEXT UNIQUE
    )`).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS classes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT UNIQUE, fee INTEGER DEFAULT 2000
    )`).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS enrollments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER, class_id INTEGER,
      UNIQUE(student_id,class_id)
    )`).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS attendance(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER, class_id INTEGER,
      date TEXT, present INTEGER DEFAULT 1,
      UNIQUE(student_id,class_id,date)
    )`).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER, class_id INTEGER, month TEXT,
      amount INTEGER DEFAULT 2000, method TEXT DEFAULT 'cash',
      created_at TEXT DEFAULT(datetime('now')),
      UNIQUE(student_id,class_id,month)
    )`).run();
}
initDb();

const todayISO = () => new Date().toISOString().slice(0, 10);
const monthKey = () => new Date().toISOString().slice(0, 7);

// ---------------------- Helpers ----------------------
function signStudentId(id) {
  const payload = JSON.stringify({ sid: id });
  const mac = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return Buffer.from(payload).toString("base64url") + "." + mac;
}
function unsignToken(token) {
  const [b64, mac] = token.split(".");
  const payload = Buffer.from(b64, "base64url").toString();
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (mac !== expected) throw new Error("bad token");
  return JSON.parse(payload).sid;
}

function page(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@1/css/pico.min.css">
<style>
body{background:#0b0f1a;color:#e8eef7;}
.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin:1rem 0;}
.nav a{all:unset;background:#1e293b;color:#cbd5e1;padding:.6rem 1rem;border-radius:.7rem;cursor:pointer;font-weight:600;}
.nav a:hover{background:#334155;}
table{width:100%;border-collapse:collapse;margin-top:1rem;}
td,th{padding:.5rem;border-bottom:1px solid #334155;}
@media(max-width:768px){
  .top{flex-direction:column;align-items:stretch;}
  table{display:block;overflow-x:auto;white-space:nowrap;}
  button,a[role=button]{width:100%;margin-top:.5rem;}
}
footer{text-align:center;margin-top:2rem;color:#94a3b8;}
</style>
</head>
<body>
<main class="container">
<header class="top">
 <strong>Class Manager</strong>
 <nav class="nav">
   <a href="/students">Students</a>
   <a href="/scanner">Scanner</a>
   <a href="/attendance-sheet">Attendance</a>
   <a href="/unpaid">Unpaid</a>
   <a href="/settings">Settings</a>
 </nav>
</header>
<h2>${title}</h2>
${body}
<footer>Created by Pulindu Pansilu</footer>
</main>
</body>
</html>`;
}

// ---------------------- Routes ----------------------
app.get("/", (req, res) => res.redirect("/students"));

// --- Students list ---
app.get("/students", (req, res) => {
  const students = db.prepare("SELECT * FROM students ORDER BY grade,name").all();
  const body = `
  <a href="/students/new">Add Student</a>
  <table>
  <thead><tr><th>Name</th><th>Grade</th><th>Phone</th><th>QR</th></tr></thead>
  <tbody>${students
    .map(
      (s) => `<tr>
      <td>${s.name}</td>
      <td>${s.grade}</td>
      <td>${s.phone || ""}</td>
      <td><a href="/students/${s.id}/qr">QR</a></td>
      </tr>`
    )
    .join("")}</tbody></table>`;
  res.send(page("Students", body));
});

app.get("/students/new", (req, res) => {
  res.send(
    page(
      "Add Student",
      `<form method="post" action="/students/new">
      <label>Name<input name="name" required></label>
      <label>Phone<input name="phone"></label>
      <label>Grade<select name="grade">
      <option>Grade 6</option><option>Grade 7</option><option>Grade 8</option><option>O/L</option>
      </select></label>
      <button type="submit">Save</button></form>`
    )
  );
});

app.post("/students/new", (req, res) => {
  const { name, phone, grade } = req.body;
  const result = db.prepare("INSERT INTO students(name,phone,grade) VALUES(?,?,?)").run(name, phone, grade);
  const token = signStudentId(result.lastInsertRowid);
  db.prepare("UPDATE students SET qr_token=? WHERE id=?").run(token, result.lastInsertRowid);
  res.redirect("/students");
});

app.get("/students/:id/qr", async (req, res) => {
  const s = db.prepare("SELECT * FROM students WHERE id=?").get(req.params.id);
  if (!s) return res.send("Not found");
  const img = await QRCode.toDataURL(`${BASE}/scan/${s.qr_token}`);
  res.send(
    page(
      "QR Code",
      `<div style="text-align:center">
      <h3>${s.name}</h3><p>${s.grade}</p>
      <img src="${img}" width="250"><br>
      <button onclick="window.print()">Print</button></div>`
    )
  );
});

// --- Scanner ---
app.get("/scanner", (req, res) => {
  const body = `
  <p>Scan student QR to mark attendance</p>
  <audio id="successSound" src="data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////8AAAABAAACCgAAAwABAAACcQCA//////////8AAAABAAACCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"></audio>
  <audio id="errorSound" src="data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////8AAAABAAACCgAAAwABAAACcQCA//////////8AAAABAAACCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"></audio>
  <div id="reader" style="max-width:500px;margin:auto"></div>
  <p id="status"></p>
  <script src="https://unpkg.com/html5-qrcode"></script>
  <script>
  async function mark(t){
    const r=await fetch('/scan/'+t+'/auto',{method:'POST'});
    const d=await r.json();
    const ok=d.ok;
    document.getElementById(ok?'successSound':'errorSound').play();
    document.getElementById('status').textContent=ok?'✅ '+d.student.name+' Present':'❌ '+(d.error||'Error');
  }
  function success(txt){const token=txt.split('/').pop();mark(token);}
  const sc=new Html5QrcodeScanner('reader',{fps:10,qrbox:250});sc.render(success);
  </script>`;
  res.send(page("Scanner", body));
});

app.post("/scan/:token/auto", (req, res) => {
  try {
    const sid = unsignToken(req.params.token);
    const s = db.prepare("SELECT * FROM students WHERE id=?").get(sid);
    if (!s) return res.json({ ok: false, error: "Student not found" });
    let c = db.prepare("SELECT * FROM classes WHERE title=?").get(s.grade);
    if (!c) {
      db.prepare("INSERT INTO classes(title) VALUES(?)").run(s.grade);
      c = db.prepare("SELECT * FROM classes WHERE title=?").get(s.grade);
    }
    db.prepare(
      "INSERT INTO attendance(student_id,class_id,date,present) VALUES(?,?,?,1) ON CONFLICT(student_id,class_id,date) DO UPDATE SET present=1"
    ).run(sid, c.id, todayISO());
    res.json({ ok: true, student: { id: s.id, name: s.name }, class: c.title, date: todayISO() });
  } catch {
    res.json({ ok: false, error: "Bad token" });
  }
});

// --- Unpaid Students ---
app.get("/unpaid", (req, res) => {
  const m = monthKey();
  const unpaid = db
    .prepare(
      `SELECT s.id,s.name,s.grade,s.phone FROM students s
       LEFT JOIN enrollments e ON e.student_id=s.id
       LEFT JOIN classes c ON c.id=e.class_id
       LEFT JOIN payments p ON p.student_id=s.id AND p.class_id=c.id AND p.month=?
       WHERE p.id IS NULL ORDER BY s.grade,s.name`
    )
    .all(m);
  const body = `
  <table><thead><tr><th>Name</th><th>Class</th><th>Phone</th><th></th></tr></thead><tbody>
  ${unpaid
    .map((u) => {
      const t = db.prepare("SELECT qr_token FROM students WHERE id=?").get(u.id)?.qr_token;
      return `<tr><td>${u.name}</td><td>${u.grade}</td><td>${u.phone || ""}</td>
      <td><a href="/pay?token=${encodeURIComponent(t)}">Mark Paid</a></td></tr>`;
    })
    .join("")}
  </tbody></table>`;
  res.send(page("Unpaid Students", body));
});

// ---------------------- Run server ----------------------
app.listen(PORT, () => console.log(`✅ Class Manager running at ${BASE}`));
