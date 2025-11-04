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
  // Add missing columns/indexes safely (no reset)
  try { d.prepare(`ALTER TABLE students ADD COLUMN is_free INTEGER DEFAULT 0`).run(); } catch {}
  // Ensure core classes exist
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
  :root{--card:#0b1220;--text:#e8eef8;--muted:#9fb4cb;--border:#1f2a44;--chip:#0f172a;--chip-hover:#12203a}
  html,body{background:#0a0f1a;color:var(--text)}
  .container{max-width:1080px;padding-inline:16px}
  header.nav{display:flex;flex-wrap:wrap;justify-content:center;gap:.6rem;margin-top:1rem}
  header.nav a{all:unset;background:#1e293b;color:#cbd5e1;padding:.6rem 1rem;border-radius:.6rem;cursor:pointer;font-weight:600}
  header.nav a:hover{background:#334155}
  table{width:100%;border-collapse:collapse;margin-top:1rem}
  td,th{padding:.5rem;border-bottom:1px solid #334155}
  .card{border:1px solid var(--border);border-radius:1rem;padding:1rem;background:var(--card)}
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
  const body = `<a role="button" class="muted" href="/students/new">Add Student</a>
  <div style="overflow:auto;margin-top:.6rem">
  <table><thead><tr><th>Name</th><th>Grade</th><th>Phone</th><th>Free</th><th>QR</th><th>Actions</th></tr></thead>
  <tbody>${list.map(s=>`<tr>
    <td>${s.name}</td><td>${s.grade}</td><td>${s.phone||''}</td>
    <td>${s.is_free?'🆓':''}</td>
    <td><a role="button" class="muted" href="/students/${s.id}/qr">QR</a></td>
    <td style="display:flex;gap:.4rem;flex-wrap:wrap">
      <a role="button" class="muted" href="/students/${s.id}/edit">Edit</a>
      <form method="post" action="/students/${s.id}/delete" onsubmit="return confirm('Delete ${s.name}?')">
        <button class="secondary" style="background:#2a0f14;border-color:#7a2030;color:#ffd7db">Delete</button>
      </form>
    </td>
  </tr>`).join('')}</tbody></table></div>`;
  res.send(page('Students', body));
});

/* ---- Add student ---- */
app.get('/students/new',(req,res)=>res.send(page('Add Student',`
  <section class="card">
    <form method="post" action="/students/new" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem">
      <label>Name<input name="name" required></label>
      <label>Phone<input name="phone"></label>
      <label>Grade<select name="grade"><option>Grade 6</option><option>Grade 7</option><option>Grade 8</option><option>O/L</option></select></label>
      <label style="align-self:end"><input type="checkbox" name="is_free"> Free card</label>
      <div style="grid-column:1/-1;display:flex;gap:.8rem">
        <button type="submit">Save</button>
        <a role="button" class="muted" href="/students">Cancel</a>
      </div>
    </form>
  </section>`)));
app.post('/students/new',(req,res)=>{
  const {name,phone,grade}=req.body; const is_free = req.body.is_free?1:0;
  const r = db.prepare(`INSERT INTO students(name,phone,grade,is_free) VALUES(?,?,?,?)`).run(name,phone,grade,is_free);
  const token = signId(r.lastInsertRowid);
  db.prepare(`UPDATE students SET qr_token=? WHERE id=?`).run(token, r.lastInsertRowid);
  res.redirect('/students');
});

/* ---- Edit student ---- */
app.get('/students/:id/edit',(req,res)=>{
  const s = db.prepare(`SELECT * FROM students WHERE id=?`).get(req.params.id);
  if(!s) return res.send('Not found');
  res.send(page('Edit Student',`
  <section class="card">
    <form method="post" action="/students/${s.id}/edit" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem">
      <label>Name<input name="name" value="${s.name}" required></label>
      <label>Phone<input name="phone" value="${s.phone||''}"></label>
      <label>Grade<select name="grade">
        <option${s.grade==='Grade 6'?' selected':''}>Grade 6</option>
        <option${s.grade==='Grade 7'?' selected':''}>Grade 7</option>
        <option${s.grade==='Grade 8'?' selected':''}>Grade 8</option>
        <option${s.grade==='O/L'?' selected':''}>O/L</option>
      </select></label>
      <label style="align-self:end"><input type="checkbox" name="is_free"${s.is_free?' checked':''}> Free card</label>
      <div style="grid-column:1/-1;display:flex;gap:.8rem">
        <button type="submit">Save</button>
        <a role="button" class="muted" href="/students">Back</a>
      </div>
    </form>
  </section>`));
});
app.post('/students/:id/edit',(req,res)=>{
  const {name,phone,grade}=req.body; const is_free=req.body.is_free?1:0;
  db.prepare(`UPDATE students SET name=?,phone=?,grade=?,is_free=? WHERE id=?`).run(name,phone,grade,is_free,req.params.id);
  res.redirect('/students');
});

/* ---- Delete student ---- */
app.post('/students/:id/delete',(req,res)=>{
  const id = Number(req.params.id);
  const tx = db.transaction(()=>{
    db.prepare(`DELETE FROM payments WHERE student_id=?`).run(id);
    db.prepare(`DELETE FROM attendance WHERE student_id=?`).run(id);
    db.prepare(`DELETE FROM students WHERE id=?`).run(id);
  });
  tx();
  res.redirect('/students');
});

/* ---- Minimal QR print (name + QR only) ---- */
app.get('/students/:id/qr', async (req,res)=>{
  const s = db.prepare(`SELECT * FROM students WHERE id=?`).get(req.params.id);
  if(!s) return res.send('Not found');
  const img = await QRCode.toDataURL(`${BASE}/scan/${s.qr_token}`);
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>${s.name}</title><style>body{text-align:center;font-family:sans-serif}@media print{button{display:none}}</style></head>
    <body><h2>${s.name}</h2><img src="${img}" width="300"><br><button onclick="window.print()">Print</button></body></html>`);
});

/* ---- Scanner with notification & sounds ---- */
app.get('/scanner',(req,res)=>{
  const body = `
  <div id="notification"></div>
  <audio id="successSound" src="data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////8AAAABAAACCgAAAwABAAACcQCA//////////8AAAABAAACCgAAAAAAAAAAAAAAAAAAAA"></audio>
  <audio id="warnSound"    src="data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////8AAAABAAACCgAAAwABAAACcQCA//////////8AAAABAAACCgAAAAAAAAAAAAAAAAAAAA"></audio>
  <audio id="errorSound"   src="data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////8AAAABAAACCgAAAwABAAACcQCA//////////8AAAABAAACCgAAAAAAAAAAAAAAAAAAAA"></audio>
  <div id="reader" style="max-width:520px;margin:auto"></div>
  <script src="https://unpkg.com/html5-qrcode"></script>
  <script>
    const note=(t,m)=>{const n=document.getElementById('notification');n.className=t;n.textContent=m;n.style.display='block';clearTimeout(window.__nt);window.__nt=setTimeout(()=>n.style.display='none',2200)};
    const beep=(which)=>{try{const id=which==='ok'?'successSound':which==='warn'?'warnSound':'errorSound';const a=document.getElementById(id);a.currentTime=0;a.play()}catch{}}
    function tokenFrom(txt){try{if(txt.startsWith('http')){const u=new URL(txt);const p=u.pathname.split('/').filter(Boolean);return p[p.length-1]||''}}catch{}return txt.split('/').pop()}
    const seen=new Map();
    async function mark(token){
      const now=Date.now();if(seen.has(token)&&now-seen.get(token)<2000)return;seen.set(token,now);
      try{const r=await fetch('/scan/'+encodeURIComponent(token)+'/auto',{method:'POST'});const d=await r.json();
        if(d.ok){note('success','Attendance marked: '+d.student.name);beep('ok');}
        else if(d.warning){note('warn',d.warning);beep('warn');}
        else{note('error',d.error||'Error');beep('err');}
      }catch{note('error','Network error');beep('err')}
    }
    document.addEventListener('DOMContentLoaded',()=>{
      const sc=new Html5QrcodeScanner('reader',{fps:12,qrbox:250,rememberLastUsedCamera:true});
      sc.render(txt=>mark(tokenFrom(txt)));
    });
  </script>`;
  res.send(page('Scanner', body));
});

app.post('/scan/:token/auto',(req,res)=>{
  try{
    const sid = unsign(req.params.token);
    const s = db.prepare(`SELECT * FROM students WHERE id=?`).get(sid);
    if(!s) return res.json({ok:false,error:'Student not found'});
    if(s.is_free) return res.json({ok:true,student:{id:s.id,name:s.name},free:true});

    let c = db.prepare(`SELECT * FROM classes WHERE title=?`).get(s.grade);
    if(!c){ db.prepare(`INSERT INTO classes(title) VALUES(?)`).run(s.grade); c = db.prepare(`SELECT * FROM classes WHERE title=?`).get(s.grade); }
    const today=todayISO();
    const dup = db.prepare(`SELECT 1 FROM attendance WHERE student_id=? AND class_id=? AND date=?`).get(sid,c.id,today);
    if(dup) return res.json({ok:false,warning:'Already marked today'});
    db.prepare(`INSERT INTO attendance(student_id,class_id,date,present) VALUES(?,?,?,1)`).run(sid,c.id,today);
    res.json({ok:true,student:{id:s.id,name:s.name},class:c.title,date:today});
  }catch{ res.json({ok:false,error:'Bad token'}); }
});

/* ---- Attendance sheet ---- */
app.get('/attendance-sheet',(req,res)=>{
  const classes = db.prepare(`SELECT * FROM classes WHERE title IN (${CORE_CLASSES.map(()=>'?').join(',')}) ORDER BY title`).all(...CORE_CLASSES);
  const classTitle = req.query.class && CORE_CLASSES.includes(req.query.class) ? req.query.class : (classes[0]?.title || 'Grade 6');
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : todayISO();
  const clazz = db.prepare(`SELECT * FROM classes WHERE title=?`).get(classTitle);
  const students = db.prepare(`SELECT s.* FROM students s WHERE s.grade=? ORDER BY s.name`).all(classTitle);
  const present = new Set(db.prepare(`SELECT student_id FROM attendance WHERE class_id=? AND date=?`).all(clazz?.id||0,date).map(r=>r.student_id));
  const body = `
  <section class="card">
    <form method="get" action="/attendance-sheet" style="display:flex;gap:.8rem;flex-wrap:wrap;align-items:end">
      <label>Class <select name="class">${classes.map(c=>`<option ${c.title===classTitle?'selected':''}>${c.title}</option>`).join('')}</select></label>
      <label>Date <input type="date" name="date" value="${date}"></label>
      <button type="submit">Show</button>
    </form>
    <div style="overflow:auto;margin-top:.6rem">
      <table><thead><tr><th>Present</th><th>Name</th><th>Phone</th><th>Free</th></tr></thead>
      <tbody>${students.map(s=>`<tr><td>${present.has(s.id)?'Yes':'—'}</td><td>${s.name}</td><td>${s.phone||''}</td><td>${s.is_free?'🆓':''}</td></tr>`).join('')}</tbody></table>
    </div>
  </section>`;
  res.send(page('Attendance', body));
});

/* ---- Unpaid (skip free-card students) ---- */
app.get('/unpaid',(req,res)=>{
  const m = monthKey();
  const rows = db.prepare(`
    SELECT s.id,s.name,s.phone,s.grade,s.is_free,c.id AS class_id
      FROM students s
 LEFT JOIN classes c ON c.title=s.grade
 LEFT JOIN payments p ON p.student_id=s.id AND p.class_id=c.id AND p.month=?
     WHERE p.id IS NULL AND (s.is_free IS NULL OR s.is_free=0)
  ORDER BY s.grade,s.name`).all(m);
  const body = `
  <section class="card">
    <div style="overflow:auto">
      <table><thead><tr><th>Name</th><th>Class</th><th>Phone</th><th>Action</th></tr></thead>
      <tbody>${
        rows.map(r=>{
          const token = db.prepare(`SELECT qr_token FROM students WHERE id=?`).get(r.id)?.qr_token || '';
          return `<tr><td>${r.name}</td><td>${r.grade}</td><td>${r.phone||''}</td>
                  <td><a role="button" class="muted" href="/pay?token=${encodeURIComponent(token)}">Mark Paid</a></td></tr>`;
        }).join('')
      }</tbody></table>
    </div>
  </section>`;
  res.send(page('Unpaid Students', body));
});

/* ---- Finance + record payment ---- */
app.get('/finance',(req,res)=>{
  const m = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey();
  const rows = db.prepare(`
    SELECT c.title AS class, COUNT(p.id) AS cnt, COALESCE(SUM(p.amount),0) AS sum
      FROM classes c LEFT JOIN payments p ON p.class_id=c.id AND p.month=?
     WHERE c.title IN (${CORE_CLASSES.map(()=>'?').join(',')})
  GROUP BY c.id ORDER BY c.title`).all(m, ...CORE_CLASSES);
  const total = rows.reduce((t,r)=>t + (r.sum||0), 0);
  const body = `
  <section class="card">
    <form method="get" action="/finance" style="display:flex;gap:.8rem;flex-wrap:wrap;align-items:end">
      <label>Month <input name="month" value="${m}" pattern="\\d{4}-\\d{2}" required></label>
      <button type="submit">Show</button>
    </form>
    <div style="overflow:auto;margin-top:.6rem">
      <table><thead><tr><th>Class</th><th>Payments</th><th>Revenue (Rs.)</th></tr></thead>
      <tbody>${rows.map(r=>`<tr><td>${r.class}</td><td>${r.cnt||0}</td><td>${r.sum||0}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2" style="text-align:right"><strong>Total</strong></td><td><strong>${total}</strong></td></tr></tfoot>
      </table>
    </div>
  </section>`;
  res.send(page('Finance', body));
});

app.get('/pay',(req,res)=>{
  try{
    const sid = unsign(String(req.query.token||''));
    const s = db.prepare(`SELECT * FROM students WHERE id=?`).get(sid);
    if(!s) return res.status(404).send('Not found');
    let c = db.prepare(`SELECT * FROM classes WHERE title=?`).get(s.grade);
    if(!c){ db.prepare(`INSERT INTO classes(title) VALUES(?)`).run(s.grade); c = db.prepare(`SELECT * FROM classes WHERE title=?`).get(s.grade); }
    const m = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey();
    const already = !!db.prepare(`SELECT 1 FROM payments WHERE student_id=? AND class_id=? AND month=?`).get(sid,c.id,m);
    const body = `
    <section class="card">
      <h3>${s.name}</h3>
      <p class="small">${s.grade}${s.phone ? ' · ' + s.phone : ''}</p>
      <form method="post" action="/pay" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem">
        <input type="hidden" name="token" value="${req.query.token}">
        <input type="hidden" name="class_id" value="${c.id}">
        <label>Month (YYYY-MM)<input name="month" value="${m}" pattern="\\d{4}-\\d{2}" required></label>
        <label>Amount (Rs.)<input type="number" min="0" name="amount" value="${c.fee||2000}" required></label>
        <label>Method
          <select name="method"><option>cash</option><option>bank</option><option>online</option></select>
        </label>
        <div style="grid-column:1/-1;display:flex;gap:.8rem">
          <button type="submit">${already?'Update':'Save'} Payment</button>
          <a role="button" class="muted" href="/unpaid?month=${encodeURIComponent(m)}">Back</a>
        </div>
      </form>
    </section>`;
    res.send(page('Record Payment', body));
  }catch{ res.status(400).send('Bad token'); }
});

app.post('/pay',(req,res)=>{
  try{
    const sid = unsign(String(req.body.token||'')); // throws on invalid
    const classId = Number(req.body.class_id);
    const m   = (req.body.month && /^\d{4}-\d{2}$/.test(req.body.month)) ? req.body.month : monthKey();
    const amt = Math.max(0, Number(req.body.amount||0));
    const method = (req.body.method||'cash').toString();

    db.prepare(`
      INSERT INTO payments(student_id,class_id,month,amount,method)
      VALUES(?,?,?,?,?)
      ON CONFLICT(student_id,class_id,month) DO UPDATE
      SET amount=excluded.amount, method=excluded.method
    `).run(sid,classId,m,amt,method);

    res.redirect(`/unpaid?month=${encodeURIComponent(m)}`);
  }catch{ res.status(400).send('Bad token'); }
});

/* ================== DB Download / Upload (Settings) ================== */
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

app.get('/settings',(req,res)=>{
  const banner = req.query.ok==='1' ? 'Settings saved / Database updated.' : '';
  const body = `
  <section class="card">
    <h3>Database</h3>
    <div style="display:flex;gap:.8rem;flex-wrap:wrap">
      <a role="button" class="muted" href="/admin/db/download">Download database</a>
      <form method="post" action="/admin/db/upload" enctype="multipart/form-data" style="display:flex;gap:.6rem;flex-wrap:wrap">
        <input type="file" name="dbfile" accept=".db,.sqlite,application/octet-stream" required>
        <button type="submit">Upload & Replace</button>
      </form>
    </div>
    <p class="small" style="margin-top:.6rem">Uploading a SQLite <code>.db</code> replaces the current file. We auto-migrate to include <code>is_free</code> if missing. No reset.</p>
  </section>`;
  res.send(page('Settings', body, banner));
});

app.get('/admin/db/download',(req,res)=>{
  try{
    if(!fs.existsSync(DB_PATH)) return res.status(404).send('DB not found');
    res.setHeader('Content-Type','application/octet-stream');
    res.setHeader('Content-Disposition','attachment; filename="class_manager.sqlite"');
    fs.createReadStream(DB_PATH).pipe(res);
  }catch(e){
    res.status(500).send('Failed to download DB');
  }
});

app.post('/admin/db/upload', upload.single('dbfile'), (req,res)=>{
  try{
    if(!req.file) return res.status(400).send('No file');
    try{ db.close(); }catch{}
    const backup = DB_PATH + '.bak';
    if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, backup);
    fs.copyFileSync(req.file.path, DB_PATH);
    db = openDb();
    try{ fs.unlinkSync(req.file.path); }catch{}
    return res.redirect('/settings?ok=1');
  }catch(e){
    try{
      if (fs.existsSync(DB_PATH + '.bak')) fs.copyFileSync(DB_PATH + '.bak', DB_PATH);
      db = openDb();
    }catch{}
    return res.status(500).send('Upload failed');
  }
});

/* ================== Start ================== */
app.listen(PORT,()=>console.log(`✅ Class Manager running at ${BASE} (DB: ${DB_PATH})`));
