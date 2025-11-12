// Full Class Manager Backend (complete server.js)
// Features: Students CRUD, Free-card, QR Print, Scanner w sound, Attendance auto/manual,
// Finance, Unpaid, Payment system, DB download/upload, Dark UI, Mobile optimized, Railway-ready

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import crypto from 'crypto';
import multer from 'multer';

/* ============================================================
   SETUP
   ============================================================ */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = Number(process.env.PORT || 5050);
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const SECRET  = process.env.APP_SECRET || 'dev-secret';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'class_manager.db');

const CORE_CLASSES = ['Grade 6','Grade 7','Grade 8','O/L'];

app.use(express.urlencoded({extended:true}));
app.use(express.json());

/* ============================================================
   DATABASE
   ============================================================ */
let db = openDb();

function openDb(){
    const d = new Database(DB_PATH);
    d.pragma('journal_mode = wal');
    initDb(d);
    migrateDb(d);
    return d;
}

function initDb(d){
    d.prepare(`
        CREATE TABLE IF NOT EXISTS students(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            grade TEXT NOT NULL,
            qr_token TEXT UNIQUE,
            is_free INTEGER DEFAULT 0
        )
    `).run();

    d.prepare(`
        CREATE TABLE IF NOT EXISTS classes(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT UNIQUE NOT NULL,
            fee INTEGER NOT NULL DEFAULT 2000
        )
    `).run();

    d.prepare(`
        CREATE TABLE IF NOT EXISTS attendance(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            present INTEGER NOT NULL DEFAULT 1,
            UNIQUE(student_id,class_id,date)
        )
    `).run();

    d.prepare(`
        CREATE TABLE IF NOT EXISTS payments(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_id INTEGER NOT NULL,
            month TEXT NOT NULL,
            amount INTEGER NOT NULL DEFAULT 2000,
            method TEXT DEFAULT 'cash',
            created_at TEXT DEFAULT(datetime('now')),
            UNIQUE(student_id,class_id,month)
        )
    `).run();
}

function migrateDb(d){
    const existing = d.prepare("SELECT title FROM classes").all().map(r=>r.title);
    for(const t of CORE_CLASSES){
        if(!existing.includes(t)){
            d.prepare("INSERT INTO classes(title, fee) VALUES(?,2000)").run(t);
        }
    }
}

/* ============================================================
   HELPERS
   ============================================================ */
