import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import crypto from 'crypto';
import multer from 'multer';

/* ================== Setup ================== */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = Number(process.env.PORT || 5050);
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const SECRET  = process.env.APP_SECRET || 'dev-secret-lite';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'class_manager.db');

const CORE_CLASSES = ['Grade 6','Grade 7','Grade 8','O/L'];

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ================== DB Open/Init/Migrate ================== */
let db = openDb();

function openDb() {
  const d = new Database(DB_PATH);
  d.pragma('journal_mode = wal');
  initDb(d);
  migrateDb(d);
  return d;
}

function initDb(d){
  d.prepare(`CREATE TABLE IF NOT EXISTS students(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    grade TEXT NOT NULL,
    qr_token TEXT UNIQUE
  )`).run();

  d.prepare(`CREATE TABLE IF NOT EXISTS classes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT UNIQUE NOT NULL,
    fee INTEGER NOT NULL DEFAULT 2000
  )`).run();

  d.prepare(`CREATE TABLE IF NOT EXISTS attendance(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    present INTEGER NOT NULL DEFAULT 1,
    UNIQUE(student_id,class_id,date)
  )`).run();

  d.prepare(`CREATE TABLE IF NOT EXISTS payments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    month TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 2000,
    method TEXT DEFAULT 'cash',
    created_at TEXT DEFAULT(datetime('now')),
    UNIQUE(student_id,class_id,month)
  )`).run();
}

function migrateDb(d){
  try { d.prepare(`ALTER TABLE students ADD COLUMN is_free INTEGER DEFAULT 0`).run(); } catch {}
  const have = new Set(d.prepare(`SELECT title FROM classes`).all().map(r=>r.title));
  for (const t of CORE_CLASSES) if (!have.has(t)) d.prepare(`INSERT INTO classes(title,fee) VALUES(?,2000)`).run(t);
}

/* ================== Helpers ================== */
const todayISO = () => new Date().toISOString().slice(0,10);
const monthKey = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

function signId(id){
  const payload = JSON.stringify({sid:id});
  const mac = crypto.createHmac('sha256',SECRET).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + mac;
}
function unsign(t){
  const [b64,mac] = (t||'').split('.');
  const payload = Buffer.from(b64||'','base64url').toString();
  const want = crypto.createHmac('sha256',SECRET).update(payload).digest('base64url');
  if(mac!==want) throw new Error('bad token');
  return JSON.parse(payload).sid;
}

function page(title, body, banner=''){
  return `<!doctype html><html><head>
  <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@1/css/pico.min.css">
  <style>
  :root{--card:#0b1220;--text:#e8eef8;--muted:#9fb4cb;--border:#1f2a44}
  html,body{background:#0a0f1a;color:var(--text)}
  .container{max-width:1080px;padding-inline:16px}
  header.nav{display:flex;flex-wrap:wrap;justify-content:center;gap:.6rem;margin-top:1rem}
  header.nav a{all:unset;background:#1e293b;color:#cbd5e1;padding:.6rem 1rem;border-radius:.6rem;cursor:pointer;font-weight:600}
  header.nav a:hover{background:#334155}
  table{width:100%;border-collapse:collapse;margin-top:1rem}
  td,th{padding:.5rem;border-bottom:1px solid #334155}
  .card{border:1px solid var(--border);border-radius:1rem;padding:1rem;background:#0b1220}
  #notification{display:none;text-align:center;padding:.7rem;border-radius:.6rem;margin-bottom:1rem;font-weight:700}
  #notification.success{background:#065f46;color:#d1fae5}
  #notification.warn{background:#92400e;color:#fef3c7}
  #notification.error{background:#7f1d1d;color:#fee2e2}
  .banner{margin:12px 0;padding:.7rem 1rem;border-radius:.6rem;background:#0d1f16;color:#b5f3c9;border:1px solid #217a4b}
  footer{text-align:center;margin-top:1.2rem;color:#94a3b8}
  @media(max-width:768px){
    header.nav{flex-direction:column;align-items:stretch}
    table{display:block;overflow-x:auto;white-space:nowrap}
    button,a[role=button]{width:100%;margin-top:.5rem}
  }
  </style></head><body><main class="container">
  <header class="nav">
    <a href="/students">Students</a><a href="/scanner">Scanner</a>
    <a href="/attendance-sheet">Attendance</a><a href="/unpaid">Unpaid</a>
    <a href="/finance">Finance</a><a href="/settings">Settings</a>
  </header>
  <h2>${title}</h2>
  ${banner?`<div class="banner">${banner}</div>`:''}
  ${body}
  <footer>Created by Pulindu Pansilu</footer>
  </main></body></html>`;
}
/* ================== Routes ================== */
app.get('/',(r,s)=>s.redirect('/students'));

