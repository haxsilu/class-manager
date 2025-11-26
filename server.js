// server.js
// Full Class Management System for Railway-compatible deployment
// Stack: Express, better-sqlite3, express-session, bcrypt, vanilla HTML/CSS/JS

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT || 5050);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "class_manager.db");
const SESSION_SECRET = process.env.SESSION_SECRET || "railway-class-manager-secret";
const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);
const STATIC_DIR = path.join(__dirname, "public");
const VIEWS_DIR = path.join(__dirname, "views");
const ALLOWED_GRADES = ["Grade 6", "Grade 7", "Grade 8", "O/L"];
const DEFAULT_CLASS_FEE = 2000;
const DEFAULT_STUDENT_PASSWORD = "1234";

// ---------- Database ----------
function openDatabase() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = wal");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      grade TEXT NOT NULL,
      qr_token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','student')),
      student_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      monthly_fee INTEGER NOT NULL DEFAULT 2000 CHECK (monthly_fee >= 0)
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (student_id, class_id),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      amount INTEGER NOT NULL,
      method TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(student_id, class_id, month),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(student_id, class_id, date),
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS exam_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      max_seats INTEGER NOT NULL CHECK (max_seats > 0)
    );

    CREATE TABLE IF NOT EXISTS exam_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL,
      seat_index INTEGER NOT NULL,
      seat_pos INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      student_name TEXT NOT NULL,
      student_class TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(slot_id, seat_index, seat_pos),
      UNIQUE(slot_id, student_id),
      FOREIGN KEY (slot_id) REFERENCES exam_slots(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
    );
  `);

  seedDefaults(db);
  return db;
}

function seedDefaults(db) {
  const classNames = db.prepare("SELECT name FROM classes").all().map((row) => row.name);
  ALLOWED_GRADES.forEach((grade) => {
    if (!classNames.includes(grade)) {
      db.prepare("INSERT INTO classes(name, monthly_fee) VALUES(?, ?)").run(grade, DEFAULT_CLASS_FEE);
    }
  });

  const examCount = db.prepare("SELECT COUNT(*) AS count FROM exam_slots").get().count;
  if (examCount === 0) {
    db.prepare(
      "INSERT INTO exam_slots(label, start_time, end_time, max_seats) VALUES(?,?,?,?)"
    ).run("Session 1 – 2:00 PM to 5:00 PM", "2025-12-05T14:00:00", "2025-12-05T17:00:00", 25);

    db.prepare(
      "INSERT INTO exam_slots(label, start_time, end_time, max_seats) VALUES(?,?,?,?)"
    ).run("Session 2 – 5:30 PM to 8:30 PM", "2025-12-05T17:30:00", "2025-12-05T20:30:00", 24);
  }

  const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (!adminExists) {
    const hash = bcrypt.hashSync("admin123", SALT_ROUNDS);
    db.prepare(
      "INSERT INTO users(username, password_hash, role) VALUES(?,?,?)"
    ).run("admin", hash, "admin");
  }
}

const db = openDatabase();

// ---------- Helpers ----------
function monthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function ensureGrade(grade) {
  if (!ALLOWED_GRADES.includes(grade)) {
    throw new Error("Grade must be one of " + ALLOWED_GRADES.join(", "));
  }
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === "admin") {
    return next();
  }
  return res.status(403).json({ error: "Admin access required" });
}

function requireStudent(req, res, next) {
  if (req.session && req.session.role === "student" && req.session.studentId) {
    return next();
  }
  return res.status(403).json({ error: "Student access required" });
}

function requireAdminPage(req, res, next) {
  if (req.session && req.session.role === "admin") {
    return next();
  }
  return res.redirect("/");
}

function requireStudentPage(req, res, next) {
  if (req.session && req.session.role === "student") {
    return next();
  }
  return res.redirect("/");
}

function randomToken() {
  if (crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return crypto.randomBytes(16).toString("hex");
}

function getClassByGrade(grade) {
  return db.prepare("SELECT * FROM classes WHERE name = ?").get(grade);
}

function mapStudent(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    grade: row.grade,
    qr_token: row.qr_token,
    created_at: row.created_at,
  };
}

function sanitizeMonth(input) {
  if (typeof input !== "string" || !/^\d{4}-\d{2}$/.test(input)) {
    throw new Error("Month must be YYYY-MM");
  }
  return input;
}

function toId(value, field = "id") {
  const asNumber = Number(value);
  if (!Number.isInteger(asNumber) || asNumber <= 0) {
    throw new Error(`Invalid ${field}`);
  }
  return asNumber;
}

// ---------- Express setup ----------
const app = express();
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  })
);

app.use("/static", express.static(STATIC_DIR));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ---------- Auth Routes ----------
app.post("/login", (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "").trim();
    const role = String(req.body.role || "").trim();

    if (!username || !password || !role) {
      return res.status(400).json({ error: "Username, password, role required" });
    }

    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!user || user.role !== role) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.username = user.username;
    req.session.studentId = user.student_id || null;

    const redirect = user.role === "admin" ? "/admin" : "/student";
    res.json({ ok: true, role: user.role, redirect });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.status(204).end();
  });
});

app.get("/session", (req, res) => {
  if (!req.session || !req.session.role) {
    return res.json({ authenticated: false });
  }
  res.json({
    authenticated: true,
    role: req.session.role,
    username: req.session.username,
  });
});

// ---------- Pages ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, "login.html"));
});

app.get("/admin", requireAdminPage, (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, "admin.html"));
});

app.get("/student", requireStudentPage, (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, "student.html"));
});

// ---------- Admin APIs ----------
app.get("/api/students", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM students ORDER BY name COLLATE NOCASE").all();
  res.json(rows.map(mapStudent));
});

app.post("/api/students", requireAdmin, (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const grade = String(req.body.grade || "").trim();

    if (!name || !phone) {
      throw new Error("Name and phone are required");
    }
    ensureGrade(grade);

    const qrToken = randomToken();
    const result = db
      .prepare("INSERT INTO students(name, phone, grade, qr_token) VALUES(?,?,?,?)")
      .run(name, phone, grade, qrToken);

    const studentId = result.lastInsertRowid;
    const passwordHash = bcrypt.hashSync(DEFAULT_STUDENT_PASSWORD, SALT_ROUNDS);
    db.prepare(
      "INSERT INTO users(username, password_hash, role, student_id) VALUES(?,?,?,?)"
    ).run(phone, passwordHash, "student", studentId);

    const created = db.prepare("SELECT * FROM students WHERE id = ?").get(studentId);
    res.status(201).json({ student: mapStudent(created), default_password: DEFAULT_STUDENT_PASSWORD });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(400).json({ error: "Student phone or token already exists" });
    }
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/students/:id", requireAdmin, (req, res) => {
  try {
    const studentId = toId(req.params.id, "student id");
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const grade = String(req.body.grade || "").trim();
    ensureGrade(grade);
    if (!name || !phone) {
      throw new Error("Name and phone required");
    }

    db.prepare("UPDATE students SET name=?, phone=?, grade=? WHERE id=?").run(name, phone, grade, studentId);
    db.prepare("UPDATE users SET username=? WHERE student_id=?").run(phone, studentId);
    const updated = db.prepare("SELECT * FROM students WHERE id=?").get(studentId);
    res.json(mapStudent(updated));
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(400).json({ error: "Phone already taken" });
    }
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/students/:id", requireAdmin, (req, res) => {
  try {
    const studentId = toId(req.params.id, "student id");
    db.prepare("DELETE FROM students WHERE id=?").run(studentId);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/students/:id/qr", requireAdmin, async (req, res) => {
  try {
    const studentId = toId(req.params.id, "student id");
    const student = db.prepare("SELECT * FROM students WHERE id=?").get(studentId);
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }
    const dataUrl = await QRCode.toDataURL(student.qr_token, { width: 260, margin: 1 });
    res.json({ data_url: dataUrl, token: student.qr_token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/classes", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM classes ORDER BY name COLLATE NOCASE").all();
  res.json(rows);
});

app.post("/api/classes", requireAdmin, (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const fee = Number(req.body.monthly_fee || DEFAULT_CLASS_FEE);
    if (!name) throw new Error("Class name required");
    if (!Number.isFinite(fee) || fee < 0) throw new Error("Invalid fee");
    const result = db.prepare("INSERT INTO classes(name, monthly_fee) VALUES(?,?)").run(name, fee);
    const created = db.prepare("SELECT * FROM classes WHERE id=?").get(result.lastInsertRowid);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/classes/:id", requireAdmin, (req, res) => {
  try {
    const classId = toId(req.params.id, "class id");
    const fee = Number(req.body.monthly_fee);
    if (!Number.isFinite(fee) || fee < 0) throw new Error("Invalid fee");
    db.prepare("UPDATE classes SET monthly_fee=? WHERE id=?").run(fee, classId);
    const updated = db.prepare("SELECT * FROM classes WHERE id=?").get(classId);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/enrollments", requireAdmin, (req, res) => {
  try {
    const studentId = toId(req.body.student_id, "student id");
    const classId = toId(req.body.class_id, "class id");
    db.prepare("INSERT OR IGNORE INTO enrollments(student_id, class_id) VALUES(?,?)").run(studentId, classId);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/classes/:id/students", requireAdmin, (req, res) => {
  try {
    const classId = toId(req.params.id, "class id");
    const rows = db
      .prepare(
        `SELECT s.* FROM enrollments e
         JOIN students s ON s.id = e.student_id
         WHERE e.class_id = ?
         ORDER BY s.name COLLATE NOCASE`
      )
      .all(classId);
    res.json(rows.map(mapStudent));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/payments", requireAdmin, (req, res) => {
  try {
    const studentId = toId(req.body.student_id, "student id");
    const classId = toId(req.body.class_id, "class id");
    const month = sanitizeMonth(req.body.month || monthKey());
    const amount = Number(req.body.amount || DEFAULT_CLASS_FEE);
    const method = String(req.body.method || "cash");
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid amount");

    db.prepare(
      `INSERT INTO payments(student_id, class_id, month, amount, method)
       VALUES (?,?,?,?,?)
       ON CONFLICT(student_id, class_id, month)
       DO UPDATE SET amount=excluded.amount, method=excluded.method`
    ).run(studentId, classId, month, amount, method);

    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/attendance", requireAdmin, (req, res) => {
  try {
    const classId = toId(req.query.class_id, "class id");
    const date = req.query.date ? req.query.date : todayKey();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("Invalid date format (YYYY-MM-DD)");
    }
    const rows = db
      .prepare(
        `SELECT s.id, s.name, s.phone, s.grade,
                CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS present
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         LEFT JOIN attendance a
           ON a.student_id = e.student_id AND a.class_id = e.class_id AND a.date = ?
         WHERE e.class_id = ?
         ORDER BY s.name COLLATE NOCASE`
      )
      .all(date, classId);
    res.json({ class_id: classId, date, students: rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/attendance/manual", requireAdmin, (req, res) => {
  try {
    const studentId = toId(req.body.student_id, "student id");
    const classId = toId(req.body.class_id, "class id");
    const date = req.body.date ? String(req.body.date) : todayKey();
    const presentInput = req.body.present;
    const present =
      presentInput === true ||
      presentInput === "true" ||
      Number(presentInput) === 1;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("Invalid date format (YYYY-MM-DD)");
    }

    if (present) {
      db.prepare(
        `INSERT INTO attendance(student_id, class_id, date)
         VALUES (?,?,?)
         ON CONFLICT(student_id, class_id, date) DO NOTHING`
      ).run(studentId, classId, date);
    } else {
      db.prepare(
        `DELETE FROM attendance WHERE student_id=? AND class_id=? AND date=?`
      ).run(studentId, classId, date);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/scan", requireAdmin, (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    if (!token) throw new Error("QR token required");
    const student = db.prepare("SELECT * FROM students WHERE qr_token = ?").get(token);
    if (!student) throw new Error("Student not found for token");
    const classRow = getClassByGrade(student.grade);
    if (!classRow) throw new Error("No class mapped for grade " + student.grade);

    const today = todayKey();
    db.prepare(
      `INSERT INTO attendance(student_id, class_id, date)
       VALUES (?,?,?)
       ON CONFLICT(student_id, class_id, date) DO NOTHING`
    ).run(student.id, classRow.id, today);

    const month = monthKey();
    const payment = db
      .prepare(
        `SELECT id FROM payments WHERE student_id=? AND class_id=? AND month=?`
      )
      .get(student.id, classRow.id, month);

    res.json({
      student: mapStudent(student),
      class: { id: classRow.id, name: classRow.name },
      attendance: { date: today, recorded: true },
      payment: { month, paid: Boolean(payment) },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/unpaid", requireAdmin, (req, res) => {
  try {
    const month = sanitizeMonth(req.query.month || monthKey());
    const rows = db
      .prepare(
        `SELECT c.name AS class_name, s.name AS student_name, s.phone
         FROM enrollments e
         JOIN students s ON s.id = e.student_id
         JOIN classes c ON c.id = e.class_id
         LEFT JOIN payments p ON p.student_id = e.student_id
           AND p.class_id = e.class_id AND p.month = ?
         WHERE p.id IS NULL
         ORDER BY c.name COLLATE NOCASE, s.name COLLATE NOCASE`
      )
      .all(month);
    res.json({ month, rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/finance", requireAdmin, (req, res) => {
  try {
    const month = sanitizeMonth(req.query.month || monthKey());
    const rows = db
      .prepare(
        `SELECT c.id, c.name, COUNT(p.id) AS payments_count, COALESCE(SUM(p.amount),0) AS total_amount
         FROM classes c
         LEFT JOIN payments p ON p.class_id = c.id AND p.month = ?
         GROUP BY c.id
         ORDER BY c.name COLLATE NOCASE`
      )
      .all(month);
    const total = rows.reduce((sum, r) => sum + (r.total_amount || 0), 0);
    res.json({ month, rows, total });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  const stats = {
    students: db.prepare("SELECT COUNT(*) AS c FROM students").get().c,
    classes: db.prepare("SELECT COUNT(*) AS c FROM classes").get().c,
    today_attendance: db.prepare("SELECT COUNT(*) AS c FROM attendance WHERE date = ?").get(todayKey()).c,
    unpaid_this_month: db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
          SELECT e.student_id
          FROM enrollments e
          LEFT JOIN payments p ON p.student_id = e.student_id
            AND p.class_id = e.class_id AND p.month = ?
          WHERE p.id IS NULL
        ) pending`
      )
      .get(monthKey()).c,
  };
  res.json(stats);
});