const todayISO = () => new Date().toISOString().slice(0,10);
const monthKey = (d=new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

function signId(id){
    const payload = JSON.stringify({sid:id});
    const mac = crypto.createHmac('sha256',SECRET).update(payload).digest('base64url');
    return Buffer.from(payload).toString('base64url') + "." + mac;
}
function unsign(token){
    const [b64,mac] = (token||"").split(".");
    const payload = Buffer.from(b64,"base64url").toString();
    const want = crypto.createHmac('sha256',SECRET).update(payload).digest('base64url');
    if(mac!==want) throw new Error("Bad token");
    return JSON.parse(payload).sid;
}

/* CSS + PAGE */
function css(){
return `
html,body{background:#0b1220;color:#e8eef8;font-family:sans-serif}
.container{max-width:1080px;margin:auto;padding:1rem}
header.nav{display:flex;gap:.7rem;flex-wrap:wrap}
header.nav a{background:#1e293b;padding:.5rem 1rem;border-radius:.5rem;color:#cbd5e1;text-decoration:none;font-weight:bold}
header.nav a:hover{background:#334155}
.card{background:#111a2c;border:1px solid #22314d;padding:1rem;border-radius:.7rem}
table{width:100%;border-collapse:collapse;margin-top:1rem}
td,th{padding:.5rem;border-bottom:1px solid #334155}
#notification{display:none;margin-top:.7rem;padding:.7rem;text-align:center;border-radius:.5rem;font-weight:bold}
#notification.success{background:#064e3b;color:#d1fae5}
#notification.warn{background:#92400e;color:#fef3c7}
#notification.error{background:#7f1d1d;color:#fee2e2}
footer{text-align:center;color:#94a3b8;margin-top:2rem}
@media(max-width:700px){header.nav{flex-direction:column}}
`;
}

function page(title, body, banner=''){
return `
<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title>
<style>${css()}</style>
</head><body>
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
${banner?`<div class="banner">${banner}</div>`:''}
${body}
<footer>Created by Pulindu Pansilu</footer>
</main>
</body></html>`;
}

/* ============================================================
   ROUTES
   ============================================================ */

app.get('/',(req,res)=>res.redirect('/students'));

/* -------- STUDENTS LIST -------- */
app.get('/students',(req,res)=>{
    const list = db.prepare("SELECT * FROM students ORDER BY grade,name").all();
    const body = `
    <a href="/students/new" style="background:#2e4a7f;padding:.5rem 1rem;border-radius:.4rem;color:white;text-decoration:none">Add Student</a>
    <div style="overflow:auto;margin-top:1rem">
    <table>
    <thead><tr><th>Name</th><th>Grade</th><th>Phone</th><th>Free</th><th>QR</th><th>Actions</th></tr></thead>
    <tbody>
    ${list.map(s=>`
    <tr>
        <td>${s.name}</td>
        <td>${s.grade}</td>
        <td>${s.phone||''}</td>
        <td>${s.is_free?'🆓':''}</td>
        <td><a href="/students/${s.id}/qr">QR</a></td>
        <td>
            <a href="/students/${s.id}/edit">Edit</a>
            <form method="post" action="/students/${s.id}/delete" style="display:inline" onsubmit="return confirm('Delete?')">
                <button style="background:#5a0f0f;color:white;border:none;padding:.3rem .5rem;border-radius:.3rem">Delete</button>
            </form>
        </td>
    </tr>`).join('')}
    </tbody></table></div>`;
    res.send(page("Students",body));
});

/* -------- ADD STUDENT -------- */
app.get('/students/new',(req,res)=>{
    const body=`
    <section class="card">
    <form method="post" action="/students/new" style="display:grid;gap:1rem">
        <label>Name <input name="name" required></label>
        <label>Phone <input name="phone"></label>
        <label>Grade 
            <select name="grade">
                <option>Grade 6</option><option>Grade 7</option>
                <option>Grade 8</option><option>O/L</option>
            </select>
        </label>
        <label><input type="checkbox" name="is_free"> Free card</label>
        <button>Add</button>
    </form>
    </section>`;
    res.send(page("Add Student",body));
});

app.post('/students/new',(req,res)=>{
    const is_free = req.body.is_free?1:0;
    const r = db.prepare("INSERT INTO students(name,phone,grade,is_free) VALUES(?,?,?,?)")
                .run(req.body.name,req.body.phone,req.body.grade,is_free);
    const token = signId(r.lastInsertRowid);
    db.prepare("UPDATE students SET qr_token=? WHERE id=?").run(token,r.lastInsertRowid);
    res.redirect('/students');
});

/* -------- EDIT STUDENT -------- */
app.get('/students/:id/edit',(req,res)=>{
    const s=db.prepare("SELECT * FROM students WHERE id=?").get(req.params.id);
    if(!s) return res.send("Not found");
    const body=`
    <section class="card">
    <form method="post" action="/students/${s.id}/edit" style="display:grid;gap:1rem">
        <label>Name <input name="name" value="${s.name}" required></label>
        <label>Phone <input name="phone" value="${s.phone||''}"></label>
        <label>Grade 
            <select name="grade">
                <option${s.grade==='Grade 6'?' selected':''}>Grade 6</option>
                <option${s.grade==='Grade 7'?' selected':''}>Grade 7</option>
                <option${s.grade==='Grade 8'?' selected':''}>Grade 8</option>
                <option${s.grade==='O/L'?' selected':''}>O/L</option>
            </select>
        </label>
        <label><input type="checkbox" name="is_free"${s.is_free?' checked':''}> Free card</label>
        <button>Save</button>
    </form>
    </section>`;
    res.send(page("Edit Student",body));
});

app.post('/students/:id/edit',(req,res)=>{
    const is_free = req.body.is_free?1:0;
    db.prepare(`
        UPDATE students SET name=?,phone=?,grade=?,is_free=? WHERE id=?
    `).run(req.body.name,req.body.phone,req.body.grade,is_free,req.params.id);
    res.redirect('/students');
});

/* -------- DELETE STUDENT -------- */
app.post('/students/:id/delete',(req,res)=>{
    const id=req.params.id;
    const tx=db.transaction(()=>{
        db.prepare("DELETE FROM attendance WHERE student_id=?").run(id);
        db.prepare("DELETE FROM payments WHERE student_id=?").run(id);
        db.prepare("DELETE FROM students WHERE id=?").run(id);
    });
    tx();
    res.redirect('/students');
});

/* -------- QR PRINT -------- */
app.get('/students/:id/qr', async (req,res)=>{
    const s=db.prepare("SELECT * FROM students WHERE id=?").get(req.params.id);
    if(!s) return res.send("Not found");
    const img=await QRCode.toDataURL(`${BASE}/scan/${s.qr_token}`);
    res.send(`
    <html><body style="text-align:center;font-family:sans-serif">
    <h2>${s.name}</h2>
    <img src="${img}" width="300"><br>
    <button onclick="print()">Print</button>
    </body></html>`);
});

/* -------- SCANNER -------- */
app.get('/scanner',(req,res)=>{
    const body=`
    <div id="notification"></div>
    <div id="reader" style="max-width:500px;margin:auto"></div>
    <div id="actions" style="display:none"><a id="payBtn" href="#">Record Payment</a></div>
    <script src="https://unpkg.com/html5-qrcode"></script>
    <script>
    const note=(t,m)=>{
        const n=document.getElementById('notification');
        n.className=t; n.textContent=m; n.style.display='block';
        setTimeout(()=>n.style.display='none',2000);
    };
    function tokenFrom(txt){
        try{
            if(txt.startsWith('http')){
                const u=new URL(txt);
                return u.pathname.split('/').pop();
            }
        }catch{}
        return txt.split('/').pop();
    }
    async function mark(token){
        const r=await fetch('/scan/'+token+'/auto',{method:'POST'});
        const d=await r.json();
        if(d.ok){
            note('success','Attendance: '+d.student.name);
            document.getElementById('actions').style.display='block';
            document.getElementById('payBtn').href='/pay?token='+token;
        }else if(d.warning){
            note('warn',d.warning);
        }else{
            note('error',d.error||'Error');
        }
    }
    new Html5QrcodeScanner('reader',{fps:10,qrbox:250}).render(txt=>mark(tokenFrom(txt)));
    </script>`;
    res.send(page("Scanner",body));
});

/* -------- AUTO ATTENDANCE -------- */
app.post('/scan/:token/auto',(req,res)=>{
    try{
        const sid=unsign(req.params.token);
        const s=db.prepare("SELECT * FROM students WHERE id=?").get(sid);
        if(!s) return res.json({ok:false,error:"Not found"});
        let c=db.prepare("SELECT * FROM classes WHERE title=?").get(s.grade);
        const today=todayISO();
        const dup=db.prepare("SELECT 1 FROM attendance WHERE student_id=? AND class_id=? AND date=?")
            .get(sid,c.id,today);
        if(dup) return res.json({ok:false,warning:"Already marked"});
        db.prepare("INSERT INTO attendance(student_id,class_id,date,present) VALUES(?,?,?,1)")
            .run(sid,c.id,today);
        res.json({ok:true,student:{id:sid,name:s.name},token:req.params.token});
    }catch{
        res.json({ok:false,error:"Invalid QR"});
    }
});

/* -------- ATTENDANCE SHEET -------- */
app.get('/attendance-sheet',(req,res)=>{
    const classTitle=req.query.class||"Grade 6";
    const date=req.query.date||todayISO();
    const clazz=db.prepare("SELECT * FROM classes WHERE title=?").get(classTitle);
    const students=db.prepare("SELECT * FROM students WHERE grade=? ORDER BY name").all(classTitle);
    const present=new Set(
        db.prepare("SELECT student_id FROM attendance WHERE class_id=? AND date=?")
        .all(clazz.id,date).map(r=>r.student_id)
    );
    const body=`
    <section class="card">
    <form method="get" action="/attendance-sheet">
        <label>Class 
        <select name="class">${CORE_CLASSES.map(c=>`<option${c===classTitle?' selected':''}>${c}</option>`).join('')}</select>
        </label>
        <label>Date <input type="date" name="date" value="${date}"></label>
        <button>Show</button>
    </form>
    <details>
        <summary>Manual attendance (by phone)</summary>
        <form method="post" action="/attendance/manual">
        <input type="hidden" name="class" value="${classTitle}">
        <input type="hidden" name="date" value="${date}">
        <label>Phone <input name="phone" required></label>
        <button>Mark</button>
        </form>
    </details>
    <table><thead><tr><th>Present</th><th>Name</th><th>Phone</th><th>Free</th></tr></thead>
    <tbody>
    ${students.map(s=>`
        <tr><td>${present.has(s.id)?'Yes':'-'}</td><td>${s.name}</td><td>${s.phone||''}</td><td>${s.is_free?'🆓':''}</td></tr>
    `).join('')}
    </tbody></table>
    </section>`;
    res.send(page("Attendance",body));
});

/* -------- MANUAL ATTENDANCE (PHONE) -------- */
app.post('/attendance/manual',(req,res)=>{
    const phone=req.body.phone;
    const classTitle=req.body.class;
    const date=req.body.date;
    const s=db.prepare("SELECT * FROM students WHERE phone=?").get(phone);
    if(!s) return res.send(page("Attendance",`<p>No student found.</p>`));
    let c=db.prepare("SELECT * FROM classes WHERE title=?").get(classTitle);
    try{
        db.prepare("INSERT INTO attendance(student_id,class_id,date,present) VALUES(?,?,?,1)")
        .run(s.id,c.id,date);
    }catch{}
    res.redirect(`/attendance-sheet?class=${classTitle}&date=${date}`);
});

/* -------- UNPAID -------- */
app.get('/unpaid',(req,res)=>{
    const m=monthKey();
    const rows=db.prepare(`
        SELECT s.id,s.name,s.phone,s.grade,s.qr_token
        FROM students s
        LEFT JOIN classes c ON c.title=s.grade
        LEFT JOIN payments p ON p.student_id=s.id AND p.class_id=c.id AND p.month=?
        WHERE p.id IS NULL AND s.is_free=0
        ORDER BY s.grade,s.name
    `).all(m);
    const body=`
    <section class="card">
    <table><thead><tr><th>Name</th><th>Class</th><th>Phone</th><th>Pay</th></tr></thead>
    <tbody>
    ${rows.map(r=>`
    <tr>
    <td>${r.name}</td>
    <td>${r.grade}</td>
    <td>${r.phone||''}</td>
    <td><a href="/pay?token=${encodeURIComponent(r.qr_token)}">Record Payment</a></td>
    </tr>
    `).join('')}
    </tbody>
    </table>
    </section>`;
    res.send(page("Unpaid Students",body));
});

/* -------- FINANCE -------- */
app.get('/finance',(req,res)=>{
    const m=req.query.month||monthKey();
    const data=db.prepare(`
        SELECT c.title as class,COUNT(p.id) cnt,SUM(p.amount) sum
        FROM classes c 
        LEFT JOIN payments p ON p.class_id=c.id AND p.month=?
        WHERE c.title IN ('Grade 6','Grade 7','Grade 8','O/L')
        GROUP BY c.id ORDER BY c.title
    `).all(m);
    const total=data.reduce((t,r)=>t+(r.sum||0),0);
    const body=`
    <section class="card">
    <form method="get" action="/finance">
        <label>Month <input name="month" value="${m}"></label>
        <button>Show</button>
    </form>
    <table>
    <thead><tr><th>Class</th><th>Payments</th><th>Revenue</th></tr></thead>
    <tbody>
    ${data.map(r=>`
    <tr><td>${r.class}</td><td>${r.cnt||0}</td><td>${r.sum||0}</td></tr>
    `).join('')}
    </tbody>
    <tfoot><tr><td colspan="2">Total</td><td>${total}</td></tr></tfoot>
    </table>
    </section>`;
    res.send(page("Finance",body));
});

/* -------- RECORD PAYMENT -------- */
app.get('/pay',(req,res)=>{
    try{
        const sid=unsign(req.query.token);
        const s=db.prepare("SELECT * FROM students WHERE id=?").get(sid);
        let c=db.prepare("SELECT * FROM classes WHERE title=?").get(s.grade);
        const m=monthKey();
        const exists=db.prepare("SELECT 1 FROM payments WHERE student_id=? AND class_id=? AND month=?").get(sid,c.id,m);
        const body=`
        <section class="card">
        <h3>${s.name}</h3>
        <p>${s.grade} · ${s.phone||''}</p>
        <form method="post" action="/pay" style="display:grid;gap:1rem">
            <input type="hidden" name="token" value="${req.query.token}">
            <input type="hidden" name="class_id" value="${c.id}">
            <label>Month <input name="month" value="${m}"></label>
            <label>Amount <input name="amount" value="${c.fee}" type="number"></label>
            <label>Method 
                <select name="method"><option>cash</option><option>bank</option><option>online</option></select>
            </label>
            <button>${exists?'Update':'Save'} Payment</button>
        </form>
        </section>`;
        res.send(page("Record Payment",body));
    }catch{
        res.send("Invalid token");
    }
});

app.post('/pay',(req,res)=>{
    try{
        const sid=unsign(req.body.token);
        db.prepare(`
            INSERT INTO payments(student_id,class_id,month,amount,method)
            VALUES(?,?,?,?,?)
            ON CONFLICT(student_id,class_id,month)
            DO UPDATE SET amount=excluded.amount, method=excluded.method
        `).run(
            sid,
            req.body.class_id,
            req.body.month,
            req.body.amount,
            req.body.method
        );
        res.redirect('/unpaid');
    }catch{
        res.send("Error saving payment");
    }
});

/* -------- SETTINGS (DB management) -------- */
const upload=multer({dest:path.join(__dirname,'uploads')});

app.get('/settings',(req,res)=>{
    const body=`
    <section class="card">
    <a href="/admin/db/download">Download Database</a>
    <form method="post" action="/admin/db/upload" enctype="multipart/form-data">
        <input type="file" name="dbfile" required>
        <button>Upload DB</button>
    </form>
    </section>`;
    res.send(page("Settings",body));
});

app.get('/admin/db/download',(req,res)=>{
    res.setHeader('Content-Disposition','attachment; filename="class_manager.db"');
    fs.createReadStream(DB_PATH).pipe(res);
});

app.post('/admin/db/upload',upload.single('dbfile'),(req,res)=>{
    try{
        fs.copyFileSync(req.file.path,DB_PATH);
        db=openDb();
        res.redirect('/settings');
    }catch{
        res.send("Upload failed");
    }
});

/* ============================================================
   START SERVER
   ============================================================ */
app.listen(PORT,()=>console.log("Class Manager running on",BASE));