/* ---- Students list ---- */
app.get('/students',(req,res)=>{
  const list = db.prepare(`SELECT * FROM students ORDER BY grade,name`).all();
  const body = `<a role="button" href="/students/new">Add Student</a>
  <table><thead><tr><th>Name</th><th>Grade</th><th>Phone</th><th>Free</th><th>QR</th><th>Actions</th></tr></thead>
  <tbody>${list.map(s=>`
  <tr><td>${s.name}</td><td>${s.grade}</td><td>${s.phone||''}</td>
  <td>${s.is_free?'🆓':''}</td>
  <td><a role="button" href="/students/${s.id}/qr">QR</a></td>
  <td><a href="/students/${s.id}/edit">Edit</a>
  <form method="post" action="/students/${s.id}/delete" style="display:inline"><button>Del</button></form></td></tr>`).join('')}</tbody></table>`;
  res.send(page('Students',body));
});

/* ---- Add/Edit/Delete student ---- */
app.get('/students/new',(req,res)=>res.send(page('Add Student',`
<form method="post" action="/students/new">
<label>Name<input name="name" required></label>
<label>Phone<input name="phone"></label>
<label>Grade<select name="grade">${CORE_CLASSES.map(c=>`<option>${c}</option>`).join('')}</select></label>
<label><input type="checkbox" name="is_free"> Free card</label>
<button type="submit">Save</button>
</form>`)));

app.post('/students/new',(req,res)=>{
  const {name,phone,grade}=req.body; const is_free=req.body.is_free?1:0;
  const r=db.prepare(`INSERT INTO students(name,phone,grade,is_free)VALUES(?,?,?,?)`).run(name,phone,grade,is_free);
  const token=signId(r.lastInsertRowid);
  db.prepare(`UPDATE students SET qr_token=? WHERE id=?`).run(token,r.lastInsertRowid);
  res.redirect('/students');
});

app.get('/students/:id/edit',(req,res)=>{
  const s=db.prepare(`SELECT * FROM students WHERE id=?`).get(req.params.id);
  if(!s)return res.send('Not found');
  res.send(page('Edit Student',`
  <form method="post" action="/students/${s.id}/edit">
  <label>Name<input name="name" value="${s.name}"></label>
  <label>Phone<input name="phone" value="${s.phone||''}"></label>
  <label>Grade<select name="grade">${CORE_CLASSES.map(c=>`<option${s.grade===c?' selected':''}>${c}</option>`).join('')}</select></label>
  <label><input type="checkbox" name="is_free"${s.is_free?' checked':''}> Free card</label>
  <button>Save</button></form>`));
});

app.post('/students/:id/edit',(req,res)=>{
  const {name,phone,grade}=req.body;const is_free=req.body.is_free?1:0;
  db.prepare(`UPDATE students SET name=?,phone=?,grade=?,is_free=? WHERE id=?`).run(name,phone,grade,is_free,req.params.id);
  res.redirect('/students');
});

app.post('/students/:id/delete',(req,res)=>{
  const id=req.params.id;
  const tx=db.transaction(()=>{db.prepare(`DELETE FROM payments WHERE student_id=?`).run(id);
  db.prepare(`DELETE FROM attendance WHERE student_id=?`).run(id);
  db.prepare(`DELETE FROM students WHERE id=?`).run(id);});tx();
  res.redirect('/students');
});

/* ---- QR print ---- */
app.get('/students/:id/qr',async(req,res)=>{
  const s=db.prepare(`SELECT * FROM students WHERE id=?`).get(req.params.id);
  if(!s)return res.send('Not found');
  const img=await QRCode.toDataURL(`${BASE}/scan/${s.qr_token}`);
  res.send(`<!doctype html><html><body style="text-align:center"><h2>${s.name}</h2><img src="${img}" width="250"><br><button onclick="window.print()">Print</button></body></html>`);
});

