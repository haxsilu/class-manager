import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import crypto from 'crypto';

/* ======================== Setup ======================== */
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

/* ======================== DB ======================== */
const db = new Database(DB_PATH);
db.pragma('journal_mode = wal');

function initDb(){
  db.prepare(`CREATE TABLE IF NOT EXISTS settings(
    key TEXT PRIMARY KEY,
    value TEXT
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS students(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    grade TEXT NOT NULL,
    qr_token TEXT UNIQUE
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS classes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT UNIQUE NOT NULL,
    fee INTEGER NOT NULL DEFAULT 2000
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS enrollments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    UNIQUE(student_id,class_id)
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS attendance(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    date TEXT NOT NULL,                -- yyyy-mm-dd
    present INTEGER NOT NULL DEFAULT 1,
    UNIQUE(student_id,class_id,date)
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS payments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    month TEXT NOT NULL,               -- yyyy-mm
    amount INTEGER NOT NULL DEFAULT 2000,
    method TEXT DEFAULT 'cash',
    created_at TEXT DEFAULT(datetime('now')),
    UNIQUE(student_id,class_id,month)
  )`).run();

  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique
              ON payments(student_id,class_id,month)`).run();

  // Default settings
  const defaults = {
    org_name: 'Class Manager',
    currency_symbol: 'Rs.',
    theme: 'dark',
    primary_color: '#0ea5e9',
    show_phone: '1',
    default_fee: '2000',
    fee_Grade6: '2000',
    fee_Grade7: '2000',
    fee_Grade8: '2000',
    fee_O_L: '2000'
  };
  const tx = db.transaction(()=>{
    for(const [k,v] of Object.entries(defaults)){
      db.prepare(`INSERT OR IGNORE INTO settings(key,value)VALUES(?,?)`).run(k,v);
    }
  }); tx();
}

function ensureCoreClasses(){
  const have = new Set(db.prepare(`SELECT title FROM classes`).all().map(r=>r.title));
  const tx = db.transaction(()=>{
    for(const t of CORE_CLASSES){
      const feeKey = t==='O/L' ? 'fee_O_L' : `fee_${t.replace(' ','')}`;
      const fee = Number(getSetting(feeKey) || getSetting('default_fee') || '2000');
      if(!have.has(t)) db.prepare(`INSERT INTO classes(title,fee) VALUES(?,?)`).run(t, fee);
      else db.prepare(`UPDATE classes SET fee=? WHERE title=?`).run(fee, t);
    }
  }); tx();
}

const getSetting = (k, f='') => db.prepare(`SELECT value FROM settings WHERE key=?`).get(k)?.value ?? f;
const setSetting = (k, v) => db.prepare(`
  INSERT INTO settings(key,value)VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`).run(k, v);

/* ======================== Helpers ======================== */
const todayISO = () => new Date().toISOString().slice(0,10);
const monthKey = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
const money = (n) => Number.isFinite(Number(n)) ? Number(n) : 0;

function signStudentId(id){
  const payload = JSON.stringify({ sid:id });
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + mac;
}
function unsignToken(token){
  const [b64, mac] = (token||'').split('.');
  const payload = Buffer.from(b64||'', 'base64url').toString();
  const want    = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if(mac !== want) throw new Error('bad token');
  const { sid }  = JSON.parse(payload);
  return Number(sid);
}

function findOrEnsureStudentClass(student){
  const exact = db.prepare(`
    SELECT c.id, c.title, c.fee
    FROM enrollments e JOIN classes c ON c.id=e.class_id
    WHERE e.student_id=? AND c.title=? LIMIT 1
  `).get(student.id, student.grade);
  if (exact) return exact;

  if (!CORE_CLASSES.includes(student.grade)) return null;
  const c = db.prepare(`SELECT id,title,fee FROM classes WHERE title=?`).get(student.grade);
  if(!c) return null;
  db.prepare(`INSERT OR IGNORE INTO enrollments(student_id,class_id)VALUES(?,?)`).run(student.id, c.id);
  return c;
}

const hasPaidMonth = (sid,cid,m) =>
  !!db.prepare(`SELECT 1 FROM payments WHERE student_id=? AND class_id=? AND month=? LIMIT 1`).get(sid,cid,m);

/* ======================== UI Template (Dark + Mobile) ======================== */
function page(title, body, head='', opts={}) {
  const org      = getSetting('org_name','Class Manager');
  const currency = getSetting('currency_symbol','Rs.');
  const theme    = getSetting('theme','dark');
  const primary  = getSetting('primary_color','#0ea5e9');

  const banner = opts.banner ? `<div class="banner success">${opts.banner}</div>` :
                opts.error  ? `<div class="banner error">${opts.error}</div>`   : '';

  return `<!doctype html><html ${theme!=='auto'?`data-theme="${theme}"`:''}><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${org} — ${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@1/css/pico.min.css">
<style>
:root{
  --brand:${primary};
  --card:#0b1220; --text:#e5eef8; --muted:#9fb4cb; --border:#1f2a44;
  --chip:#0f172a; --chip-hover:#12203a;
}
html{background:#0a0f1a;color:var(--text)}
.container{max-width:1080px;padding-inline:16px}
.top{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:1.2rem 0 1.6rem;flex-wrap:wrap}
.brand{font-weight:700;text-decoration:none;color:var(--text);padding:.7rem 1.1rem;border:1px solid var(--border);border-radius:.9rem;background:var(--chip);min-width:160px;text-align:center}
.nav{display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center}
.nav a{all:unset;display:inline-flex;align-items:center;justify-content:center;min-width:110px;text-align:center;padding:.55rem .9rem;border-radius:.8rem;border:1px solid var(--border);background:var(--chip);color:#dfe9ff;font-weight:600;cursor:pointer}
.nav a:hover{background:var(--chip-hover);border-color:#2a3a5d}
.nav a.primary{background:var(--brand);border-color:var(--brand);color:#0b1220}
.card{border:1px solid var(--border);border-radius:1rem;padding:1rem;background:var(--card);box-shadow:0 8px 28px rgba(3,7,18,.35)}
.small{color:var(--muted)}
table{width:100%;border-collapse:separate;border-spacing:0;margin:.4rem 0}
thead th{position:sticky;top:0;background:#0f172a;color:#dce8f6}
th,td{padding:.55rem .65rem;border-bottom:1px solid #0e1627;vertical-align:middle}
.banner{border-radius:.8rem;padding:.7rem 1rem;margin:.9rem 0;border:1px solid}
.banner.success{background:#0d1f16;border-color:#217a4b;color:#b5f3c9}
.banner.error{background:#2b1010;border-color:#a04040;color:#f3c0c0}
a[role=button],button{display:inline-flex;align-items:center;justify-content:center;padding:.5rem .8rem;border:1px solid var(--border);background:var(--chip);color:var(--text);border-radius:.6rem;cursor:pointer;font-weight:600;text-decoration:none}
a[role=button].muted,button.muted{background:#0c1424;border-color:#2b3a5a}
a[role=button].muted:hover,button.muted:hover{background:#13213a}
button.danger{background:#2a0f14;border-color:#7a2030;color:#ffd7db}
button.danger:hover{background:#3b141b;border-color:#973043}
footer{color:#8aa1bb;text-align:center;margin-top:1.2rem}
@media(max-width:900px){
  .top{gap:.8rem}
  .nav a{min-width:auto}
  table{display:block;overflow-x:auto;white-space:nowrap}
  a[role=button],button{width:100%;margin-top:.4rem}
}
</style>
${head}
</head><body>
<main class="container">
  <nav class="top">
    <a class="brand" href="/">${org}</a>
    <div class="nav">
      <a href="/students">Students</a>
      <a class="primary" href="/scanner">Scanner</a>
      <a href="/attendance-sheet">Attendance</a>
      <a href="/unpaid">Unpaid</a>
      <a href="/finance">Finance</a>
      <a href="/settings">Settings</a>
    </div>
  </nav>
  ${banner}
  <h2>${title}</h2>
  ${body}
  <footer>© ${new Date().getFullYear()} ${org} — Created by Pulindu Pansilu</footer>
</main>
</body></html>`;
}

/* ======================== Routes ======================== */
app.get('/', (req,res)=>res.redirect('/students'));

/* ---------- Settings ---------- */
app.get('/settings', (req,res)=>{
  const org  = getSetting('org_name');
  const cur  = getSetting('currency_symbol');
  const th   = getSetting('theme');
  const prim = getSetting('primary_color');
  const showPhone = getSetting('show_phone')==='1';

  const df = getSetting('default_fee') || '2000';
  const f6 = getSetting('fee_Grade6')  || df;
  const f7 = getSetting('fee_Grade7')  || df;
  const f8 = getSetting('fee_Grade8')  || df;
  const fO = getSetting('fee_O_L')     || df;

  const saved = req.query.saved==='1';

  const body = `
  <section class="card">
    <form method="post" action="/settings" class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem">
      <label>Institute / Brand name<input name="org_name" value="${org}" required></label>
      <label>Currency symbol<input name="currency_symbol" value="${cur}" required></label>
      <label>Theme
        <select name="theme">
          <option ${th==='auto'?'selected':''} value="auto">Auto</option>
          <option ${th==='light'?'selected':''} value="light">Light</option>
          <option ${th==='dark'?'selected':''}  value="dark">Dark</option>
        </select>
      </label>
      <label>Primary color<input type="color" name="primary_color" value="${prim}"></label>
      <label>Show phone numbers
        <select name="show_phone"><option value="1" ${showPhone?'selected':''}>Yes</option><option value="0" ${!showPhone?'selected':''}>No</option></select>
      </label>
      <hr style="grid-column:1/-1;border:0;height:1px;background:#1f2a44">
      <label>Default fee <input type="number" min="0" name="default_fee" value="${df}" required></label>
      <label>Grade 6 fee <input type="number" min="0" name="fee_Grade6" value="${f6}" required></label>
      <label>Grade 7 fee <input type="number" min="0" name="fee_Grade7" value="${f7}" required></label>
      <label>Grade 8 fee <input type="number" min="0" name="fee_Grade8" value="${f8}" required></label>
      <label>O/L fee <input type="number" min="0" name="fee_O_L" value="${fO}" required></label>
      <div style="grid-column:1/-1;display:flex;gap:1rem">
        <button type="submit">Save</button>
        <a role="button" class="muted" href="/">Back</a>
      </div>
    </form>
  </section>`;
  res.send(page('Settings', body, '', saved?{banner:'Settings saved.'}:{}) );
});

app.post('/settings', (req,res)=>{
  const b = req.body || {};
  const entries = {
    org_name:        String(b.org_name||'').trim() || getSetting('org_name'),
    currency_symbol: String(b.currency_symbol||'').trim() || getSetting('currency_symbol'),
    theme:           ['auto','light','dark'].includes(b.theme)?b.theme:getSetting('theme'),
    primary_color:   /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(b.primary_color||'')?b.primary_color:getSetting('primary_color'),
    show_phone:      String(b.show_phone)==='0'?'0':'1',
    default_fee:     String(Math.max(0, money(b.default_fee||getSetting('default_fee')||'2000'))),
    fee_Grade6:      String(Math.max(0, money(b.fee_Grade6||getSetting('fee_Grade6')||'2000'))),
    fee_Grade7:      String(Math.max(0, money(b.fee_Grade7||getSetting('fee_Grade7')||'2000'))),
    fee_Grade8:      String(Math.max(0, money(b.fee_Grade8||getSetting('fee_Grade8')||'2000'))),
    fee_O_L:         String(Math.max(0, money(b.fee_O_L||getSetting('fee_O_L')||'2000')))
  };
  for(const [k,v] of Object.entries(entries)) setSetting(k,v);
  ensureCoreClasses();
  res.redirect('/settings?saved=1');
});

/* ---------- Students ---------- */
app.get('/students', (req,res)=>{
  const showPhone = getSetting('show_phone')==='1';
  const students = db.prepare(`
    SELECT s.*, c.title AS class_title FROM students s
    LEFT JOIN enrollments e ON e.student_id=s.id
    LEFT JOIN classes c ON c.id=e.class_id
    WHERE c.title IS NULL OR c.title IN (${CORE_CLASSES.map(()=>'?').join(',')})
    ORDER BY s.grade, s.name
  `).all(...CORE_CLASSES);

  const body = `
  <section class="card">
    <div style="display:flex;gap:.8rem;flex-wrap:wrap;align-items:center;justify-content:space-between">
      <a role="button" class="muted" href="/students/new">Add student</a>
      <input id="q" placeholder="Search…" style="min-width:240px">
    </div>
    <div style="overflow:auto;margin-top:.6rem">
      <table id="tbl">
        <thead><tr><th>Name</th><th>Grade</th>${showPhone?'<th>Phone</th>':''}<th>QR</th><th>Actions</th></tr></thead>
        <tbody>
          ${students.map(s=>`
            <tr>
              <td data-k="n">${s.name}</td>
              <td>${s.grade}</td>
              ${showPhone?`<td data-k="p">${s.phone||''}</td>`:''}
              <td><a role="button" class="muted" href="/students/${s.id}/qr">View</a></td>
              <td style="display:flex;gap:.5rem">
                <form method="post" action="/students/${s.id}/delete" onsubmit="return confirm('Delete ${s.name}?');">
                  <button type="submit" class="danger">Delete</button>
                </form>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${students.length? '':'<p class="small">No students yet.</p>'}
    </div>
  </section>
  <script>
    const q=document.getElementById('q');
    q?.addEventListener('input',()=>{
      const t=q.value.toLowerCase();
      for(const tr of document.querySelectorAll('#tbl tbody tr')){
        const name=(tr.querySelector('[data-k="n"]')?.textContent||'').toLowerCase();
        const phone=(tr.querySelector('[data-k="p"]')?.textContent||'').toLowerCase();
        tr.style.display=(name.includes(t)||phone.includes(t))?'':'none';
      }
    });
  </script>`;
  res.send(page('Students', body));
});

app.get('/students/new',(req,res)=>{
  const body = `
  <section class="card">
    <form method="post" action="/students/new" class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem">
      <label>Full name<input name="name" required></label>
      <label>Phone<input name="phone" placeholder="07XXXXXXXX"></label>
      <label>Grade
        <select name="grade" required>${CORE_CLASSES.map(t=>`<option>${t}</option>`).join('')}</select>
      </label>
      <div style="grid-column:1/-1;display:flex;gap:1rem">
        <button type="submit">Save</button>
        <a role="button" class="muted" href="/students">Cancel</a>
      </div>
    </form>
  </section>`;
  res.send(page('Add student', body));
});

app.post('/students/new', (req,res)=>{
  const { name, phone, grade } = req.body;
  if(!name?.trim() || !CORE_CLASSES.includes(grade)) return res.redirect('/students/new');
  const info = db.prepare(`INSERT INTO students(name,phone,grade) VALUES (?,?,?)`).run(name.trim(), phone||'', grade);
  const token = signStudentId(info.lastInsertRowid);
  db.prepare(`UPDATE students SET qr_token=? WHERE id=?`).run(token, info.lastInsertRowid);
  const classId = db.prepare(`SELECT id FROM classes WHERE title=?`).get(grade)?.id;
  if(classId) db.prepare(`INSERT OR IGNORE INTO enrollments(student_id,class_id) VALUES (?,?)`).run(info.lastInsertRowid, classId);
  res.redirect('/students');
});

app.post('/students/:id/delete', (req,res)=>{
  const id = Number(req.params.id);
  const tx = db.transaction(()=>{
    db.prepare(`DELETE FROM payments WHERE student_id=?`).run(id);
    db.prepare(`DELETE FROM attendance WHERE student_id=?`).run(id);
    db.prepare(`DELETE FROM enrollments WHERE student_id=?`).run(id);
    db.prepare(`DELETE FROM students WHERE id=?`).run(id);
  }); tx();
  res.redirect('/students');
});

/* ---------- QR Print (name + QR only) ---------- */
app.get('/students/:id/qr', async (req,res)=>{
  const s = db.prepare(`SELECT * FROM students WHERE id=?`).get(Number(req.params.id));
  if(!s) return res.status(404).send('Not found');
  const img = await QRCode.toDataURL(`${BASE}/scan/${encodeURIComponent(s.qr_token)}`, { margin:1, width:500 });
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${s.name}</title>
  <style>
    body{background:#fff;color:#000;text-align:center;font-family:system-ui,arial}
    h2{margin:.6rem 0}
    img{width:300px;height:300px;margin:.5rem 0}
    @media print{button{display:none}}
  </style></head>
  <body>
    <h2>${s.name}</h2>
    <img src="${img}" alt="QR">
    <div><button onclick="window.print()">Print</button></div>
  </body></html>`);
});

/* ---------- Scanner (QR + sounds + manual) ---------- */
app.get('/scanner', (req,res)=>{
  const head = `<script src="https://unpkg.com/html5-qrcode" defer></script>`;
  const body = `
  <section class="card">
    <p class="small">Scan a student QR to mark <strong>today</strong> present in their class, or use manual attendance by phone.</p>

    <audio id="ok" preload="auto"   src="data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////8AAAABAAACCgAAAwABAAACcQCA//////////8AAAABAAACCgAAAAAAAAAAAAAAAAAAAA"></audio>
    <audio id="err" preload="auto"  src="data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA//////////8AAAABAAACCgAAAwABAAACcQCA//////////8AAAABAAACCgAAAAAAAAAAAAAAAAAAAA"></audio>

    <div id="reader" style="max-width:520px;margin:auto"></div>
    <div id="live" class="banner success" style="display:none;margin-top:.8rem"></div>
    <div id="bad"  class="banner error"   style="display:none;margin-top:.8rem"></div>

    <article class="card" style="margin-top:1rem">
      <strong>Manual attendance (by phone)</strong>
      <div style="display:flex;gap:.8rem;flex-wrap:wrap;align-items:center;margin-top:.5rem">
        <input id="mphone" placeholder="07XXXXXXXX" style="min-width:240px">
        <button id="mbtn">Mark present</button>
      </div>
    </article>

    <div id="paywrap" style="display:none;margin-top:.6rem">
      <a id="paybtn" href="#" role="button" class="muted">Pay now</a>
    </div>
  </section>

  <script>
    function play(ok){ try{ const a=document.getElementById(ok?'ok':'err'); a.currentTime=0; a.play(); }catch(e){} }
    function show(el,txt){ const n=document.getElementById(el); n.textContent=txt; n.style.display='block'; }
    function hide(id){ document.getElementById(id).style.display='none'; }
    function setPay(t){ const w=document.getElementById('paywrap'); const a=document.getElementById('paybtn'); if(t){ a.href='/pay?token='+encodeURIComponent(t); w.style.display='block'; } else w.style.display='none'; }
    function extractToken(txt){ try{ if(txt.startsWith('http')){ const u=new URL(txt); const p=u.pathname.split('/').filter(Boolean); return p[p.length-1]||''; } }catch{} return txt.split('/').pop(); }

    const last=new Map();
    async function mark(token){
      const now=Date.now(); if(last.has(token) && now-last.get(token)<2200) return; last.set(token,now);
      try{
        const r=await fetch('/scan/'+encodeURIComponent(token)+'/auto',{method:'POST'}); const d=await r.json();
        if(d.ok){ hide('bad'); show('live', d.student.name+' · '+d.class+' · '+d.date + (d.paid?' · Paid':' · Unpaid')); setPay(token); play(true); }
        else{ hide('live'); show('bad', d.error||'Error'); setPay(null); play(false); }
      }catch{ hide('live'); show('bad','Network error'); setPay(null); play(false); }
    }

    document.addEventListener('DOMContentLoaded', ()=>{
      if(window.Html5QrcodeScanner){
        const sc=new Html5QrcodeScanner('reader',{fps:12,qrbox:250,rememberLastUsedCamera:true});
        sc.render((txt)=>mark(extractToken(txt)));
      }
      document.getElementById('mbtn')?.addEventListener('click', async ()=>{
        const phone=(document.getElementById('mphone')?.value||'').trim();
        if(!phone){ show('bad','Enter phone'); play(false); return; }
        try{
          const r=await fetch('/attendance/manual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone})});
          const d=await r.json();
          if(d.ok){ hide('bad'); show('live', d.student.name+' · '+d.class+' · '+d.date + (d.paid?' · Paid':' · Unpaid')); setPay(d.token); play(true); }
          else{ hide('live'); show('bad', d.error||'Could not mark'); setPay(null); play(false); }
        }catch{ hide('live'); show('bad','Network error'); setPay(null); play(false); }
      });
    });
  </script>`;
  res.send(page('Scanner', body, head));
});

/* Scanner API */
app.post('/scan/:token/auto', (req,res)=>{
  try{
    const sid = unsignToken(req.params.token);
    const student = db.prepare(`SELECT * FROM students WHERE id=?`).get(sid);
    if(!student) return res.json({ok:false, error:'Student not found'});

    const clazz = findOrEnsureStudentClass(student);
    if(!clazz) return res.json({ok:false, error:'Class unavailable'});

    const date = todayISO(); const m = monthKey(new Date(date));
    db.prepare(`
      INSERT INTO attendance(student_id,class_id,date,present)
      VALUES(?,?,?,1)
      ON CONFLICT(student_id,class_id,date) DO UPDATE SET present=1
    `).run(sid, clazz.id, date);

    const paid = hasPaidMonth(sid, clazz.id, m);
    res.json({ ok:true, student:{id:sid,name:student.name}, class:clazz.title, date, month:m, paid });
  }catch{ res.json({ok:false, error:'Bad token'}); }
});

/* Manual attendance by phone */
app.post('/attendance/manual', (req,res)=>{
  try{
    const phone = (req.body?.phone||'').toString().trim();
    if(!phone) return res.json({ok:false, error:'Phone required'});
    let student = db.prepare(`SELECT * FROM students WHERE phone=?`).get(phone);
    if(!student){
      const matches = db.prepare(`SELECT * FROM students WHERE phone LIKE ?`).all(`%${phone}%`);
      if(matches.length===1) student = matches[0];
      else return res.json({ok:false, error: matches.length>1?'Multiple matches':'Student not found'});
    }
    const clazz = findOrEnsureStudentClass(student);
    if(!clazz) return res.json({ok:false, error:'Class unavailable'});

    const date = todayISO(); const m = monthKey(new Date(date));
    db.prepare(`
      INSERT INTO attendance(student_id,class_id,date,present)
      VALUES(?,?,?,1)
      ON CONFLICT(student_id,class_id,date) DO UPDATE SET present=1
    `).run(student.id, clazz.id, date);

    const paid = hasPaidMonth(student.id, clazz.id, m);
    const token = db.prepare(`SELECT qr_token FROM students WHERE id=?`).get(student.id)?.qr_token || '';
    res.json({ ok:true, token, student:{id:student.id,name:student.name}, class:clazz.title, date, month:m, paid });
  }catch{ res.json({ok:false, error:'Failed'}); }
});

/* ---------- Payments & Finance ---------- */
app.get('/pay', (req,res)=>{
  try{
    const token = (req.query.token||'').toString();
    const sid = unsignToken(token);
    const student = db.prepare(`SELECT * FROM students WHERE id=?`).get(sid);
    if(!student) return res.status(404).send('Not found');
    const clazz = findOrEnsureStudentClass(student);
    if(!clazz) return res.status(400).send('Class not set');

    const m = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month))? req.query.month : monthKey();
    const fee = db.prepare(`SELECT fee FROM classes WHERE id=?`).get(clazz.id)?.fee || Number(getSetting('default_fee')||'2000');
    const cur = getSetting('currency_symbol','Rs.');
    const already = hasPaidMonth(sid, clazz.id, m);

    const body = `
    <section class="card">
      <h3>${student.name}</h3>
      <p class="small">${clazz.title}${student.phone ? ' · '+student.phone : ''}</p>
      <p>Month: <strong>${m}</strong> — ${already?'<span class="small">Already paid</span>':'<span class="small">Unpaid</span>'}</p>
      <form method="post" action="/pay" class="form-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem">
        <input type="hidden" name="token" value="${token}">
        <input type="hidden" name="class_id" value="${clazz.id}">
        <label>Month (YYYY-MM) <input name="month" value="${m}" pattern="\\d{4}-\\d{2}" required></label>
        <label>Amount (${cur}) <input type="number" min="0" name="amount" value="${fee}" required></label>
        <label>Method
          <select name="method"><option>cash</option><option>bank</option><option>online</option></select>
        </label>
        <div style="grid-column:1/-1;display:flex;gap:1rem">
          <button type="submit">Save payment</button>
          <a role="button" class="muted" href="/scanner">Back to scanner</a>
        </div>
      </form>
    </section>`;
    res.send(page('Record payment', body));
  }catch{ res.status(400).send('Bad token'); }
});

app.post('/pay', (req,res)=>{
  try{
    const sid = unsignToken((req.body.token||'').toString());
    const classId = Number(req.body.class_id);
    const m   = (req.body.month && /^\d{4}-\d{2}$/.test(req.body.month))? req.body.month : monthKey();
    const amt = Math.max(0, Number(req.body.amount||0));
    const method = (req.body.method||'cash').toString();

    db.prepare(`
      INSERT INTO payments(student_id,class_id,month,amount,method)
      VALUES(?,?,?,?,?)
      ON CONFLICT(student_id,class_id,month) DO UPDATE
      SET amount=excluded.amount, method=excluded.method
    `).run(sid, classId, m, amt, method);

    res.redirect(`/unpaid?month=${encodeURIComponent(m)}`);
  }catch{ res.status(400).send('Bad token'); }
});

app.get('/finance', (req,res)=>{
  const m = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey();
  const cur = getSetting('currency_symbol','Rs.');
  const classes = db.prepare(`SELECT id,title,fee FROM classes WHERE title IN (${CORE_CLASSES.map(()=>'?').join(',')}) ORDER BY title`).all(...CORE_CLASSES);

  const rows = classes.map(c=>{
    const enrolled = db.prepare(`SELECT COUNT(*) AS n FROM enrollments WHERE class_id=?`).get(c.id).n;
    const agg = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum FROM payments WHERE class_id=? AND month=?`).get(c.id, m);
    return { c, enrolled, paid: agg.n, unpaid: Math.max(0, enrolled-agg.n), revenue: agg.sum||0 };
  });

  const payments = db.prepare(`
    SELECT p.amount, p.method, p.created_at,
           s.name AS student, s.phone AS phone,
           c.title AS class
      FROM payments p
      JOIN students s ON s.id=p.student_id
      JOIN classes  c ON c.id=p.class_id
     WHERE p.month=? AND c.title IN (${CORE_CLASSES.map(()=>'?').join(',')})
     ORDER BY p.created_at DESC
  `).all(m, ...CORE_CLASSES);

  const total = rows.reduce((t,r)=>t+r.revenue,0);

  const body = `
  <section class="card">
    <form method="get" action="/finance" style="display:flex;gap:.8rem;flex-wrap:wrap;align-items:end">
      <label>Month (YYYY-MM) <input name="month" value="${m}" pattern="\\d{4}-\\d{2}" required></label>
      <button type="submit">Show</button>
      <a role="button" class="muted" href="/finance.csv?month=${encodeURIComponent(m)}">Download CSV</a>
    </form>

    <h3 style="margin-top:.6rem">Summary</h3>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Class</th><th>Enrolled</th><th>Paid</th><th>Unpaid</th><th>Revenue (${cur})</th></tr></thead>
        <tbody>
          ${rows.map(r=>`<tr><td>${r.c.title}</td><td>${r.enrolled}</td><td>${r.paid}</td><td>${r.unpaid}</td><td>${r.revenue}</td></tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="4" style="text-align:right"><strong>Total</strong></td><td><strong>${total}</strong></td></tr></tfoot>
      </table>
    </div>

    <h3>Payments in ${m}</h3>
    <div style="overflow:auto">
      ${payments.length?`
      <table>
        <thead><tr><th>When</th><th>Student</th><th>Phone</th><th>Class</th><th>Amount (${cur})</th><th>Method</th></tr></thead>
        <tbody>
          ${payments.map(p=>`<tr><td>${p.created_at}</td><td>${p.student}</td><td>${p.phone||''}</td><td>${p.class}</td><td>${p.amount}</td><td>${p.method}</td></tr>`).join('')}
        </tbody>
      </table>`:'<p class="small">No payments yet.</p>'}
    </div>
  </section>`;
  res.send(page('Finance', body));
});

app.get('/finance.csv', (req,res)=>{
  const m = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey();
  const rows = db.prepare(`
    SELECT p.created_at, s.name AS student, s.phone, c.title AS class, p.amount, p.method
      FROM payments p
      JOIN students s ON s.id=p.student_id
      JOIN classes  c ON c.id=p.class_id
     WHERE p.month=? AND c.title IN (${CORE_CLASSES.map(()=>'?').join(',')})
     ORDER BY p.created_at DESC
  `).all(m, ...CORE_CLASSES);
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payments_${m}.csv"`);
  const head = 'created_at,student,phone,class,amount,method\n';
  const body = rows.map(r=>[r.created_at,r.student,r.phone||'',r.class,r.amount,r.method]
    .map(x=>`"${String(x).replaceAll('"','""')}"`).join(',')).join('\n');
  res.send(head + body);
});

/* ---------- Attendance Sheet ---------- */
app.get('/attendance-sheet', (req,res)=>{
  const classes = db.prepare(`SELECT * FROM classes WHERE title IN (${CORE_CLASSES.map(()=>'?').join(',')}) ORDER BY title`).all(...CORE_CLASSES);
  const classTitle = req.query.class && CORE_CLASSES.includes(req.query.class) ? req.query.class : (classes[0]?.title || 'Grade 6');
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) ? req.query.date : todayISO();
  const m = monthKey(new Date(date));
  const clazz = db.prepare(`SELECT * FROM classes WHERE title=?`).get(classTitle);

  const students = db.prepare(`
    SELECT s.* FROM enrollments e
    JOIN students s ON s.id=e.student_id
    WHERE e.class_id=? ORDER BY s.name
  `).all(clazz?.id || 0);

  const presence = new Map(db.prepare(`SELECT student_id,present FROM attendance WHERE class_id=? AND date=?`).all(clazz?.id||0, date).map(r=>[r.student_id, !!r.present]));
  const paidset  = new Set(db.prepare(`SELECT student_id FROM payments WHERE class_id=? AND month=?`).all(clazz?.id||0, m).map(r=>r.student_id));
  const showPhone = getSetting('show_phone')==='1';

  const body = `
  <section class="card">
    <form method="get" action="/attendance-sheet" style="display:flex;gap:.8rem;flex-wrap:wrap;align-items:end">
      <label>Class <select name="class">${classes.map(c=>`<option ${c.title===classTitle?'selected':''}>${c.title}</option>`).join('')}</select></label>
      <label>Date <input type="date" name="date" value="${date}"></label>
      <button type="submit">Show</button>
      <a class="muted" role="button" href="/scanner">Open Scanner</a>
    </form>
    <div style="overflow:auto;margin-top:.6rem">
      <table>
        <thead><tr><th>Present</th><th>Student</th>${showPhone?'<th>Phone</th>':''}<th>Paid (${m})</th></tr></thead>
        <tbody>
          ${students.map(s=>`
            <tr>
              <td>${presence.get(s.id)?'Yes':'—'}</td>
              <td>${s.name}</td>
              ${showPhone?`<td>${s.phone||''}</td>`:''}
              <td>${paidset.has(s.id)?'Yes':'—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </section>`;
  res.send(page('Attendance Sheet', body));
});

/* ---------- Unpaid Students (current/selected month) ---------- */
app.get('/unpaid', (req,res)=>{
  const m = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey();
  const list = db.prepare(`
    SELECT s.id, s.name, s.phone, s.grade, c.id AS class_id, c.title AS class_title
      FROM students s
 LEFT JOIN enrollments e ON e.student_id=s.id
 LEFT JOIN classes     c ON c.id=e.class_id
 LEFT JOIN payments    p ON p.student_id=s.id AND p.class_id=c.id AND p.month=?
     WHERE c.title IN (${CORE_CLASSES.map(()=>'?').join(',')})
       AND p.id IS NULL
  ORDER BY c.title, s.name
  `).all(m, ...CORE_CLASSES);

  const rows = list.map(u=>{
    const token = db.prepare(`SELECT qr_token FROM students WHERE id=?`).get(u.id)?.qr_token || '';
    return `<tr>
      <td>${u.name}</td>
      <td>${u.class_title||u.grade}</td>
      <td>${u.phone||''}</td>
      <td><a class="muted" role="button" href="/pay?token=${encodeURIComponent(token)}&month=${encodeURIComponent(m)}">Mark Paid</a></td>
    </tr>`;
  }).join('');

  const body = `
  <section class="card">
    <form method="get" action="/unpaid" style="display:flex;gap:.8rem;flex-wrap:wrap;align-items:end">
      <label>Month (YYYY-MM) <input name="month" value="${m}" pattern="\\d{4}-\\d{2}" required></label>
      <button type="submit">Filter</button>
      <a role="button" class="muted" href="/finance?month=${encodeURIComponent(m)}">Open Finance</a>
    </form>
    <div style="overflow:auto;margin-top:.6rem">
      <table>
        <thead><tr><th>Student</th><th>Class</th><th>Phone</th><th>Action</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="small">Everyone is paid.</td></tr>'}</tbody>
      </table>
    </div>
  </section>`;
  res.send(page('Unpaid Students', body));
});

/* ======================== Init & Start ======================== */
if (process.argv.includes('--initdb')) { initDb(); ensureCoreClasses(); console.log('DB initialized at', DB_PATH); process.exit(0); }
if (process.argv.includes('--seed'))   { initDb(); ensureCoreClasses(); console.log('Seeded'); process.exit(0); }
initDb(); ensureCoreClasses();

app.listen(PORT, ()=>console.log(`✅ Class Manager running at ${BASE} (DB: ${DB_PATH})`));
