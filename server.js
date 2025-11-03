import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import crypto from 'crypto';

/* ============== Setup ============== */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = Number(process.env.PORT || 5050);
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const SECRET = process.env.APP_SECRET || 'dev-secret-lite';

const CORE_CLASSES = ['Grade 6','Grade 7','Grade 8','O/L'];

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ============== DB ============== */
const db = new Database(path.join(__dirname, 'class_manager.db'));
db.pragma('journal_mode = wal');

function addCol(table, name, type){ try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run(); } catch {} }

function initSettings(){
  db.prepare(`CREATE TABLE IF NOT EXISTS settings(
    key TEXT PRIMARY KEY,
    value TEXT
  )`).run();

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
    for (const [k,v] of Object.entries(defaults)) {
      db.prepare(`INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)`).run(k, v);
    }
  }); tx();
}
const getSetting = (k, f='') => db.prepare(`SELECT value FROM settings WHERE key=?`).get(k)?.value ?? f;
const setSetting = (k, v) => db.prepare(`
  INSERT INTO settings(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`).run(k, v);

function ensurePaymentsUniqueIndex(){
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_unique ON payments(student_id, class_id, month)`).run();
}

/* Schema */
function initDb(){
  db.prepare(`CREATE TABLE IF NOT EXISTS students(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    grade TEXT NOT NULL,
    qr_token TEXT UNIQUE
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS classes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL UNIQUE,
    fee INTEGER NOT NULL DEFAULT 2000
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS enrollments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    UNIQUE(student_id, class_id)
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS attendance(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    date TEXT NOT NULL,             -- yyyy-mm-dd
    present INTEGER NOT NULL DEFAULT 1,
    UNIQUE(student_id, class_id, date)
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS payments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    class_id INTEGER NOT NULL,
    month TEXT NOT NULL,            -- yyyy-mm
    amount INTEGER NOT NULL DEFAULT 2000,
    method TEXT DEFAULT 'cash',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(student_id, class_id, month)
  )`).run();

  addCol('classes','fee','INTEGER');
  ensurePaymentsUniqueIndex();
  initSettings();
}

function ensureCoreClasses(){
  const have = new Set(db.prepare(`SELECT title FROM classes`).all().map(r=>r.title));
  const tx = db.transaction(()=>{
    for(const title of CORE_CLASSES){
      const feeKey = title === 'O/L' ? 'fee_O_L' : `fee_${title.replace(' ', '')}`;
      const want = Number(getSetting(feeKey) || getSetting('default_fee') || '2000');
      if(!have.has(title)) db.prepare(`INSERT INTO classes(title, fee) VALUES (?, ?)`).run(title, want);
      else db.prepare(`UPDATE classes SET fee=? WHERE title=?`).run(want, title);
    }
  }); tx();
}
function seedDb(){ ensureCoreClasses(); }

/* ============== Helpers ============== */
const todayISO  = () => new Date().toISOString().slice(0,10);
const monthKey  = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
const cleanToken = (t) => (t||'').toString().trim().replace(/^\/+|\/+$/g,'');

const pickTheme = (v) => (['light','dark','auto'].includes(String(v)) ? String(v) : 'dark');
const sanitizeColor = (v) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(v||'')) ? String(v) : '#0ea5e9';
const moneyInt = (v, fb) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? String(Math.floor(n)) : String(fb);
};
const oneZero = (v) => (String(v)==='0' ? '0' : '1');

function signStudentId(id){
  const payload = JSON.stringify({ sid:id });
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + mac;
}
function unsignToken(token){
  const t = cleanToken(token);
  const [b64, mac] = t.split('.');
  if(!b64 || !mac) throw new Error('bad token');
  const payload = Buffer.from(b64,'base64url').toString();
  const want = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  if(!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) throw new Error('bad mac');
  const { sid } = JSON.parse(payload);
  return Number(sid);
}

function findOrEnsureStudentClass(student){
  const exact = db.prepare(`
    SELECT c.id, c.title, c.fee
    FROM enrollments e JOIN classes c ON c.id=e.class_id
    WHERE e.student_id=? AND c.title=? LIMIT 1
  `).get(student.id, student.grade);
  if (exact) return exact;

  const anyCore = db.prepare(`
    SELECT c.id, c.title, c.fee
    FROM enrollments e JOIN classes c ON c.id=e.class_id
    WHERE e.student_id=? AND c.title IN (${CORE_CLASSES.map(()=>'?').join(',')})
    ORDER BY c.title LIMIT 1
  `).get(student.id, ...CORE_CLASSES);
  if (anyCore) return anyCore;

  if (!CORE_CLASSES.includes(student.grade)) return null;
  const classRow = db.prepare(`SELECT id, title, fee FROM classes WHERE title=?`).get(student.grade);
  if (!classRow) return null;
  db.prepare(`INSERT OR IGNORE INTO enrollments(student_id, class_id) VALUES (?,?)`).run(student.id, classRow.id);
  return classRow;
}
const hasPaidMonth = (sid,cid,m) =>
  !!db.prepare(`SELECT 1 FROM payments WHERE student_id=? AND class_id=? AND month=? LIMIT 1`).get(sid,cid,m);

/* ============== UI Frame (Dark + aligned top bar) ============== */
function page(title, body, head='', opts={}){
  const org = getSetting('org_name','Class Manager');
  const theme = pickTheme(getSetting('theme','dark'));
  const primary = sanitizeColor(getSetting('primary_color','#0ea5e9'));
  const themeAttr = theme==='auto' ? '' : `data-theme="${theme}"`;
  const banner = opts.banner ? `<div class="banner success">${opts.banner}</div>` :
                 (opts.error ? `<div class="banner error">${opts.error}</div>` : '');

  return `<!doctype html><html ${themeAttr}><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${org} — ${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@1/css/pico.min.css">
<style>
*,*::before,*::after{ box-sizing:border-box }
html{ background:#0a0f1a; color:#e5eef8 }
body{ line-height:1.45 }
img{ max-width:100%; height:auto; }

:root{
  --brand:${primary};
  --pico-primary: var(--brand);
  --card-bg:#0b1220;
  --text:#e5eef8;
  --muted:#9fb4cb;
  --border:#1f2a44;
  --chip:#0f172a;
  --chip-hover:#12203a;
}
:root[data-theme="light"]{
  --card-bg:#ffffff; --text:#111827; --muted:#6b7280; --border:#d1d5db; --chip:#f3f4f6; --chip-hover:#e5e7eb;
}

/* Top bar (aligned brand + buttons) */
.container{ max-width:1080px; padding-inline:16px; }
.top {
  display:flex; align-items:center; justify-content:space-between;
  gap:2rem; margin:1.8rem 0 2.4rem; flex-wrap:wrap;
}
.top .brand{
  font-weight:700; text-decoration:none; color:var(--text);
  padding:.9rem 1.5rem; border-radius:1rem;
  border:1px solid var(--border); background:var(--chip);
  font-size:1.05rem; display:flex; align-items:center; justify-content:center;
  min-width:160px; text-align:center;
}
.top .nav{ display:flex; gap:1.2rem; flex-wrap:wrap; justify-content:center; }
.top .nav a{
  all:unset;
  display:inline-flex !important; align-items:center !important; justify-content:center !important;
  min-width:120px; text-align:center;
  padding:.75rem 1.2rem !important; border-radius:1rem !important;
  border:1px solid var(--border) !important;
  background:var(--chip) !important; color:#dfe9ff !important;
  font-weight:600 !important; cursor:pointer !important; text-decoration:none !important;
  transition:all .15s ease-in-out !important;
}
.top .nav a:hover{ transform:translateY(-1px); background:var(--chip-hover) !important; border-color:#2a3a5d !important; }
.top .nav a.primary{ background:var(--brand) !important; border-color:var(--brand) !important; color:#0b1220 !important; box-shadow:0 0 8px color-mix(in srgb, var(--brand) 40%, transparent); }

/* Cards / tables / buttons */
.card{ border:1px solid var(--border); border-radius:1rem; padding:1.2rem; background:var(--card-bg); box-shadow:0 8px 28px rgba(3,7,18,.35) }
.small{ color:var(--muted); font-size:.95rem }
table{ width:100%; border-collapse:separate; border-spacing:0 }
th,td{ vertical-align:middle }
thead th{ background:#0f172a; color:#dce8f6; position:sticky; top:0; z-index:1 }
tbody tr:nth-child(odd){ background:#0e1627 }
tbody td, thead th{ padding:.65rem .75rem }

input,select,button,a[role="button"]{ border-radius:.55rem }
a[role="button"], button, table a, table button{
  display:inline-flex; align-items:center; justify-content:center;
  padding:.55rem .9rem; font-weight:600; cursor:pointer;
  border:1px solid var(--border); background:var(--chip); color:#e5eef8; text-decoration:none;
}
a[role="button"].muted, button.muted, table a.muted, table button.muted{ color:#d6e4ff; background:#0c1424; border-color:#2b3a5a }
a[role="button"].muted:hover, button.muted:hover, table a.muted:hover, table button.muted:hover{ background:#13213a }
button.danger, .danger{ background:#2a0f14 !important; border-color:#7a2030 !important; color:#ffd7db !important }
button.danger:hover, .danger:hover{ background:#3b141b !important; border-color:#973043 !important }

:focus-visible{ outline:3px solid color-mix(in oklab, var(--brand) 55%, #0000); outline-offset:2px; border-radius:.5rem }
.banner{ border-radius:.8rem; padding:.7rem 1rem; margin:.9rem 0 1.1rem; border:1px solid }
.banner.success{ background:#0d1f16; border-color:#217a4b; color:#b5f3c9 }
.banner.error{ background:#2b1010; border-color:#a04040; color:#f3c0c0 }

/* Forms */
.form-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:1rem }
.form-grid > label{ display:block }
.form-grid hr{ grid-column:1/-1; border:0; height:1px; background:var(--border); margin:.5rem 0 }

/* Scanner alerts */
#live{ background:#0d1f16; border-color:#217a4b; color:#b5f3c9 }
#err { background:#2b1010; border-color:#a04040; color:#f3c0c0 }

footer{ color:#8aa1bb }

@media print{ .top, .print-hidden, .banner { display:none !important } }
@media (max-width:900px){
  .top .nav a span{ display:none }
  .top .nav a{ min-width:auto; padding:.6rem .8rem !important }
}
</style>
${head}
</head><body>
<main class="container">
  <nav class="top print-hidden">
    <a class="brand" href="/">${org}</a>
    <div class="nav">
      <a href="/students"><span>Students</span></a>
      <a class="primary" href="/scanner"><span>Scanner</span></a>
      <a href="/attendance-sheet"><span>Attendance</span></a>
      <a href="/finance"><span>Finance</span></a>
      <a href="/settings"><span>Settings</span></a>
    </div>
  </nav>

  ${banner}
  <h2>${title}</h2>
  ${body}

  <footer class="print-hidden" style="margin-top:2rem">
    <small>© ${new Date().getFullYear()} ${org} — Created by Pulindu Pansilu</small>
  </footer>
</main>
</body></html>`;
}

/* ============== Routes ============== */
/* Dashboard */
app.get('/', (req,res)=>{
  const m = monthKey();
  const stats = db.prepare(`
    SELECT c.title,
           COUNT(e.id) AS students,
           COALESCE(SUM(CASE WHEN p.month = ? THEN 1 ELSE 0 END),0) AS paidCount
      FROM classes c
 LEFT JOIN enrollments e ON e.class_id=c.id
 LEFT JOIN payments p    ON p.class_id=c.id AND p.student_id=e.student_id
     WHERE c.title IN (${CORE_CLASSES.map(()=>'?').join(',')})
  GROUP BY c.id
  ORDER BY c.title
  `).all(m, ...CORE_CLASSES);

  const body = `
  <section class="card">
    <div class="small">Month: <strong>${m}</strong></div>
    <div style="overflow:auto; margin-top:.6rem">
      <table>
        <thead><tr><th>Class</th><th>Students</th><th>Paid (this month)</th><th>Attendance</th></tr></thead>
        <tbody>
          ${stats.map(r=>`
            <tr>
              <td>${r.title}</td>
              <td>${r.students}</td>
              <td>${r.paidCount}</td>
              <td><a href="/attendance-sheet?class=${encodeURIComponent(r.title)}&date=${todayISO()}" role="button" class="muted">Open sheet</a></td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${stats.length ? '' : '<p class="small">No classes yet.</p>'}
    </div>
  </section>`;
  res.send(page('Dashboard', body));
});

/* Settings */
app.get('/settings', (req,res)=>{
  const org       = getSetting('org_name');
  const currency  = getSetting('currency_symbol');
  const theme     = pickTheme(getSetting('theme'));
  const primary   = sanitizeColor(getSetting('primary_color'));
  const showPhone = getSetting('show_phone') === '1';

  const defFee = getSetting('default_fee') || '2000';
  const fee6  = getSetting('fee_Grade6') || defFee;
  const fee7  = getSetting('fee_Grade7') || defFee;
  const fee8  = getSetting('fee_Grade8') || defFee;
  const feeOL = getSetting('fee_O_L')    || defFee;

  const saved = req.query.saved === '1';

  const body = `
  <section class="card">
    <form method="post" action="/settings" class="form-grid">
      <label>Institute / Brand name
        <input name="org_name" value="${org}" required>
      </label>
      <label>Currency symbol
        <input name="currency_symbol" value="${currency}" required>
      </label>
      <label>Theme
        <select name="theme">
          <option ${theme==='auto'?'selected':''} value="auto">Auto</option>
          <option ${theme==='light'?'selected':''} value="light">Light</option>
          <option ${theme==='dark'?'selected':''} value="dark">Dark</option>
        </select>
      </label>
      <label>Primary color
        <input name="primary_color" type="color" value="${primary}">
      </label>
      <label>Show phone numbers
        <select name="show_phone">
          <option value="1" ${showPhone?'selected':''}>Yes</option>
          <option value="0" ${!showPhone?'selected':''}>No</option>
        </select>
      </label>

      <hr/>

      <label>Default monthly fee
        <input name="default_fee" type="number" min="0" value="${defFee}" required>
      </label>
      <label>Grade 6 fee
        <input name="fee_Grade6" type="number" min="0" value="${fee6}" required>
      </label>
      <label>Grade 7 fee
        <input name="fee_Grade7" type="number" min="0" value="${fee7}" required>
      </label>
      <label>Grade 8 fee
        <input name="fee_Grade8" type="number" min="0" value="${fee8}" required>
      </label>
      <label>O/L fee
        <input name="fee_O_L" type="number" min="0" value="${feeOL}" required>
      </label>

      <div style="grid-column:1/-1;display:flex;gap:1.2rem">
        <button type="submit">Save settings</button>
        <a class="muted" role="button" href="/">Back</a>
      </div>
    </form>
  </section>`;
  res.send(page('Settings', body, '', saved ? { banner: 'Settings saved.' } : {}));
});

app.post('/settings', (req,res)=>{
  const b = req.body || {};
  const updates = {
    org_name:        String(b.org_name ?? '').trim() || getSetting('org_name','Class Manager'),
    currency_symbol: String(b.currency_symbol ?? '').trim() || getSetting('currency_symbol','Rs.'),
    theme:           pickTheme(b.theme),
    primary_color:   sanitizeColor(b.primary_color),
    show_phone:      oneZero(b.show_phone),
    default_fee:     moneyInt(b.default_fee, getSetting('default_fee') || '2000'),
    fee_Grade6:      moneyInt(b.fee_Grade6, getSetting('fee_Grade6') || '2000'),
    fee_Grade7:      moneyInt(b.fee_Grade7, getSetting('fee_Grade7') || '2000'),
    fee_Grade8:      moneyInt(b.fee_Grade8, getSetting('fee_Grade8') || '2000'),
    fee_O_L:         moneyInt(b.fee_O_L,  getSetting('fee_O_L')  || '2000'),
  };
  for(const [k,v] of Object.entries(updates)) setSetting(k, v);
  ensureCoreClasses();
  res.redirect('/settings?saved=1');
});

/* Students list */
app.get('/students', (req,res)=>{
  const showPhone = getSetting('show_phone','1')==='1';
  const students = db.prepare(`
    SELECT s.*, c.title AS class_title
      FROM students s
 LEFT JOIN enrollments e ON e.student_id=s.id
 LEFT JOIN classes c ON c.id=e.class_id
     WHERE c.title IS NULL OR c.title IN (${CORE_CLASSES.map(()=>'?').join(',')})
  ORDER BY s.grade, s.name
  `).all(...CORE_CLASSES);

  const body = `
  <section class="card">
    <div style="display:flex;gap:1.2rem;flex-wrap:wrap;align-items:center;justify-content:space-between">
      <a href="/students/new" role="button" class="muted">Add student</a>
      <input id="search" placeholder="Search by name or phone…" style="min-width:260px">
    </div>
    <div style="overflow:auto;margin-top:.8rem">
      <table id="tbl">
        <thead><tr><th>Name</th><th>Grade</th>${showPhone?'<th>Phone</th>':''}<th>QR</th><th class="print-hidden">Actions</th></tr></thead>
        <tbody>
          ${students.map(s=>`
            <tr>
              <td data-k="n">${s.name}</td>
              <td>${s.grade}</td>
              ${showPhone?`<td data-k="p">${s.phone||''}</td>`:''}
              <td><img src="/qr/${encodeURIComponent(s.qr_token)}.png" width="88" height="88" alt="QR"></td>
              <td class="print-hidden" style="white-space:nowrap;display:flex;gap:.6rem">
                <a href="/students/${s.id}/qr" role="button" class="muted">Print QR</a>
                <form method="post" action="/students/${s.id}/delete" onsubmit="return confirm('Delete ${s.name}? This removes enrollments, attendance and payments.');">
                  <button type="submit" class="danger">Delete</button>
                </form>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${students.length ? '' : '<p class="small">No students yet. Add your first student.</p>'}
    </div>
  </section>
  <script>
    const q = document.getElementById('search');
    if(q){
      q.addEventListener('input', ()=>{
        const t = q.value.toLowerCase();
        for(const tr of document.querySelectorAll('#tbl tbody tr')){
          const name = (tr.querySelector('[data-k="n"]')?.textContent||'').toLowerCase();
          const phone = (tr.querySelector('[data-k="p"]')?.textContent||'').toLowerCase();
          tr.style.display = (name.includes(t) || phone.includes(t)) ? '' : 'none';
        }
      });
    }
  </script>`;
  res.send(page('Students', body));
});

/* Add student */
app.get('/students/new', (req,res)=>{
  const body = `
  <section class="card">
    <form method="post" action="/students/new" class="form-grid">
      <label>Full name <input name="name" required></label>
      <label>Phone <input name="phone" placeholder="07XXXXXXXX"></label>
      <label>Grade
        <select name="grade" required>${CORE_CLASSES.map(t=>`<option>${t}</option>`).join('')}</select>
      </label>
      <div style="grid-column:1/-1;display:flex;gap:1.2rem">
        <button type="submit">Save</button>
        <a class="muted" role="button" href="/students">Cancel</a>
      </div>
    </form>
  </section>`;
  res.send(page('Add student', body));
});

app.post('/students/new', (req,res)=>{
  const { name, phone, grade } = req.body;
  if(!name?.trim() || !CORE_CLASSES.includes(grade)) {
    return res.send(page('Add student','<section class="card"><div class="banner error">Name & a valid grade are required</div></section>'));
  }
  const info = db.prepare(`INSERT INTO students(name, phone, grade) VALUES (?,?,?)`).run(name.trim(), phone||'', grade);
  const token = signStudentId(info.lastInsertRowid);
  db.prepare(`UPDATE students SET qr_token=? WHERE id=?`).run(token, info.lastInsertRowid);
  const classId = db.prepare(`SELECT id FROM classes WHERE title=?`).get(grade)?.id;
  if(classId) db.prepare(`INSERT OR IGNORE INTO enrollments(student_id, class_id) VALUES (?,?)`).run(info.lastInsertRowid, classId);
  res.redirect('/students');
});

/* Delete student (+cascade) */
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

/* Print QR */
app.get('/students/:id/qr', (req,res)=>{
  const s = db.prepare(`SELECT * FROM students WHERE id=?`).get(Number(req.params.id));
  if(!s) return res.status(404).send('Not found');
  const body = `
  <section class="card" style="text-align:center">
    <h3>${s.name}</h3>
    <p class="small">${s.grade}${s.phone ? ' · '+s.phone : ''}</p>
    <img src="/qr/${encodeURIComponent(s.qr_token)}.png" width="300" height="300" alt="QR">
    <p class="small">Scan on the Scanner page to auto-mark attendance, then record payment if needed.</p>
    <button onclick="window.print()">Print</button>
  </section>`;
  res.send(page('Print QR', body));
});

/* QR PNG */
app.get('/qr/:token.png', async (req,res)=>{
  try { unsignToken(req.params.token); } catch { return res.status(404).send('bad'); }
  const url = `${BASE}/scan/${encodeURIComponent(cleanToken(req.params.token))}`;
  const png = await QRCode.toBuffer(url, { type:'png', margin:1, width:500 });
  res.type('png').send(png);
});

/* Scanner */
app.get('/scanner', (req,res)=>{
  const head = `
    <script src="https://unpkg.com/html5-qrcode" defer></script>
    <style>#reader{max-width:520px;margin:auto} #log>div{margin:.25rem 0}</style>`;
  const body = `
  <section class="card">
    <p class="small">Scan a student QR to mark <strong>today</strong> present in their class, or use manual attendance by phone.</p>
    <div id="reader"></div>

    <article class="card" style="margin-top:1rem">
      <strong>Manual attendance (by phone)</strong>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center;margin-top:.5rem">
        <input id="manualPhone" placeholder="07XXXXXXXX" style="min-width:240px">
        <button id="btnManual">Mark present</button>
      </div>
      <p class="small">If multiple students match, enter the full mobile number.</p>
    </article>

    <div id="live" class="card" style="display:none;margin-top:1rem;"></div>
    <div id="err"  class="card" style="display:none;margin-top:1rem;"></div>
    <div id="paywrap" class="print-hidden" style="display:none; margin-top:.6rem">
      <a id="paybtn" href="#" role="button" class="muted">Pay now</a>
    </div>

    <h4 style="margin-top:1rem">Recent scans</h4>
    <div id="log" class="small"></div>
  </section>

  <script>
    function extractToken(txt){
      let t = (txt||'').trim();
      if(!t) return '';
      try{
        if(t.startsWith('http')){
          const u = new URL(t);
          const parts = u.pathname.split('/').filter(Boolean);
          t = parts[parts.length-1] || '';
        }
      }catch(e){}
      return t.replace(/^\\/+|\\/+$/g,'');
    }
    const lastHit = new Map();
    function showOk(html){ const el=document.getElementById('live'); el.innerHTML=html; el.style.display='block'; document.getElementById('err').style.display='none'; }
    function showErr(txt){ const el=document.getElementById('err'); el.textContent=txt; el.style.display='block'; document.getElementById('live').style.display='none'; }
    function addLog(html){ const row=document.createElement('div'); row.innerHTML=html; document.getElementById('log').prepend(row); }
    function setPay(token){ const wrap=document.getElementById('paywrap'); const a=document.getElementById('paybtn'); if(token){ a.href='/pay?token='+encodeURIComponent(token); wrap.style.display='block'; } else { wrap.style.display='none'; } }

    async function handleScan(raw){
      const token = extractToken(raw);
      if(!token) return;
      const now = Date.now();
      if(lastHit.has(token) && now - lastHit.get(token) < 2400) return;
      lastHit.set(token, now);
      try{
        const r = await fetch('/scan/'+encodeURIComponent(token)+'/auto', { method:'POST' });
        const data = await r.json();
        if(data.ok){
          const paidTxt = data.paid ? 'Paid' : 'Unpaid';
          const html = data.student.name + ' · ' + data.class + ' · ' + data.date + ' · ' + paidTxt + ' (' + data.month + ')';
          showOk(html); addLog(html); setPay(token);
        }else{ showErr(data.error || 'Failed to mark attendance'); setPay(null); }
      }catch{ showErr('Network error'); setPay(null); }
    }

    document.getElementById('btnManual')?.addEventListener('click', async ()=>{
      const phone = (document.getElementById('manualPhone')?.value||'').trim();
      if(!phone){ showErr('Enter a phone number'); return; }
      try{
        const r = await fetch('/attendance/manual', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ phone })});
        const data = await r.json();
        if(data.ok){
          const paidTxt = data.paid ? 'Paid' : 'Unpaid';
          const html = data.student.name + ' · ' + data.class + ' · ' + data.date + ' · ' + paidTxt + ' (' + data.month + ')';
          showOk(html); addLog(html); setPay(data.token);
        }else{ showErr(data.error || 'Could not mark attendance'); setPay(null); }
      }catch{ showErr('Network error'); setPay(null); }
    });

    document.addEventListener('DOMContentLoaded', () => {
      if (window.Html5QrcodeScanner) {
        const scanner = new Html5QrcodeScanner('reader', { fps:12, qrbox:250, rememberLastUsedCamera:true });
        scanner.render((txt)=>handleScan(txt));
      } else {
        const i = setInterval(()=>{
          if (window.Html5QrcodeScanner) { clearInterval(i); const s = new Html5QrcodeScanner('reader', { fps:12, qrbox:250, rememberLastUsedCamera:true }); s.render((txt)=>handleScan(txt)); }
        }, 150);
      }
    });
  </script>`;
  res.send(page('Scanner', body, head));
});

/* Scan API */
app.post('/scan/:token/auto', (req,res)=>{
  try{
    const sid = unsignToken(req.params.token);
    const student = db.prepare(`SELECT * FROM students WHERE id=?`).get(sid);
    if(!student) return res.json({ok:false, error:'Student not found'});
    const clazz = findOrEnsureStudentClass(student);
    if(!clazz) return res.json({ok:false, error:'Student class not available'});
    const date = todayISO(), m = monthKey(new Date(date));
    db.prepare(`
      INSERT INTO attendance(student_id,class_id,date,present)
      VALUES(?,?,?,1)
      ON CONFLICT(student_id,class_id,date) DO UPDATE SET present=1
    `).run(sid, clazz.id, date);
    const paid = hasPaidMonth(sid, clazz.id, m);
    res.json({ ok:true, student:{id:sid,name:student.name}, class:clazz.title, date, month:m, paid });
  }catch{ res.json({ok:false, error:'Bad token'}); }
});

/* Manual attendance */
app.post('/attendance/manual', (req,res)=>{
  try{
    const phone = (req.body?.phone || '').toString().trim();
    if(!phone) return res.json({ok:false, error:'Phone number required'});

    let student = db.prepare(`SELECT * FROM students WHERE phone=?`).get(phone);
    if(!student){
      const matches = db.prepare(`SELECT * FROM students WHERE phone LIKE ?`).all(`%${phone}%`);
      if(matches.length === 1) student = matches[0];
      else return res.json({ok:false, error: matches.length>1 ? 'Multiple students match; enter full number' : 'No student found'});
    }

    const clazz = findOrEnsureStudentClass(student);
    if(!clazz) return res.json({ok:false, error:'Student class not available'});

    const date = todayISO(), m = monthKey(new Date(date));
    db.prepare(`
      INSERT INTO attendance(student_id,class_id,date,present)
      VALUES(?,?,?,1)
      ON CONFLICT(student_id,class_id,date) DO UPDATE SET present=1
    `).run(student.id, clazz.id, date);

    const paid = hasPaidMonth(student.id, clazz.id, m);
    const token = db.prepare(`SELECT qr_token FROM students WHERE id=?`).get(student.id)?.qr_token || '';
    res.json({ ok:true, token, student:{id:student.id,name:student.name}, class:clazz.title, date, month:m, paid });
  }catch{ res.json({ok:false, error:'Could not mark attendance'}); }
});

/* Payments */
app.get('/pay', (req,res)=>{
  try{
    const token = cleanToken(req.query.token);
    if(!token) return res.status(400).send('Bad token');
    const sid = unsignToken(token);

    const student = db.prepare(`SELECT * FROM students WHERE id=?`).get(sid);
    if(!student) return res.status(404).send('Not found');

    const clazz = findOrEnsureStudentClass(student);
    if(!clazz) return res.status(400).send('Student class not set');

    const fee = db.prepare(`SELECT fee FROM classes WHERE id=?`).get(clazz.id)?.fee || Number(getSetting('default_fee') || '2000');
    const m = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : monthKey();
    const already = hasPaidMonth(sid, clazz.id, m);
    const currency = getSetting('currency_symbol','Rs.');

    const body = `
      <section class="card">
        <header><h3>${student.name}</h3></header>
        <p class="small">${clazz.title}${getSetting('show_phone','1')==='1' && student.phone ? ' · '+student.phone : ''}</p>
        <p>Month: <strong>${m}</strong> — ${already ? 'Already paid' : 'Unpaid'}</p>
        <form method="post" action="/pay" class="form-grid">
          <input type="hidden" name="token" value="${token}">
          <input type="hidden" name="class_id" value="${clazz.id}">
          <label>Month (YYYY-MM) <input name="month" value="${m}" pattern="\\d{4}-\\d{2}" required></label>
          <label>Amount (${currency}) <input name="amount" type="number" value="${fee}" min="0" required></label>
          <label>Method
            <select name="method"><option>cash</option><option>bank</option><option>online</option></select>
          </label>
          <div style="grid-column:1/-1;display:flex;gap:1.2rem">
            <button type="submit">Save payment</button>
            <a class="muted" role="button" href="/scanner">Back to scanner</a>
          </div>
        </form>
      </section>`;
    res.send(page('Record payment', body));
  }catch{ res.status(400).send('Bad token'); }
});

app.get('/pay/:token', (req,res)=>{
  const t = cleanToken(req.params.token);
  if(!t) return res.status(400).send('Bad token');
  const q = new URLSearchParams({ token: t });
  if (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) q.set('month', req.query.month);
  res.redirect(`/pay?${q.toString()}`);
});

app.post('/pay', (req,res)=>{
  try{
    const token = cleanToken((req.body.token ?? '').toString());
    if(!token) return res.status(400).send('Bad token');
    const sid = unsignToken(token);

    const classId = Number(req.body.class_id);
    if(!Number.isInteger(classId) || classId<=0) return res.status(400).send('Invalid class');

    const m = (req.body.month && /^\d{4}-\d{2}$/.test(req.body.month)) ? req.body.month : monthKey();
    const amt = Number(req.body.amount || getSetting('default_fee') || '2000');
    if(!Number.isFinite(amt) || amt<0) return res.status(400).send('Invalid amount');

    const method = (req.body.method || 'cash').toString();

    db.prepare(`
      INSERT INTO payments(student_id,class_id,month,amount,method)
      VALUES(?,?,?,?,?)
      ON CONFLICT(student_id,class_id,month)
      DO UPDATE SET amount=excluded.amount, method=excluded.method
    `).run(sid, classId, m, amt, method);

    res.redirect(`/pay?token=${encodeURIComponent(token)}&month=${encodeURIComponent(m)}`);
  }catch{ res.status(400).send('Bad token'); }
});

/* Finance */
app.get('/finance', (req,res)=>{
  const m = req.query.month && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : monthKey();
  const classes = db.prepare(`SELECT id, title, fee FROM classes WHERE title IN (${CORE_CLASSES.map(()=>'?').join(',')}) ORDER BY title`).all(...CORE_CLASSES);
  const currency = getSetting('currency_symbol','Rs.');

  const rows = classes.map(c=>{
    const enrolled = db.prepare(`SELECT COUNT(*) AS n FROM enrollments WHERE class_id=?`).get(c.id).n;
    const agg = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum FROM payments WHERE class_id=? AND month=?`).get(c.id, m);
    return { c, enrolled, paid: agg.n, unpaid: Math.max(0, enrolled - agg.n), revenue: agg.sum || 0 };
  });

  const payments = db.prepare(`
    SELECT p.amount, p.method, p.created_at,
           s.name AS student_name, s.phone AS student_phone,
           c.title AS class_title
      FROM payments p
      JOIN students s ON s.id=p.student_id
      JOIN classes  c ON c.id=p.class_id
     WHERE p.month=? AND c.title IN (${CORE_CLASSES.map(()=>'?').join(',')})
     ORDER BY p.created_at DESC
  `).all(m, ...CORE_CLASSES);

  const total = rows.reduce((t,r)=>t+r.revenue,0);

  const body = `
  <section class="card">
    <form method="get" action="/finance" style="display:flex;gap:1.2rem;flex-wrap:wrap;align-items:end">
      <label>Month (YYYY-MM) <input name="month" value="${m}" pattern="\\d{4}-\\d{2}" required></label>
      <button type="submit">Show</button>
      <a class="muted" role="button" href="/finance.csv?month=${encodeURIComponent(m)}">Download CSV</a>
    </form>

    <h3 style="margin-top:.8rem">Summary</h3>
    <div style="overflow:auto">
      <table>
        <thead><tr><th>Class</th><th>Enrolled</th><th>Paid</th><th>Unpaid</th><th>Revenue (${currency})</th></tr></thead>
        <tbody>
          ${rows.map(r=>`
            <tr>
              <td>${r.c.title}</td>
              <td>${r.enrolled}</td>
              <td>${r.paid}</td>
              <td>${r.unpaid}</td>
              <td>${r.revenue}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="4" style="text-align:right"><strong>Total</strong></td><td><strong>${total}</strong></td></tr></tfoot>
      </table>
    </div>

    <h3>Payments in ${m}</h3>
    <div style="overflow:auto">
      ${payments.length ? `
      <table>
        <thead><tr><th>When</th><th>Student</th><th>Phone</th><th>Class</th><th>Amount (${currency})</th><th>Method</th></tr></thead>
        <tbody>
          ${payments.map(p=>`
            <tr>
              <td>${p.created_at}</td>
              <td>${p.student_name}</td>
              <td>${p.student_phone||''}</td>
              <td>${p.class_title}</td>
              <td>${p.amount}</td>
              <td>${p.method}</td>
            </tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="4" style="text-align:right"><strong>Total</strong></td><td><strong>${payments.reduce((t,x)=>t+Number(x.amount||0),0)}</strong></td><td></td></tr></tfoot>
      </table>` : '<p class="small">No payments recorded for this month.</p>'}
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
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payments_${m}.csv"`);
  const header = 'created_at,student,phone,class,amount,method\n';
  const body = rows.map(r => [r.created_at, r.student, r.phone||'', r.class, r.amount, r.method]
                   .map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
  res.send(header + body);
});

/* Attendance Sheet */
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

  const presence = new Map(db.prepare(`SELECT student_id, present FROM attendance WHERE class_id=? AND date=?`).all(clazz?.id || 0, date).map(r=>[r.student_id, !!r.present]));
  const paidset  = new Set(db.prepare(`SELECT student_id FROM payments WHERE class_id=? AND month=?`).all(clazz?.id || 0, m).map(r=>r.student_id));
  const showPhone = getSetting('show_phone','1')==='1';

  const body = `
  <section class="card">
    <form method="get" action="/attendance-sheet" style="display:flex;gap:1.2rem;flex-wrap:wrap;align-items:end">
      <label>Class <select name="class">${classes.map(c=>`<option ${c.title===classTitle?'selected':''}>${c.title}</option>`).join('')}</select></label>
      <label>Date <input name="date" type="date" value="${date}"></label>
      <button type="submit">Show</button>
      <a class="muted" role="button" href="/scanner">Open Scanner</a>
    </form>
    <div style="overflow:auto; margin-top:.8rem">
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
      ${students.length ? '' : '<p class="small">No students in this class.</p>'}
    </div>
  </section>`;
  res.send(page('Attendance Sheet', body));
});

/* ============== Bootstrap ============== */
if (process.argv.includes('--initdb')) { initDb(); ensureCoreClasses(); console.log('DB initialized'); process.exit(0); }
if (process.argv.includes('--seed'))   { initDb(); seedDb(); console.log('Seeded'); process.exit(0); }
initDb(); seedDb();

app.listen(PORT, ()=>console.log(`Class Manager running on ${BASE}`));