/* ---- Scanner ---- */
app.get('/scanner',(req,res)=>{
  const body=`<div id="notification"></div>
  <audio id="beep" src="https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg"></audio>
  <div id="reader" style="max-width:400px;margin:auto"></div>
  <div id="actions" style="text-align:center;margin-top:1rem;display:none">
  <a id="payBtn" href="#" role="button">Record Payment</a></div>
  <script src="https://unpkg.com/html5-qrcode"></script>
  <script>
  const beep=()=>{document.getElementById('beep').play()};
  const note=(t,m)=>{const n=document.getElementById('notification');n.innerText=m;n.style.display='block';setTimeout(()=>n.style.display='none',2000)};
  async function mark(token){try{const r=await fetch('/scan/'+token+'/auto',{method:'POST'});const d=await r.json();
    if(d.ok){note('ok','Marked '+d.student.name);beep();if(d.token){const p=document.getElementById('payBtn');p.href='/pay?token='+d.token;document.getElementById('actions').style.display='block';}}
    else note('err',d.error||d.warning);}catch{note('err','error');}}
  const sc=new Html5QrcodeScanner('reader',{fps:10,qrbox:250});
  sc.render(txt=>mark(txt.split('/').pop()));
  </script>`;
  res.send(page('Scanner',body));
});
/* ================== Routes ================== */
app.get('/',(r,s)=>s.redirect('/students'));

/* ---- Students list ---- */
app.get('/students',(req,res)=>{
  const list = db.prepare(`SELECT * FROM students ORDER BY grade,name`).all();
  const body = `<a role="button" href="/students/new">Add Student</a>
  <table><thead><tr><th>Name</th><th>Grade</th><th>Phone</th><th>Free</th><th>QR</th><th>Actions</th></tr></thead>
  <tbody>${list.map(s=>`
  <tr><td>${s.name}</td><td>${s.grade}</td><td>${s.phone||''}</td>
  <td>${s.is_free?'🆓':''}</td>
  <td><a role="button" href="/students/${s.id}/qr">QR</a></td>
  <td><a href="/students/${s.id}/edit">Edit</a>
  <form method="post" action="/students/${s.id}/delete" style="display:inline"><button>Del</button></form></td></tr>`).join('')}</tbody></table>`;
  res.send(page('Students',body));
});

/* ---- Add/Edit/Delete student ---- */
app.get('/students/new',(req,res)=>res.send(page('Add Student',`
<form method="post" action="/students/new">
<label>Name<input name="name" required></label>
<label>Phone<input name="phone"></label>
<label>Grade<select name="grade">${CORE_CLASSES.map(c=>`<option>${c}</option>`).join('')}</select></label>
<label><input type="checkbox" name="is_free"> Free card</label>
<button type="submit">Save</button>
</form>`)));

app.post('/students/new',(req,res)=>{
  const {name,phone,grade}=req.body; const is_free=req.body.is_free?1:0;
  const r=db.prepare(`INSERT INTO students(name,phone,grade,is_free)VALUES(?,?,?,?)`).run(name,phone,grade,is_free);
  const token=signId(r.lastInsertRowid);
  db.prepare(`UPDATE students SET qr_token=? WHERE id=?`).run(token,r.lastInsertRowid);
  res.redirect('/students');
});

app.get('/students/:id/edit',(req,res)=>{
  const s=db.prepare(`SELECT * FROM students WHERE id=?`).get(req.params.id);
  if(!s)return res.send('Not found');
  res.send(page('Edit Student',`
  <form method="post" action="/students/${s.id}/edit">
  <label>Name<input name="name" value="${s.name}"></label>
  <label>Phone<input name="phone" value="${s.phone||''}"></label>
  <label>Grade<select name="grade">${CORE_CLASSES.map(c=>`<option${s.grade===c?' selected':''}>${c}</option>`).join('')}</select></label>
  <label><input type="checkbox" name="is_free"${s.is_free?' checked':''}> Free card</label>
  <button>Save</button></form>`));
});

app.post('/students/:id/edit',(req,res)=>{
  const {name,phone,grade}=req.body;const is_free=req.body.is_free?1:0;
  db.prepare(`UPDATE students SET name=?,phone=?,grade=?,is_free=? WHERE id=?`).run(name,phone,grade,is_free,req.params.id);
  res.redirect('/students');
});

app.post('/students/:id/delete',(req,res)=>{
  const id=req.params.id;
  const tx=db.transaction(()=>{db.prepare(`DELETE FROM payments WHERE student_id=?`).run(id);
  db.prepare(`DELETE FROM attendance WHERE student_id=?`).run(id);
  db.prepare(`DELETE FROM students WHERE id=?`).run(id);});tx();
  res.redirect('/students');
});

/* ---- QR print ---- */
app.get('/students/:id/qr',async(req,res)=>{
  const s=db.prepare(`SELECT * FROM students WHERE id=?`).get(req.params.id);
  if(!s)return res.send('Not found');
  const img=await QRCode.toDataURL(`${BASE}/scan/${s.qr_token}`);
  res.send(`<!doctype html><html><body style="text-align:center"><h2>${s.name}</h2><img src="${img}" width="250"><br><button onclick="window.print()">Print</button></body></html>`);
});