app.get("/api/admin/exam/slots", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM exam_slots ORDER BY id").all();
  res.json(rows);
});

app.get("/api/admin/exam/slots/:id/layout", requireAdmin, (req, res) => {
  try {
    const slotId = toId(req.params.id, "slot id");
    const slot = db.prepare("SELECT * FROM exam_slots WHERE id=?").get(slotId);
    if (!slot) return res.status(404).json({ error: "Slot not found" });
    const bookings = db
      .prepare("SELECT seat_index, seat_pos, student_class, student_name FROM exam_bookings WHERE slot_id=?")
      .all(slotId);
    res.json({ slot, seat_count: slot.max_seats, max_per_seat: 4, bookings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/admin/db/download", requireAdmin, (req, res) => {
  res.download(DB_PATH, "class_manager.db");
});

// ---------- Student APIs ----------
app.get("/api/student/profile", requireStudent, (req, res) => {
  const student = db.prepare("SELECT * FROM students WHERE id=?").get(req.session.studentId);
  if (!student) return res.status(404).json({ error: "Student not found" });
  res.json({ id: student.id, name: student.name, grade: student.grade });
});

function getSlots() {
  return db.prepare("SELECT * FROM exam_slots ORDER BY id").all();
}

function getLayout(slotId) {
  const slot = db.prepare("SELECT * FROM exam_slots WHERE id=?").get(slotId);
  if (!slot) {
    throw new Error("Slot not found");
  }
  const bookings = db
    .prepare(
      `SELECT seat_index, seat_pos, student_class, student_name
       FROM exam_bookings WHERE slot_id=? ORDER BY seat_index, seat_pos`
    )
    .all(slotId);
  return { slot, seat_count: slot.max_seats, max_per_seat: 4, bookings };
}

app.get("/api/exam/slots", requireStudent, (req, res) => {
  res.json(getSlots());
});

app.get("/api/exam/slots/:id/layout", requireStudent, (req, res) => {
  try {
    const slotId = toId(req.params.id, "slot id");
    res.json(getLayout(slotId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/exam/booking", requireStudent, (req, res) => {
  const booking = db
    .prepare(
      `SELECT b.slot_id, b.seat_index, b.seat_pos, s.label
       FROM exam_bookings b
       JOIN exam_slots s ON s.id = b.slot_id
       WHERE b.student_id = ?`
    )
    .get(req.session.studentId);
  res.json(booking || null);
});

app.post("/api/exam/book", requireStudent, (req, res) => {
  try {
    const slotId = toId(req.body.slot_id, "slot id");
    const seatIndex = toId(req.body.seat_index, "seat index");
    const seatPos = toId(req.body.seat_pos, "seat position");
    if (seatPos < 1 || seatPos > 4) throw new Error("Seat position must be 1..4");

    const slot = db.prepare("SELECT * FROM exam_slots WHERE id=?").get(slotId);
    if (!slot) throw new Error("Slot not found");
    if (seatIndex < 1 || seatIndex > slot.max_seats) throw new Error("Seat index out of range");

    const student = db.prepare("SELECT * FROM students WHERE id=?").get(req.session.studentId);
    if (!student) throw new Error("Student not found");
    if (student.grade !== "Grade 7" && student.grade !== "Grade 8") {
      throw new Error("Only Grade 7 & 8 students can book");
    }

    const tx = db.transaction(() => {
      db.prepare("DELETE FROM exam_bookings WHERE student_id=?").run(student.id);
      db.prepare(
        `INSERT INTO exam_bookings(slot_id, seat_index, seat_pos, student_id, student_name, student_class)
         VALUES (?,?,?,?,?,?)`
      ).run(slotId, seatIndex, seatPos, student.id, student.name, student.grade);
    });

    tx();
    res.status(201).json({ ok: true });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(400).json({ error: "Seat already booked" });
    }
    res.status(400).json({ error: err.message });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 Class Management System running on port ${PORT}`);
  console.log(`🗄  SQLite database at ${DB_PATH}`);
});
