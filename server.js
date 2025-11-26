const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const bcrypt = require("bcrypt");
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const PORT = Number(process.env.PORT || 5050);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "class_manager.db");
const SESSION_SECRET = process.env.SESSION_SECRET || "class-manager-secret";
const VIEW_DIR = path.join(__dirname, "views");
const ALLOWED_GRADES = ["Grade 6", "Grade 7", "Grade 8", "O/L"];
const SEAT_CAPACITY_PER_BENCH = 4;

const app = express();
const db = initDb();
const statements = prepareStatements(db);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 6, // 6 hours
    },
  })
);
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1d" }));

// Prevent caching of HTML views
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ---------- Helper functions ----------
function initDb() {
  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      monthly_fee INTEGER NOT NULL DEFAULT 2000,
      created_at TEXT DEFAULT (datetime('now'))
    );

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
      role TEXT NOT NULL CHECK(role IN ('admin','student')),
      student_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS enrollments (
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      enrolled_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(student_id, class_id),
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      amount INTEGER NOT NULL,
      method TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(student_id, class_id, month),
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(student_id, class_id, date),
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE,
      FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS exam_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      max_seats INTEGER NOT NULL CHECK(max_seats > 0)
    );

    CREATE TABLE IF NOT EXISTS exam_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL,
      seat_index INTEGER NOT NULL,
      seat_pos INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      student_name TEXT NOT NULL,
      student_class TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(slot_id, seat_index, seat_pos),
      UNIQUE(slot_id, student_id),
      FOREIGN KEY(slot_id) REFERENCES exam_slots(id) ON DELETE CASCADE,
      FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_payments_month ON payments(month);
    CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
    CREATE INDEX IF NOT EXISTS idx_exam_slot ON exam_bookings(slot_id);
  `);

  seedClasses(database);
  seedExamSlots(database);
  seedAdminUser(database);
  return database;
}

function prepareStatements(database) {
  return {
    students: {
      list: database.prepare("SELECT * FROM students ORDER BY created_at DESC"),
      find: database.prepare("SELECT * FROM students WHERE id = ?"),
      findByPhone: database.prepare("SELECT * FROM students WHERE phone = ?"),
      findByToken: database.prepare("SELECT * FROM students WHERE qr_token = ?"),
      insert: database.prepare(
        "INSERT INTO students(name, phone, grade, qr_token, created_at) VALUES (?,?,?,?, datetime('now'))"
      ),
      update: database.prepare(
        "UPDATE students SET name = ?, phone = ?, grade = ? WHERE id = ?"
      ),
      delete: database.prepare("DELETE FROM students WHERE id = ?"),
    },
    users: {
      findByUsername: database.prepare(
        "SELECT * FROM users WHERE username = ?"
      ),
      insert: database.prepare(
        "INSERT INTO users(username, password_hash, role, student_id) VALUES (?,?,?,?)"
      ),
      updateStudentUsername: database.prepare(
        "UPDATE users SET username = ? WHERE student_id = ?"
      ),
      deleteByStudent: database.prepare(
        "DELETE FROM users WHERE student_id = ?"
      ),
    },
    classes: {
      list: database.prepare("SELECT * FROM classes ORDER BY name COLLATE NOCASE"),
      find: database.prepare("SELECT * FROM classes WHERE id = ?"),
      findByName: database.prepare("SELECT * FROM classes WHERE name = ?"),
      insert: database.prepare(
        "INSERT INTO classes(name, monthly_fee, created_at) VALUES (?,?, datetime('now'))"
      ),
      updateFee: database.prepare(
        "UPDATE classes SET monthly_fee = ? WHERE id = ?"
      ),
    },
    enrollments: {
      insert: database.prepare(
        "INSERT INTO enrollments(student_id, class_id) VALUES (?,?)"
      ),
      listByClass: database.prepare(`
        SELECT s.*
        FROM enrollments e
        JOIN students s ON s.id = e.student_id
        WHERE e.class_id = ?
        ORDER BY s.name COLLATE NOCASE
      `),
    },
    payments: {
      upsert: database.prepare(`
        INSERT INTO payments(student_id, class_id, month, amount, method)
        VALUES (?,?,?,?,?)
        ON CONFLICT(student_id, class_id, month)
        DO UPDATE SET amount = excluded.amount, method = excluded.method, created_at = datetime('now')
      `),
      unpaid: database.prepare(`
        SELECT c.id AS class_id, c.name AS class_name, s.id AS student_id, s.name AS student_name, s.phone
        FROM enrollments e
        JOIN students s ON s.id = e.student_id
        JOIN classes c ON c.id = e.class_id
        LEFT JOIN payments p
               ON p.student_id = e.student_id
              AND p.class_id = e.class_id
              AND p.month = ?
        WHERE p.id IS NULL
        ORDER BY c.name COLLATE NOCASE, s.name COLLATE NOCASE
      `),
      finance: database.prepare(`
        SELECT c.id AS class_id,
               c.name AS class_name,
               COUNT(p.id) AS payments_count,
               COALESCE(SUM(p.amount),0) AS total_amount
        FROM classes c
        LEFT JOIN payments p ON p.class_id = c.id AND p.month = ?
        GROUP BY c.id
        ORDER BY c.name COLLATE NOCASE
      `),
      totalForMonth: database.prepare(
        "SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE month = ?"
      ),
    },
    attendance: {
      mark: database.prepare(`
        INSERT INTO attendance(student_id, class_id, date)
        VALUES (?,?,?)
        ON CONFLICT(student_id, class_id, date) DO NOTHING
      `),
      unmark: database.prepare(
        "DELETE FROM attendance WHERE student_id = ? AND class_id = ? AND date = ?"
      ),
      byClassAndDate: database.prepare(
        "SELECT student_id FROM attendance WHERE class_id = ? AND date = ?"
      ),
      findOne: database.prepare(
        "SELECT id FROM attendance WHERE student_id = ? AND class_id = ? AND date = ?"
      ),
      todayCount: database.prepare(
        "SELECT COUNT(*) AS c FROM attendance WHERE date = ?"
      ),
    },
    exam: {
      listSlots: database.prepare("SELECT * FROM exam_slots ORDER BY id"),
      findSlot: database.prepare("SELECT * FROM exam_slots WHERE id = ?"),
      layout: database.prepare(
        "SELECT seat_index, seat_pos, student_id, student_name, student_class FROM exam_bookings WHERE slot_id = ? ORDER BY seat_index, seat_pos"
      ),
      clearByStudent: database.prepare(
        "DELETE FROM exam_bookings WHERE student_id = ?"
      ),
      insertBooking: database.prepare(`
        INSERT INTO exam_bookings(slot_id, seat_index, seat_pos, student_id, student_name, student_class)
        VALUES (?,?,?,?,?,?)
      `),
      findByStudent: database.prepare(
        "SELECT b.*, s.label FROM exam_bookings b JOIN exam_slots s ON s.id = b.slot_id WHERE b.student_id = ?"
      ),
    },
    dashboard: {
      studentCount: database.prepare("SELECT COUNT(*) AS c FROM students"),
      classCount: database.prepare("SELECT COUNT(*) AS c FROM classes"),
      unpaidCount: database.prepare(`
        SELECT COUNT(*) AS c
        FROM enrollments e
        LEFT JOIN payments p
               ON p.student_id = e.student_id
              AND p.class_id = e.class_id
              AND p.month = ?
        WHERE p.id IS NULL
      `),
    },
  };
}

function seedClasses(database) {
  const existing = database
    .prepare("SELECT name FROM classes")
    .all()
    .map((row) => row.name);
  ["Grade 6", "Grade 7", "Grade 8", "O/L"].forEach((name) => {
    if (!existing.includes(name)) {
      database
        .prepare("INSERT INTO classes(name, monthly_fee) VALUES (?, 2000)")
        .run(name);
    }
  });
}

function seedExamSlots(database) {
  const count = database.prepare("SELECT COUNT(*) AS c FROM exam_slots").get().c;
  if (count > 0) return;
  const inserts = database.prepare(
    "INSERT INTO exam_slots(label, start_time, end_time, max_seats) VALUES (?,?,?,?)"
  );
  inserts.run(
    "Session 1 – 2:00 PM to 5:00 PM",
    "2025-12-05T14:00:00.000Z",
    "2025-12-05T17:00:00.000Z",
    25
  );
  inserts.run(
    "Session 2 – 5:30 PM to 8:30 PM",
    "2025-12-05T17:30:00.000Z",
    "2025-12-05T20:30:00.000Z",
    24
  );
}

function seedAdminUser(database) {
  const existing = database
    .prepare("SELECT id FROM users WHERE username = 'admin'")
    .get();
  if (existing) return;
  const hash = bcrypt.hashSync("admin123", 10);
  database
    .prepare("INSERT INTO users(username, password_hash, role) VALUES (?,?,?)")
    .run("admin", hash, "admin");
}

function requireRole(...roles) {
  return (req, res, next) => {
    const user = req.session.user;
    if (!user) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (roles.length && !roles.includes(user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

const requireAnyUser = requireRole("admin", "student");
const requireAdmin = requireRole("admin");
const requireStudent = requireRole("student");

function guardPage(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.redirect("/");
    }
    next();
  };
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function ensureGrade(grade) {
  if (!ALLOWED_GRADES.includes(grade)) {
    throw new Error("Invalid grade");
  }
}

function generateQrToken() {
  return crypto.randomBytes(12).toString("hex");
}

function getClassForGrade(grade) {
  const row = statements.classes.findByName.get(grade);
  if (!row) {
    throw new Error(`Class for ${grade} not found`);
  }
  return row;
}

function getStudentFromSession(req) {
  const user = req.session.user;
  if (!user || !user.studentId) return null;
  return statements.students.find.get(user.studentId);
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value === "1";
  }
  return false;
}

// ---------- Auth & pages ----------
app.get("/", (req, res) => {
  if (req.session.user) {
    if (req.session.user.role === "admin") return res.redirect("/admin");
    if (req.session.user.role === "student") return res.redirect("/student");
  }
  res.sendFile(path.join(VIEW_DIR, "login.html"));
});

app.get("/admin", guardPage("admin"), (req, res) => {
  res.sendFile(path.join(VIEW_DIR, "admin.html"));
});

app.get("/student", guardPage("student"), (req, res) => {
  res.sendFile(path.join(VIEW_DIR, "student.html"));
});

app.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "").trim();
    const role = String(req.body.role || "").trim();
    if (!username || !password) {
      throw new Error("Username and password required");
    }
    const user = statements.users.findByUsername.get(username);
    if (!user || (role && user.role !== role)) {
      throw new Error("Invalid credentials");
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      throw new Error("Invalid credentials");
    }
    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      studentId: user.student_id || null,
    };
    res.json({
      role: user.role,
      redirect: user.role === "admin" ? "/admin" : "/student",
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Login failed" });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});

app.get("/api/session", requireAnyUser, (req, res) => {
  const user = req.session.user;
  const payload = { role: user.role, username: user.username };
  if (user.role === "student") {
    const student = getStudentFromSession(req);
    payload.student = student;
  }
  res.json(payload);
});

// ---------- Students API ----------
app.get("/api/students", requireAdmin, (req, res) => {
  res.json(statements.students.list.all());
});

app.post("/api/students", requireAdmin, (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const phone = String(req.body.phone || "").trim();
    const grade = String(req.body.grade || "").trim();
    if (!name || !phone) throw new Error("Name and phone are required");
    ensureGrade(grade);

    const uniqueToken = (() => {
      let token;
      do {
        token = generateQrToken();
      } while (statements.students.findByToken.get(token));
      return token;
    })();

    const tx = db.transaction(() => {
      const info = statements.students.insert.run(
        name,
        phone,
        grade,
        uniqueToken
      );
      const studentId = info.lastInsertRowid;
      const hash = bcrypt.hashSync("1234", 10);
      statements.users.insert.run(phone, hash, "student", studentId);
      return statements.students.find.get(studentId);
    });

    const student = tx();
    res.status(201).json(student);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/students/:id", requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new Error("Invalid student id");
    const existing = statements.students.find.get(id);
    if (!existing) throw new Error("Student not found");
    const name = String(req.body.name || existing.name).trim();
    const phone = String(req.body.phone || existing.phone).trim();
    const grade = String(req.body.grade || existing.grade).trim();
    if (!name || !phone) throw new Error("Name and phone are required");
    ensureGrade(grade);

    const tx = db.transaction(() => {
      statements.students.update.run(name, phone, grade, id);
      statements.users.updateStudentUsername.run(phone, id);
      return statements.students.find.get(id);
    });

    const updated = tx();
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/students/:id", requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new Error("Invalid student id");
    statements.students.delete.run(id);
    statements.users.deleteByStudent.run(id);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/students/:id/qr", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const student = statements.students.find.get(id);
    if (!student) return res.status(404).json({ error: "Student not found" });
    const buffer = await QRCode.toBuffer(student.qr_token, { scale: 6 });
    res.setHeader("Content-Type", "image/png");
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: "Unable to generate QR" });
  }
});

// ---------- Classes API ----------
app.get("/api/classes", requireAdmin, (req, res) => {
  res.json(statements.classes.list.all());
});

app.post("/api/classes", requireAdmin, (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const fee = Number(req.body.monthly_fee);
    if (!name) throw new Error("Class name required");
    if (!Number.isFinite(fee) || fee < 0) throw new Error("Invalid fee");
    const info = statements.classes.insert.run(name, fee);
    const cls = statements.classes.find.get(info.lastInsertRowid);
    res.status(201).json(cls);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/classes/:id", requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new Error("Invalid class id");
    const fee = Number(req.body.monthly_fee);
    if (!Number.isFinite(fee) || fee < 0) throw new Error("Invalid fee");
    statements.classes.updateFee.run(fee, id);
    res.json(statements.classes.find.get(id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Enrollments ----------
app.post("/api/enrollments", requireAdmin, (req, res) => {
  try {
    const studentId = Number(req.body.student_id);
    const classId = Number(req.body.class_id);
    if (!Number.isInteger(studentId) || !Number.isInteger(classId)) {
      throw new Error("Invalid enrollment data");
    }
    statements.enrollments.insert.run(studentId, classId);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/classes/:id/students", requireAdmin, (req, res) => {
  try {
    const classId = Number(req.params.id);
    if (!Number.isInteger(classId)) throw new Error("Invalid class id");
    const rows = statements.enrollments.listByClass.all(classId);
    res.json(rows);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Payments ----------
app.post("/api/payments", requireAdmin, (req, res) => {
  try {
    const studentId = Number(req.body.student_id);
    const classId = Number(req.body.class_id);
    const month = String(req.body.month || monthKey());
    const amount = Number(req.body.amount);
    const method = String(req.body.method || "cash").trim();
    if (!Number.isInteger(studentId) || !Number.isInteger(classId)) {
      throw new Error("Invalid student or class");
    }
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Invalid month");
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid amount");
    statements.payments.upsert.run(studentId, classId, month, amount, method);
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Attendance ----------
app.get("/api/attendance", requireAdmin, (req, res) => {
  try {
    const classId = Number(req.query.class_id);
    const date = String(req.query.date || todayDate());
    if (!Number.isInteger(classId)) throw new Error("Invalid class id");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date");
    const studentsInClass = statements.enrollments.listByClass.all(classId);
    const attended = statements.attendance.byClassAndDate
      .all(classId, date)
      .map((r) => r.student_id);
    const set = new Set(attended);
    const data = studentsInClass.map((s) => ({
      ...s,
      present: set.has(s.id),
    }));
    res.json({ date, class_id: classId, students: data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/attendance/manual", requireAdmin, (req, res) => {
  try {
    const studentId = Number(req.body.student_id);
    const classId = Number(req.body.class_id);
    const date = String(req.body.date || todayDate());
    const present = toBoolean(req.body.present);
    if (!Number.isInteger(studentId) || !Number.isInteger(classId)) {
      throw new Error("Invalid ids");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date format");
    if (present) {
      statements.attendance.mark.run(studentId, classId, date);
    } else {
      statements.attendance.unmark.run(studentId, classId, date);
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
    const student = statements.students.findByToken.get(token);
    if (!student) throw new Error("Student not found for token");
    const cls = getClassForGrade(student.grade);
    const today = todayDate();
    const month = monthKey();
    const attendanceBefore = Boolean(
      statements.attendance.findOne.get(student.id, cls.id, today)
    );
    if (!attendanceBefore) {
      statements.attendance.mark.run(student.id, cls.id, today);
    }
    const payment = db
      .prepare(
        "SELECT id FROM payments WHERE student_id = ? AND class_id = ? AND month = ?"
      )
      .get(student.id, cls.id, month);
    res.json({
      student: {
        id: student.id,
        name: student.name,
        grade: student.grade,
      },
      class: cls,
      attendanceMarked: !attendanceBefore,
      paymentStatus: payment ? "paid" : "unpaid",
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Finance ----------
app.get("/api/unpaid", requireAdmin, (req, res) => {
  try {
    const month = String(req.query.month || monthKey());
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Invalid month format");
    const rows = statements.payments.unpaid.all(month);
    res.json({ month, rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/finance", requireAdmin, (req, res) => {
  try {
    const month = String(req.query.month || monthKey());
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Invalid month format");
    const rows = statements.payments.finance.all(month);
    const total = rows.reduce((sum, row) => sum + (row.total_amount || 0), 0);
    res.json({ month, rows, total });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/dashboard", requireAdmin, (req, res) => {
  try {
    const month = monthKey();
    const studentCount = statements.dashboard.studentCount.get().c;
    const classCount = statements.dashboard.classCount.get().c;
    const unpaidCount = statements.dashboard.unpaidCount.get(month).c;
    const revenue = statements.payments.totalForMonth.get(month).total;
    const attendanceToday = statements.attendance.todayCount.get(todayDate()).c;
    res.json({
      studentCount,
      classCount,
      unpaidCount,
      revenue,
      month,
      attendanceToday,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load dashboard" });
  }
});

// ---------- Exam booking (shared / student) ----------
app.get("/api/exam/slots", requireAnyUser, (req, res) => {
  res.json(statements.exam.listSlots.all());
});

app.get("/api/exam/slots/:id/layout", requireAnyUser, (req, res) => {
  try {
    const slotId = Number(req.params.id);
    if (!Number.isInteger(slotId)) throw new Error("Invalid slot");
    const slot = statements.exam.findSlot.get(slotId);
    if (!slot) return res.status(404).json({ error: "Slot not found" });
    const bookings = statements.exam.layout.all(slotId);
    res.json({
      slot,
      seat_count: slot.max_seats,
      max_per_seat: SEAT_CAPACITY_PER_BENCH,
      bookings,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/exam/my-booking", requireStudent, (req, res) => {
  const student = getStudentFromSession(req);
  if (!student) return res.json(null);
  const booking = statements.exam.findByStudent.get(student.id);
  res.json(booking || null);
});

app.delete("/api/exam/my-booking", requireStudent, (req, res) => {
  const student = getStudentFromSession(req);
  if (!student) return res.status(404).json({ error: "Student not found" });
  statements.exam.clearByStudent.run(student.id);
  res.json({ ok: true });
});

app.post("/api/exam/book", requireStudent, (req, res) => {
  try {
    const student = getStudentFromSession(req);
    if (!student) throw new Error("Student not found");
    if (!["Grade 7", "Grade 8"].includes(student.grade)) {
      throw new Error("Only Grade 7 and Grade 8 can book");
    }
    const slotId = Number(req.body.slot_id);
    const seatIndex = Number(req.body.seat_index);
    const seatPos = Number(req.body.seat_pos);
    if (!Number.isInteger(slotId)) throw new Error("Invalid slot");
    const slot = statements.exam.findSlot.get(slotId);
    if (!slot) throw new Error("Slot not found");
    if (!Number.isInteger(seatIndex) || seatIndex < 1 || seatIndex > slot.max_seats) {
      throw new Error("Invalid seat index");
    }
    if (!Number.isInteger(seatPos) || seatPos < 1 || seatPos > SEAT_CAPACITY_PER_BENCH) {
      throw new Error("Invalid seat position");
    }
    const tx = db.transaction(() => {
      statements.exam.clearByStudent.run(student.id);
      statements.exam.insertBooking.run(
        slotId,
        seatIndex,
        seatPos,
        student.id,
        student.name,
        student.grade
      );
    });
    tx();
    res.status(201).json({ ok: true });
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE")) {
      return res
        .status(400)
        .json({ error: "Seat already booked. Pick another seat." });
    }
    res.status(400).json({ error: err.message });
  }
});

// ---------- Settings / downloads ----------
app.get("/admin/download-db", requireAdmin, (req, res) => {
  res.download(DB_PATH, "class_manager.db");
});

// ---------- Student utilities ----------
app.get("/api/classes/public", requireStudent, (req, res) => {
  res.json(statements.classes.list.all());
});

// ---------- Error handling ----------
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error("Unexpected error", err);
  res.status(500).json({ error: "Internal server error" });
});

// ---------- Boot ----------
app.listen(PORT, () => {
  console.log(`🚀 Class Management System running on port ${PORT}`);
  console.log("🗄  SQLite DB:", DB_PATH);
});