/* ---- Scanner ---- */
app.get('/scanner',(req,res)=>{
  const body=`<div id="notification"></div>
  <audio id="beep" src="https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg"></audio>
  <div id="reader" style="max-width:400px;margin:auto"></div>
  <div id="actions" style="text-align:center;margin-top:1rem;display:none">
  <a id="payBtn" href="#" role="button">Record Payment</a></div>
  <script src="https://unpkg.com/html5-qrcode"></script>
  <script>
  const beep=()=>{document.getElementById('beep').play()};
  const note=(t,m)=>{const n=document.getElementById('notification');n.innerText=m;n.style.display='block';setTimeout(()=>n.style.display='none',2000)};
  async function mark(token){try{const r=await fetch('/scan/'+token+'/auto',{method:'POST'});const d=await r.json();
    if(d.ok){note('ok','Marked '+d.student.name);beep();if(d.token){const p=document.getElementById('payBtn');p.href='/pay?token='+d.token;document.getElementById('actions').style.display='block';}}
    else note('err',d.error||d.warning);}catch{note('err','error');}}
  const sc=new Html5QrcodeScanner('reader',{fps:10,qrbox:250});
  sc.render(txt=>mark(txt.split('/').pop()));
  </script>`;
  res.send(page('Scanner',body));
});
/* ---- Record payment ---- */
app.get('/pay',(req,res)=>{
  try{
    const sid = unsign(req.query.token);
    const s = db.prepare('SELECT * FROM students WHERE id=?').get(sid);
    if(!s) return res.send('Student not found');

    let c = db.prepare('SELECT * FROM classes WHERE title=?').get(s.grade);
    if(!c){
      db.prepare('INSERT INTO classes(title)VALUES(?)').run(s.grade);
      c = db.prepare('SELECT * FROM classes WHERE title=?').get(s.grade);
    }

    const m = monthKey();
    const already = db.prepare('SELECT 1 FROM payments WHERE student_id=? AND class_id=? AND month=?').get(s.id,c.id,m);
    const body = `<section class="card">
      <h3>${s.name}</h3>
      <p>${s.grade} ${s.phone ? '· '+s.phone : ''}</p>
      <form method="post" action="/pay">
        <input type="hidden" name="token" value="${req.query.token}">
        <input type="hidden" name="class_id" value="${c.id}">
        <label>Month<input name="month" value="${m}" required></label>
        <label>Amount<input name="amount" value="${c.fee||2000}" required></label>
        <label>Method
          <select name="method"><option>cash</option><option>bank</option><option>online</option></select>
        </label>
        <button>${already?'Update':'Save'} Payment</button>
      </form>
    </section>`;
    res.send(page('Record Payment', body));
  } catch {
    res.send('Invalid token');
  }
});

app.post('/pay',(req,res)=>{
  try{
    const sid = unsign(req.body.token);
    const m   = req.body.month || monthKey();
    db.prepare(`INSERT INTO payments(student_id,class_id,month,amount,method)
      VALUES(?,?,?,?,?)
      ON CONFLICT(student_id,class_id,month)
      DO UPDATE SET amount=excluded.amount,method=excluded.method`)
      .run(sid, req.body.class_id, m, req.body.amount, req.body.method);
    res.redirect('/unpaid');
  } catch {
    res.send('Payment error');
  }
});

/* ---- Settings: DB download/upload ---- */
const upload = multer({
  dest: path.join(__dirname,'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.get('/settings',(req,res)=>{
  const body = `<section class="card">
    <a role="button" href="/admin/db/download">Download Database</a>
    <form method="post" action="/admin/db/upload" enctype="multipart/form-data">
      <input type="file" name="dbfile" required>
      <button>Upload & Replace</button>
    </form>
    <p style="margin-top:.5rem;font-size:.9em">Uploading replaces the current DB file but keeps your structure (auto-adds <code>is_free</code> column if missing).</p>
  </section>`;
  res.send(page('Settings', body));
});

app.get('/admin/db/download',(req,res)=>{
  if(!fs.existsSync(DB_PATH)) return res.send('Database not found');
  res.setHeader('Content-Disposition','attachment; filename="class_manager.sqlite"');
  fs.createReadStream(DB_PATH).pipe(res);
});

app.post('/admin/db/upload', upload.single('dbfile'), (req,res)=>{
  try{
    db.close();
    fs.copyFileSync(req.file.path, DB_PATH);
    db = openDb();
    fs.unlinkSync(req.file.path);
    res.redirect('/settings');
  } catch {
    res.send('Upload failed');
  }
});

/* ---- Start server ---- */
app.listen(PORT, ()=> console.log(`✅ Class Manager running at ${BASE} (DB: ${DB_PATH})`));
